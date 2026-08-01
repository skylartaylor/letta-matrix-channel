import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCryptoRuntime } from "./crypto/runtime.mjs";

const CHANNEL_ID = "matrix";
const MAX_DEDUPED_EVENT_IDS = 2_000;
const MAX_TRACKED_THREAD_TIPS = 500;
const WHOAMI_RETRY_DELAYS_MS = [500, 1500];
const WHOAMI_TIMEOUT_MS = 10_000;
const TYPING_TIMEOUT_MS = 30_000;
const TYPING_REFRESH_MS = 10_000;
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const CHANNEL_DIR = dirname(fileURLToPath(import.meta.url));
const STARTUP_CLEANUP_COMPLETE = Symbol("matrix-startup-cleanup-complete");
// Mirrors Letta Code 0.29.x channel slash commands; unknown "/words" stay agent text.
const COMMAND_WORDS = new Set([
  "help", "status", "whoami", "cancel", "chat", "detach", "model", "new",
  "pause", "resume", "reflection", "reflect", "reload", "feedback",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(nonEmpty).filter(Boolean))]
    : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSdk() {
  // Custom-channel packages are installed under runtime/, not this project.
  const require = createRequire(new URL("./runtime/package.json", import.meta.url));
  return require("matrix-js-sdk");
}

function stateAccountComponent(accountId) {
  const value = String(accountId ?? "");
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..") {
    return value;
  }
  return `~${Buffer.from(value).toString("base64url") || "empty"}`;
}

function cryptoStateDirectory(accountId, configuredStateDir) {
  return configuredStateDir
    ? resolve(CHANNEL_DIR, configuredStateDir)
    : resolve(CHANNEL_DIR, "state", stateAccountComponent(accountId));
}

function parseSettings(account) {
  const config = account?.config ?? {};
  const homeserverUrl = nonEmpty(config.homeserverUrl);
  let parsedUrl = null;
  try {
    parsedUrl = new URL(homeserverUrl ?? "");
  } catch {
    parsedUrl = null;
  }
  if (parsedUrl?.protocol !== "https:" || !parsedUrl.host) {
    throw new Error("Matrix config requires an HTTPS homeserverUrl");
  }
  if (nonEmpty(config.accessToken)) {
    throw new Error(
      "Matrix config renamed: move config.accessToken to config.bot_token (Letta Code only keyring-protects and redacts the bot_token/auth keys)",
    );
  }
  const accessToken = nonEmpty(config.bot_token);
  if (!accessToken) throw new Error("Matrix config requires a bot_token");
  const allowedRooms = stringList(config.allowedRooms);
  const allowedUsers = stringList(config.allowedUsers);
  if (!allowedRooms.length) throw new Error("Matrix config requires at least one allowed room ID");
  if (!allowedUsers.length) throw new Error("Matrix config requires at least one allowed user ID");
  return {
    homeserverUrl,
    accessToken,
    allowedRooms: new Set(allowedRooms),
    allowedUsers: new Set(allowedUsers),
    requireMention: config.requireMention !== false,
    mentionAliases: stringList(config.mentionAliases),
    readReceipts: config.readReceipts !== false,
    typingIndicators: config.typingIndicators !== false,
    ackReaction: config.ackReaction === true,
    whoamiTimeoutMs: typeof config.whoamiTimeoutMs === "number" && config.whoamiTimeoutMs > 0
      ? config.whoamiTimeoutMs
      : WHOAMI_TIMEOUT_MS,
    whoamiRetryDelaysMs: Array.isArray(config.whoamiRetryDelaysMs)
      ? config.whoamiRetryDelaysMs.filter((ms) => typeof ms === "number" && ms >= 0)
      : WHOAMI_RETRY_DELAYS_MS,
    encryptionEnabled: config.encryption?.enabled === true,
    encryptionStateDir: typeof config.encryption?.stateDir === "string" ? config.encryption.stateDir.trim() : null,
  };
}

function get(event, method, fallback) {
  return typeof event?.[method] === "function" ? event[method]() : event?.[fallback];
}

function escapeRegExp(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Aliases must not run straight into a homeserver name ("@matrix:evil.net"),
// while sentence punctuation around the alias ("matrix:", "(matrix)") still counts.
function mentionPattern(selfUserId, aliases) {
  const branches = [];
  if (selfUserId) branches.push(escapeRegExp(selfUserId));
  if (aliases.length) branches.push(`@?(?:${aliases.map(escapeRegExp).join("|")})(?!:\\S)`);
  if (!branches.length) return null;
  return `(?:^|[\\s,:;("'\\[-])(?:${branches.join("|")})(?=$|[\\s,;!?)"'\\]]|[.:](?=\\s|$))`;
}

function bodyIsMentioned(body, content, selfUserId, aliases) {
  const mentioned = content?.["m.mentions"]?.user_ids;
  if (Array.isArray(mentioned) && selfUserId && mentioned.includes(selfUserId)) return true;
  const pattern = mentionPattern(selfUserId, aliases);
  return pattern !== null && new RegExp(pattern, "i").test(body);
}

function stripLeadingMention(body, selfUserId, aliases) {
  const branches = [];
  if (selfUserId) branches.push(escapeRegExp(selfUserId));
  if (aliases.length) branches.push(`@?(?:${aliases.map(escapeRegExp).join("|")})`);
  if (!branches.length) return body;
  return body.replace(new RegExp(`^(?:${branches.join("|")})[,:;!?]?\\s+`, "i"), "");
}

// Rich-reply fallback quotes ("> <@user> ...") precede the real message text.
function stripReplyFallback(body) {
  if (!body.startsWith("> ")) return body;
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) index += 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  return lines.slice(index).join("\n");
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);
}

function toMatrixHtml(text) {
  // NULs collide with the stash sentinel (and are invalid in HTML anyway).
  const source = text.replace(/\u0000/g, "");
  const codeSegments = [];
  let fired = false;
  const stash = (html) => {
    fired = true;
    return `\u0000${codeSegments.push(html) - 1}\u0000`;
  };
  const mark = (html) => {
    fired = true;
    return html;
  };
  const withPlaceholders = source
    .replace(/```(?:[^\n`]*\n)?([\s\S]*?)```/g, (_match, code) =>
      stash(`<pre><code>${escapeHtml(code.replace(/\n+$/, ""))}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));
  // A stray or unterminated fence means we would style text the author meant as code.
  if (withPlaceholders.includes("```")) return null;
  const html = escapeHtml(withPlaceholders)
    .replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, (_match, inner) => mark(`<strong>${inner}</strong>`))
    .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, (_match, inner) => mark(`<em>${inner}</em>`))
    .replace(/~~([^\s~](?:[^~\n]*[^\s~])?)~~/g, (_match, inner) => mark(`<del>${inner}</del>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, (_match, label, url) =>
      mark(`<a href="${url}">${label}</a>`))
    .replace(/\n/g, "<br/>");
  // Newlines alone render fine in a plain body; only markup earns a formatted_body.
  if (!fired) return null;
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSegments[Number(index)]);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isAuthRejection(error) {
  return error?.errcode === "M_UNKNOWN_TOKEN" || error?.httpStatus === 401 || error?.httpStatus === 403;
}

async function whoamiWithRetry(client, settings) {
  const delays = settings.whoamiRetryDelaysMs;
  let lastError;
  for (let attempt = 0; attempt < delays.length + 1; attempt += 1) {
    try {
      return await withTimeout(client.whoami(), settings.whoamiTimeoutMs, "Matrix whoami");
    } catch (error) {
      // A rejected token will not heal on retry.
      if (isAuthRejection(error)) throw error;
      lastError = error;
      const delay = delays[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  throw lastError;
}

class MatrixChannelAdapter {
  constructor(account) {
    this.account = account;
    this.settings = parseSettings(account);
    this.sdk = loadSdk();
    this.client = this.createClient();
    this.id = `${CHANNEL_ID}:${account.accountId}`;
    this.channelId = CHANNEL_ID;
    this.accountId = account.accountId;
    this.name = account.displayName ?? "Matrix";
    this.onMessage = undefined;
    this.running = false;
    this.desiredRunning = false;
    this.lifecyclePromise = null;
    this.epoch = 0;
    this.initialSyncComplete = false;
    this.outboundRoomStateFresh = false;
    this.selfUserId = null;
    this.seenEventIds = new Set();
    this.threadTips = new Map();
    this.lastTypingSentAt = new Map();
    this.warnedEncryptedRooms = new Set();
    this.cryptoRuntime = null;
    this.pendingRuntimeStop = null;
    this.runtimeCleanupError = null;
    this.encryptedClientConsumed = false;
    this.lifecycleCleanupError = null;
    this.acceptedEpoch = null;
    this.syncListener = null;
    this.timelineListener = null;
  }

  createClient() {
    return this.sdk.createClient({
      baseUrl: this.settings.homeserverUrl,
      accessToken: this.settings.accessToken,
    });
  }

  start() {
    if (this.pendingRuntimeStop) {
      return Promise.reject(new Error(
        "Matrix encrypted adapter cleanup is still pending; call stop() again before restart",
        { cause: this.runtimeCleanupError },
      ));
    }
    if (this.lifecycleCleanupError) {
      return Promise.reject(new Error(
        this.settings.encryptionEnabled
          ? "Matrix encrypted adapter cannot restart after failed lifecycle cleanup; recreate the adapter"
          : "Matrix adapter cannot restart after failed lifecycle cleanup; recreate the adapter",
        { cause: this.lifecycleCleanupError },
      ));
    }
    this.desiredRunning = true;
    if (this.running && !this.lifecyclePromise) return Promise.resolve();
    return this.reconcileLifecycle();
  }

  stop() {
    this.desiredRunning = false;
    this.epoch += 1;
    this.acceptedEpoch = null;
    this.initialSyncComplete = false;
    this.outboundRoomStateFresh = false;
    if (
      !this.lifecyclePromise
      && !this.running
      && !this.cryptoRuntime
      && !this.pendingRuntimeStop
    ) {
      return Promise.resolve();
    }
    return this.reconcileLifecycle().catch((error) => {
      if (
        !this.desiredRunning
        && !this.running
        && !this.cryptoRuntime
        && !this.pendingRuntimeStop
        && !this.lifecycleCleanupError
      ) {
        return;
      }
      throw error;
    });
  }

  reconcileLifecycle() {
    if (this.lifecyclePromise) return this.lifecyclePromise;
    const operation = (async () => {
      while (true) {
        if (this.desiredRunning) {
          if (!this.running) await this.performStart();
        } else if (this.running || this.cryptoRuntime || this.pendingRuntimeStop) {
          await this.performStop();
        }

        const settled = this.desiredRunning
          ? this.running
          : !this.running && !this.cryptoRuntime && !this.pendingRuntimeStop;
        if (settled) return;
      }
    })();
    this.lifecyclePromise = operation;
    void operation.then(
      () => {
        if (this.lifecyclePromise === operation) this.lifecyclePromise = null;
      },
      () => {
        if (this.lifecyclePromise === operation) this.lifecyclePromise = null;
      },
    );
    return operation;
  }

  async performStart() {
    if (this.settings.encryptionEnabled && this.encryptedClientConsumed) {
      this.client = this.createClient();
      this.encryptedClientConsumed = false;
    }
    const client = this.client;
    const epoch = ++this.epoch;
    let runtime = null;
    let syncListener = null;
    let timelineListener = null;
    let syncListenerAttached = false;
    let timelineListenerAttached = false;
    let clientMustStop = false;
    let cryptoAttempted = false;
    try {
      const identity = await whoamiWithRetry(client, this.settings);
      const selfUserId = nonEmpty(identity?.user_id);
      if (!selfUserId) throw new Error("Matrix whoami returned no user_id; check the configured bot_token");
      // stop() during the whoami round-trip abandons this start.
      if (epoch !== this.epoch) return;
      this.selfUserId = selfUserId;
      // createClient() without userId never resolves one; SDK internals (sync filter
      // name, Room.myUserId) read credentials.userId and must be set before startClient.
      (client.credentials ??= {}).userId = selfUserId;
      if (this.settings.encryptionEnabled) {
        const deviceId = nonEmpty(identity?.device_id);
        if (!deviceId) throw new Error("Matrix whoami returned no device_id; encrypted mode requires a stable Matrix device");
        client.deviceId = deviceId;
        (client.credentials ??= {}).deviceId = deviceId;
        if (typeof client.initRustCrypto !== "function") {
          throw new Error("Matrix Rust crypto is unavailable in this channel runtime");
        }
        cryptoAttempted = true;
        this.encryptedClientConsumed = true;
        const homeserverUrl = new URL(this.settings.homeserverUrl).href;
        runtime = await startCryptoRuntime({
          client,
          accountKey: `${homeserverUrl}\u0000${selfUserId}\u0000${this.accountId}`,
          stateDir: cryptoStateDirectory(this.accountId, this.settings.encryptionStateDir),
          identity: {
            homeserverUrl,
            userId: selfUserId,
            deviceId,
            accountId: String(this.accountId),
          },
        });
        clientMustStop = true;
        if (epoch !== this.epoch) {
          const cleanup = await this.cleanupClientStart({
            client,
            runtime,
            syncListener,
            timelineListener,
            syncListenerAttached,
            timelineListenerAttached,
            clientMustStop,
          });
          if (cleanup.errors.length) {
            throw this.lifecycleCleanupFailure(
              cleanup.errors,
              "Matrix cancelled startup cleanup failed",
              { permanent: cleanup.permanent },
            );
          }
          return;
        }
        this.cryptoRuntime = runtime;
      }
      const acceptsEvents = () => (
        this.acceptedEpoch === epoch
        && this.client === client
      );
      syncListener = (state) => {
        if (!acceptsEvents()) return;
        const normalized = String(state).toUpperCase();
        if (normalized === "PREPARED") this.initialSyncComplete = true;
        this.outboundRoomStateFresh = (
          normalized === "PREPARED"
          || normalized === "SYNCING"
        );
        if (this.cryptoRuntime && normalized === "PREPARED") {
          void this.cryptoRuntime.persist().catch((error) => {
            console.error(`[${CHANNEL_ID}] crypto persistence checkpoint failed for ${this.accountId}:`, error);
          });
        }
      };
      timelineListener = (event, room, toStartOfTimeline, removed, data) => {
        if (!acceptsEvents()) return;
        void this.handleTimelineEvent(event, room, toStartOfTimeline, removed, data).catch((error) => {
          console.error(`[${CHANNEL_ID}] inbound event failed for ${this.accountId}:`, error);
        });
      };
      this.acceptedEpoch = epoch;
      client.on("sync", syncListener);
      syncListenerAttached = true;
      client.on("Room.timeline", timelineListener);
      timelineListenerAttached = true;
      clientMustStop = true;
      await client.startClient({ initialSyncLimit: 0 });
      if (epoch !== this.epoch) {
        const cleanup = await this.cleanupClientStart({
          client,
          runtime,
          syncListener,
          timelineListener,
          syncListenerAttached,
          timelineListenerAttached,
          clientMustStop,
        });
        if (cleanup.errors.length) {
          throw this.lifecycleCleanupFailure(
            cleanup.errors,
            "Matrix cancelled startup cleanup failed",
            { permanent: cleanup.permanent },
          );
        }
        return;
      }
      this.syncListener = syncListener;
      this.timelineListener = timelineListener;
      this.running = true;
    } catch (error) {
      if (error?.[STARTUP_CLEANUP_COMPLETE]) throw error;
      const cleanup = await this.cleanupClientStart({
        client,
        runtime,
        syncListener,
        timelineListener,
        syncListenerAttached,
        timelineListenerAttached,
        clientMustStop: (
          clientMustStop
          || (cryptoAttempted && error?.matrixCryptoClientStopHandled !== true)
        ),
      });
      if (cleanup.errors.length) {
        const failure = new AggregateError(
          [error, ...cleanup.errors],
          `${error instanceof Error ? error.message : String(error)}; Matrix startup cleanup also failed`,
        );
        if (cleanup.permanent) this.lifecycleCleanupError = failure;
        throw failure;
      }
      if (error?.matrixCryptoProcessQuarantined === true) {
        this.lifecycleCleanupError = error;
      }
      throw error;
    }
  }

  lifecycleCleanupFailure(errors, message, { permanent = true } = {}) {
    const failure = new AggregateError(errors, message);
    failure[STARTUP_CLEANUP_COMPLETE] = true;
    if (permanent) this.lifecycleCleanupError = failure;
    return failure;
  }

  async cleanupClientStart({
    client,
    runtime,
    syncListener,
    timelineListener,
    syncListenerAttached,
    timelineListenerAttached,
    clientMustStop,
  }) {
    this.acceptedEpoch = null;
    const errors = [];
    let permanent = false;
    if (syncListenerAttached) {
      try {
        client.removeListener("sync", syncListener);
      } catch (error) {
        errors.push(error);
        permanent = true;
      }
    }
    if (timelineListenerAttached) {
      try {
        client.removeListener("Room.timeline", timelineListener);
      } catch (error) {
        errors.push(error);
        permanent = true;
      }
    }
    let clientStopFailed = false;
    if (clientMustStop) {
      try {
        await client.stopClient();
      } catch (error) {
        clientStopFailed = true;
        errors.push(error);
        permanent = true;
      }
    }
    try {
      if (clientStopFailed) await runtime?.quarantine();
      else await runtime?.stop();
    } catch (error) {
      errors.push(error);
      if (
        !clientStopFailed
        && runtime
        && error?.matrixCryptoRuntimeStopRetryable === true
      ) {
        this.pendingRuntimeStop = runtime;
        this.runtimeCleanupError = error;
      } else {
        permanent = true;
      }
    }
    if (this.syncListener === syncListener) this.syncListener = null;
    if (this.timelineListener === timelineListener) this.timelineListener = null;
    if (this.cryptoRuntime === runtime) this.cryptoRuntime = null;
    this.running = false;
    this.initialSyncComplete = false;
    this.outboundRoomStateFresh = false;
    return { errors, permanent };
  }

  async performStop() {
    if (this.pendingRuntimeStop) {
      const runtime = this.pendingRuntimeStop;
      try {
        await runtime.stop();
      } catch (error) {
        this.runtimeCleanupError = error;
        if (error?.matrixCryptoRuntimeStopRetryable !== true) {
          if (this.pendingRuntimeStop === runtime) this.pendingRuntimeStop = null;
          this.lifecycleCleanupError = error;
        }
        throw error;
      }
      if (this.pendingRuntimeStop === runtime) this.pendingRuntimeStop = null;
      this.runtimeCleanupError = null;
      return;
    }
    const runtime = this.cryptoRuntime;
    const syncListener = this.syncListener;
    const timelineListener = this.timelineListener;
    this.cryptoRuntime = null;
    this.syncListener = null;
    this.timelineListener = null;
    this.acceptedEpoch = null;
    this.running = false;
    this.initialSyncComplete = false;
    this.outboundRoomStateFresh = false;
    const errors = [];
    let permanent = false;
    if (syncListener) {
      try {
        this.client.removeListener("sync", syncListener);
      } catch (error) {
        errors.push(error);
        permanent = true;
      }
    }
    if (timelineListener) {
      try {
        this.client.removeListener("Room.timeline", timelineListener);
      } catch (error) {
        errors.push(error);
        permanent = true;
      }
    }
    let clientStopFailed = false;
    try {
      await this.client.stopClient();
    } catch (error) {
      clientStopFailed = true;
      errors.push(error);
      permanent = true;
    }
    try {
      if (clientStopFailed) await runtime?.quarantine();
      else await runtime?.stop();
    } catch (error) {
      errors.push(error);
      if (
        !clientStopFailed
        && runtime
        && error?.matrixCryptoRuntimeStopRetryable === true
      ) {
        this.pendingRuntimeStop = runtime;
        this.runtimeCleanupError = error;
      } else {
        permanent = true;
      }
    }
    if (errors.length) {
      const failure = errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Matrix client lifecycle cleanup failed");
      if (permanent) this.lifecycleCleanupError = failure;
      throw failure;
    }
  }

  isRunning() {
    return this.running;
  }

  remember(eventId) {
    if (!eventId || this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > MAX_DEDUPED_EVENT_IDS) {
      this.seenEventIds.delete(this.seenEventIds.values().next().value);
    }
    return true;
  }

  markRead(event) {
    if (!this.settings.readReceipts || typeof this.client.sendReadReceipt !== "function") return;
    void Promise.resolve(this.client.sendReadReceipt(event)).catch(() => {});
  }

  setTyping(chatId, typing) {
    if (!this.settings.typingIndicators || typeof this.client.sendTyping !== "function") return;
    if (!this.settings.allowedRooms.has(chatId)) return;
    const now = Date.now();
    if (typing && now - (this.lastTypingSentAt.get(chatId) ?? 0) < TYPING_REFRESH_MS) return;
    this.lastTypingSentAt.set(chatId, typing ? now : 0);
    void Promise.resolve(this.client.sendTyping(chatId, typing, TYPING_TIMEOUT_MS)).catch(() => {});
  }

  react(chatId, targetEventId, key) {
    if (!this.settings.ackReaction || !targetEventId) return;
    if (!this.settings.allowedRooms.has(chatId)) return;
    if (!this.initialSyncComplete || !this.outboundRoomStateFresh) return;
    const room = this.client.getRoom?.(chatId);
    if (!room || room.currentState?.getStateEvents?.("m.room.encryption", "")) return;
    const content = { "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key } };
    void Promise.resolve(this.client.sendEvent(chatId, "m.reaction", content)).catch(() => {});
  }

  // Turn events arrive for every adapter whose channel appears in the sources;
  // typing self-expires after TYPING_TIMEOUT_MS if the host never sends them.
  async handleTurnLifecycleEvent(event) {
    if (event.type === "queued" && event.source.channel === CHANNEL_ID) {
      this.setTyping(event.source.chatId, true);
      return;
    }
    if (event.type !== "finished") return;
    for (const source of event.sources ?? []) {
      if (source.channel !== CHANNEL_ID) continue;
      this.setTyping(source.chatId, false);
      if (event.outcome === "completed") this.react(source.chatId, source.messageId, "✅");
    }
  }

  async handleTurnProgressEvent(event) {
    const stop = event.state === "error" || event.state === "waiting";
    for (const source of event.sources ?? []) {
      if (source.channel === CHANNEL_ID) this.setTyping(source.chatId, !stop);
    }
  }

  rememberThreadTip(chatId, threadId, eventId) {
    if (!threadId || !eventId) return;
    // NUL separator: room-version 1/2 event ids may contain ":". Delete-then-set
    // keeps hot threads out of the eviction window.
    const key = `${chatId}\u0000${threadId}`;
    this.threadTips.delete(key);
    this.threadTips.set(key, eventId);
    if (this.threadTips.size > MAX_TRACKED_THREAD_TIPS) {
      this.threadTips.delete(this.threadTips.keys().next().value);
    }
  }

  async handleTimelineEvent(event, room, toStartOfTimeline, removed, data) {
    if (!this.initialSyncComplete) return;
    if (toStartOfTimeline || removed || !data?.liveEvent) return;
    const chatId = nonEmpty(room?.roomId ?? room?.room_id);
    if (!chatId || !this.settings.allowedRooms.has(chatId)) return;

    const type = get(event, "getType", "type");
    const wireType = (
      typeof event?.getWireType === "function"
        ? event.getWireType()
        : event?.event?.type ?? type
    );
    if (wireType === "m.room.encrypted" || type === "m.room.encrypted") {
      if (!this.warnedEncryptedRooms.has(chatId)) {
        this.warnedEncryptedRooms.add(chatId);
        console.warn(`[${CHANNEL_ID}] ignoring E2EE event in ${chatId}; post-decryption delivery is not implemented`);
      }
      return;
    }
    if (type !== "m.room.message") return;

    const senderId = nonEmpty(get(event, "getSender", "sender"));
    if (!senderId || senderId === this.selfUserId || !this.settings.allowedUsers.has(senderId)) return;

    const content = get(event, "getContent", "content") ?? {};
    const relation = content["m.relates_to"];
    // Edits arrive as fresh messages; the original was already delivered live.
    if (relation?.rel_type === "m.replace") return;

    let text = typeof content.body === "string" ? content.body.trim() : "";
    if (content.msgtype !== "m.text" || !text) return;
    const inReplyTo = nonEmpty(relation?.["m.in_reply_to"]?.event_id);
    if (inReplyTo) {
      const bare = stripReplyFallback(text).trim();
      if (bare) text = bare;
    }
    const isMention = bodyIsMentioned(text, content, this.selfUserId, this.settings.mentionAliases);
    if (this.settings.requireMention && !isMention) return;

    const messageId = nonEmpty(get(event, "getId", "event_id"));
    if (!this.remember(messageId)) return;
    const threadId = relation?.rel_type === "m.thread" && typeof relation.event_id === "string"
      ? relation.event_id
      : undefined;
    if (threadId) this.rememberThreadTip(chatId, threadId, messageId);
    const timestamp = get(event, "getTs", "origin_server_ts");
    const chatLabel = nonEmpty(room?.name);
    // The host's slash-command parser only fires on a leading "/", which the
    // required mention would otherwise hide; unknown "/words" stay agent text.
    const stripped = stripLeadingMention(text, this.selfUserId, this.settings.mentionAliases);
    const command = stripped.match(/^\/([a-z][a-z-]*)(?=\s|$)/i);
    const forwardCommand = Boolean(command) && COMMAND_WORDS.has(command[1].toLowerCase());

    this.markRead(event);
    this.setTyping(chatId, true);
    this.react(chatId, messageId, "👀");
    console.info(`[${CHANNEL_ID}] inbound account=${this.accountId} room=${chatId} sender=${senderId} chars=${text.length}`);
    try {
      await this.onMessage?.({
        channel: CHANNEL_ID,
        accountId: this.accountId,
        chatId,
        chatType: "channel",
        senderId,
        senderName: nonEmpty(room?.getMember?.(senderId)?.name) ?? senderId,
        text: forwardCommand ? stripped : text,
        messageId,
        isMention,
        timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
        ...(chatLabel ? { chatLabel } : {}),
        ...(threadId ? { threadId } : {}),
        ...(inReplyTo ? { replyContext: { messageId: inReplyTo } } : {}),
      });
    } catch (error) {
      // Give the event another chance if the host failed to take delivery.
      this.seenEventIds.delete(messageId);
      this.setTyping(chatId, false);
      throw error;
    }
  }

  async sendMessage(message) {
    const chatId = nonEmpty(message?.chatId);
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (!chatId || !this.settings.allowedRooms.has(chatId)) {
      throw new Error("refusing Matrix outbound message outside configured rooms");
    }
    if (!text) throw new Error("Matrix send requires message text");
    if (!this.initialSyncComplete) {
      throw new Error("refusing Matrix outbound before initial sync completes");
    }
    if (!this.outboundRoomStateFresh) {
      throw new Error("refusing Matrix outbound while room encryption state is not fresh");
    }
    const room = this.client.getRoom?.(chatId);
    if (!room) {
      throw new Error(`refusing Matrix outbound without loaded room state for ${chatId}`);
    }
    if (room?.currentState?.getStateEvents?.("m.room.encryption", "")) {
      throw new Error(`refusing to send plaintext into encrypted Matrix room ${chatId}`);
    }

    const threadId = nonEmpty(message.threadId);
    const replyToMessageId = nonEmpty(message.replyToMessageId);
    const content = { msgtype: "m.text", body: text };
    const formattedBody = toMatrixHtml(text);
    if (formattedBody) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = formattedBody;
    }
    if (threadId) {
      content["m.relates_to"] = replyToMessageId
        ? { rel_type: "m.thread", event_id: threadId, "m.in_reply_to": { event_id: replyToMessageId } }
        : {
            rel_type: "m.thread",
            event_id: threadId,
            is_falling_back: true,
            "m.in_reply_to": { event_id: this.threadTips.get(`${chatId}\u0000${threadId}`) ?? threadId },
          };
    } else if (replyToMessageId) {
      content["m.relates_to"] = { "m.in_reply_to": { event_id: replyToMessageId } };
    }
    const response = await this.client.sendEvent(chatId, "m.room.message", content);
    const eventId = nonEmpty(response?.event_id);
    if (threadId) this.rememberThreadTip(chatId, threadId, eventId);
    this.setTyping(chatId, false);
    console.info(`[${CHANNEL_ID}] outbound account=${this.accountId} room=${chatId} chars=${text.length}`);
    return { messageId: eventId ?? "unknown" };
  }

  async sendDirectReply(chatId, text, options) {
    return await this.sendMessage({
      chatId,
      text,
      threadId: options?.threadId,
      replyToMessageId: options?.replyToMessageId,
    });
  }
}

export const channelPlugin = {
  metadata: { id: CHANNEL_ID, displayName: "Matrix" },
  createAdapter(account) {
    return new MatrixChannelAdapter(account);
  },
  messageActions: {
    describeMessageTool() {
      return { actions: ["send"] };
    },
    async handleAction(ctx) {
      if (ctx.request.action !== "send") {
        return `Error: Action "${ctx.request.action}" is not supported on Matrix.`;
      }
      if (!ctx.request.message?.trim()) return "Error: Matrix send requires message.";
      const formatted = ctx.formatText(ctx.request.message);
      const result = await ctx.adapter.sendMessage({
        channel: CHANNEL_ID,
        accountId: ctx.route.accountId,
        chatId: ctx.route.chatId,
        text: formatted.text,
        threadId: ctx.request.threadId ?? ctx.route.threadId,
        replyToMessageId: ctx.request.replyToMessageId,
      });
      return `Message sent to Matrix (message_id: ${result.messageId})`;
    },
  },
};
