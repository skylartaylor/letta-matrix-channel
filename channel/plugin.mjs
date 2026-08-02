import { createRequire } from "node:module";
import { createRecoveryKeyStore } from "./crypto/recovery-key-store.mjs";
import {
  enableExistingCryptoRecovery,
  getCryptoRecoveryStatus,
  restoreCryptoRecovery,
  setupCryptoRecovery,
} from "./crypto/recovery.mjs";
import { cryptoStateDirectory } from "./crypto/paths.mjs";
import { startCryptoRuntime } from "./crypto/runtime.mjs";

const CHANNEL_ID = "matrix";
const MAX_DEDUPED_EVENT_IDS = 2_000;
const MAX_TRACKED_THREAD_TIPS = 500;
const DECRYPTED_EVENT_NAME = "Event.decrypted";
const WHOAMI_RETRY_DELAYS_MS = [500, 1500];
const WHOAMI_TIMEOUT_MS = 10_000;
const CRYPTO_CONTROL_TIMEOUT_MS = 5 * 60_000;
const CRYPTO_STOP_DRAIN_TIMEOUT_MS = 15_000;
const MATRIX_SYNC_LOOP_PROMISE = Symbol.for("letta.matrix.syncLoopPromise");
const MATRIX_SYNC_LOOP_PATCHED = Symbol.for("letta.matrix.syncLoopPatched");
const TYPING_TIMEOUT_MS = 30_000;
const TYPING_REFRESH_MS = 10_000;
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
// Numeric values are the pinned SDK's public EventShieldColour/Reason enums.
const SHIELD_COLOUR = { NONE: 0, GREY: 1, RED: 2 };
const SHIELD_REASON = {
  UNKNOWN: 0,
  UNVERIFIED_IDENTITY: 1,
  UNSIGNED_DEVICE: 2,
  AUTHENTICITY_NOT_GUARANTEED: 4,
};
const SHIELD_COLOUR_NAMES = ["none", "grey", "red"];
const SHIELD_REASON_NAMES = [
  "unknown",
  "unverified_identity",
  "unsigned_device",
  "unknown_device",
  "authenticity_not_guaranteed",
  "mismatched_sender_key",
];
const STARTUP_CLEANUP_COMPLETE = Symbol("matrix-startup-cleanup-complete");
// Mirrors Letta Code 0.29.x channel slash commands; unknown "/words" stay agent text.
const COMMAND_WORDS = new Set([
  "help", "status", "whoami", "cancel", "chat", "detach", "model", "new",
  "pause", "resume", "reflection", "reflect", "reload", "feedback",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeLogToken(value, fallback = "unknown") {
  const text = nonEmpty(String(value ?? "")) ?? fallback;
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, "_").slice(0, 160);
}

function roomIsEncrypted(room) {
  return (
    room?.hasEncryptionStateEvent?.() === true
    || Boolean(room?.currentState?.getStateEvents?.("m.room.encryption", ""))
  );
}

function cryptoWriteAheadRequest(input, init) {
  const rawUrl = typeof input === "string" || input instanceof URL
    ? String(input)
    : input?.url;
  if (!rawUrl) return false;
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  let segments;
  try {
    segments = new URL(rawUrl).pathname.split("/");
  } catch {
    return false;
  }
  return segments.some((segment, index) => (
    (
      segment === "rooms"
      && segments[index + 2] === "send"
      && segments[index + 3] === "m.room.encrypted"
    )
    || (
      segment === "sendToDevice"
      && segments[index + 1] === "m.room.encrypted"
    )
    || (
      segment === "keys"
      && segments[index + 1] === "upload"
    )
    || (
      segment === "keys"
      && (
        segments[index + 1] === "device_signing"
        || segments[index + 1] === "signatures"
      )
      && segments[index + 2] === "upload"
    )
    || segment === "room_keys"
    || segment === "account_data"
  ));
}

function incrementalSyncRequest(input) {
  const rawUrl = typeof input === "string" || input instanceof URL
    ? String(input)
    : input?.url;
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      url.pathname.endsWith("/sync")
      && nonEmpty(url.searchParams.get("since")) !== null
    );
  } catch {
    return false;
  }
}

function roomSendRequest(input) {
  const rawUrl = typeof input === "string" || input instanceof URL
    ? String(input)
    : input?.url;
  if (!rawUrl) return null;
  let segments;
  try {
    segments = new URL(rawUrl).pathname.split("/");
  } catch {
    return null;
  }
  const roomsIndex = segments.findIndex((segment, index) => (
    segment === "rooms" && segments[index + 2] === "send"
  ));
  if (roomsIndex < 0) return null;
  try {
    return {
      roomId: decodeURIComponent(segments[roomsIndex + 1] ?? ""),
      eventType: decodeURIComponent(segments[roomsIndex + 3] ?? ""),
      txnId: decodeURIComponent(segments[roomsIndex + 4] ?? ""),
    };
  } catch {
    return { roomId: "", eventType: "", txnId: "" };
  }
}

function shieldLabel(value, labels, fallback) {
  return typeof value === "number" && labels[value]
    ? labels[value]
    : safeLogToken(value, fallback);
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(nonEmpty).filter(Boolean))]
    : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function installMatrixSyncLoopTracking(SyncApi) {
  const prototype = SyncApi?.prototype;
  const originalSync = prototype?.sync;
  if (typeof originalSync !== "function") {
    throw new Error("Matrix sync-loop tracking is unavailable in the pinned SDK runtime");
  }
  if (originalSync[MATRIX_SYNC_LOOP_PATCHED] === true) return;
  const trackedSync = function (...args) {
    const loop = originalSync.apply(this, args);
    this[MATRIX_SYNC_LOOP_PROMISE] = loop;
    // Retain a settled loop so shutdown can distinguish it from an untracked
    // loop that still requires the SDK's STOPPED event.
    void Promise.resolve(loop).catch(() => {});
    return loop;
  };
  Object.defineProperty(trackedSync, MATRIX_SYNC_LOOP_PATCHED, { value: true });
  prototype.sync = trackedSync;
}

function loadSdk() {
  // Custom-channel packages are installed under runtime/, not this project.
  const require = createRequire(new URL("./runtime/package.json", import.meta.url));
  const sdk = require("matrix-js-sdk");
  installMatrixSyncLoopTracking(require("matrix-js-sdk/lib/sync.js").SyncApi);
  return sdk;
}

function loadRecoveryKeyDecoder() {
  const require = createRequire(new URL("./runtime/package.json", import.meta.url));
  return require("matrix-js-sdk/lib/crypto-api/recovery-key.js").decodeRecoveryKey;
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

function cryptoDrainFailure(error, { unsafe }) {
  const failure = new Error(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
  failure.matrixCryptoClientStopUnsafe = unsafe;
  return failure;
}

async function waitForCryptoDrainPromise(promise, {
  deadline,
  timeoutMs,
  label,
}) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`${label} timed out after ${timeoutMs}ms`);
  let timer;
  try {
    await Promise.race([
      Promise.resolve(promise).then(() => undefined, () => undefined),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCryptoDrainFlag(target, property, {
  deadline,
  timeoutMs,
  label,
}) {
  while (target[property]) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await sleep(Math.min(5, Math.max(1, deadline - Date.now())));
  }
}

export async function drainMatrixClientCryptoWork(
  client,
  {
    timeoutMs = CRYPTO_STOP_DRAIN_TIMEOUT_MS,
    settleClientOperations,
  } = {},
) {
  const syncApi = client?.syncApi;
  if (client?.clientRunning === true && !syncApi) {
    throw cryptoDrainFailure(
      new Error("Matrix sync drain is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }
  if (syncApi && (
    typeof syncApi.getSyncState !== "function"
    || typeof syncApi.stop !== "function"
    || typeof syncApi.retryImmediately !== "function"
    || typeof syncApi.running !== "boolean"
  )) {
    throw cryptoDrainFailure(
      new Error("Matrix sync drain is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }
  const crypto = client?.getCrypto?.();
  const backupManager = crypto?.backupManager;
  const backupDownloader = crypto?.perSessionBackupDownloader;
  const keyClaimManager = crypto?.keyClaimManager;
  const outgoingRequests = crypto?.outgoingRequestsManager;
  if (backupManager && (
    typeof backupManager.stopped !== "boolean"
    || typeof backupManager.backupKeysLoopRunning !== "boolean"
    || (
      backupManager.keyBackupCheckInProgress !== null
      && backupManager.keyBackupCheckInProgress !== undefined
      && typeof backupManager.keyBackupCheckInProgress?.then !== "function"
    )
    || typeof backupManager.stop !== "function"
  )) {
    throw cryptoDrainFailure(
      new Error("Matrix crypto backup drain is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }
  if (backupDownloader && (
    typeof backupDownloader.stopped !== "boolean"
    || typeof backupDownloader.downloadLoopRunning !== "boolean"
    || (
      backupDownloader.currentBackupVersionCheck !== null
      && backupDownloader.currentBackupVersionCheck !== undefined
      && typeof backupDownloader.currentBackupVersionCheck?.then !== "function"
    )
    || typeof backupDownloader.stop !== "function"
  )) {
    throw cryptoDrainFailure(
      new Error("Matrix crypto backup-download drain is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }
  if (keyClaimManager && (
    typeof keyClaimManager.stopped !== "boolean"
    || typeof keyClaimManager.currentClaimPromise?.then !== "function"
    || typeof keyClaimManager.stop !== "function"
  )) {
    throw cryptoDrainFailure(
      new Error("Matrix crypto key-claim drain is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }
  if (outgoingRequests && (
    typeof outgoingRequests.stopped !== "boolean"
    || typeof outgoingRequests.outgoingRequestLoopRunning !== "boolean"
    || typeof outgoingRequests.stop !== "function"
  )) {
    throw cryptoDrainFailure(
      new Error("Matrix crypto outgoing-request drain is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }
  const hasCryptoWorkers = Boolean(
    backupManager || backupDownloader || keyClaimManager || outgoingRequests,
  );
  if (hasCryptoWorkers && typeof client?.http?.abort !== "function") {
    throw cryptoDrainFailure(
      new Error("Matrix crypto network abort is unavailable in the pinned SDK runtime"),
      { unsafe: true },
    );
  }

  const deadline = Date.now() + timeoutMs;
  let stoppedListener;
  let stopped;
  let syncLoop;
  if (syncApi?.running === true) {
    syncLoop = syncApi[MATRIX_SYNC_LOOP_PROMISE];
    stopped = new Promise((resolveStopped) => {
      stoppedListener = (state) => {
        if (String(state).toUpperCase() === "STOPPED") resolveStopped();
      };
      client.on("sync", stoppedListener);
    });
  }
  try {
    if (settleClientOperations) {
      await waitForCryptoDrainPromise(settleClientOperations(), {
        deadline,
        timeoutMs,
        label: "Matrix encrypted room-send shutdown",
      });
    }
    if (syncApi?.running === true) {
      syncApi.stop();
      syncApi.retryImmediately();
      if (hasCryptoWorkers) client.http.abort();
      await waitForCryptoDrainPromise(syncLoop
        ? Promise.race([
            stopped,
            Promise.resolve(syncLoop).then(() => undefined, () => undefined),
          ])
        : stopped, {
        deadline,
        timeoutMs,
        label: "Matrix sync drain",
      });
    }
    backupManager?.stop();
    backupDownloader?.stop();
    keyClaimManager?.stop();
    outgoingRequests?.stop();
    if (hasCryptoWorkers) client.http.abort();
    if (backupManager) {
      while (
        backupManager.backupKeysLoopRunning
        || backupManager.keyBackupCheckInProgress
      ) {
        await waitForCryptoDrainFlag(backupManager, "backupKeysLoopRunning", {
          deadline,
          timeoutMs,
          label: "Matrix crypto backup shutdown",
        });
        const check = backupManager.keyBackupCheckInProgress;
        if (check) {
          await waitForCryptoDrainPromise(check, {
            deadline,
            timeoutMs,
            label: "Matrix crypto backup check shutdown",
          });
        }
      }
    }
    if (backupDownloader) {
      while (
        backupDownloader.downloadLoopRunning
        || backupDownloader.currentBackupVersionCheck
      ) {
        await waitForCryptoDrainFlag(backupDownloader, "downloadLoopRunning", {
          deadline,
          timeoutMs,
          label: "Matrix crypto backup-download shutdown",
        });
        const check = backupDownloader.currentBackupVersionCheck;
        if (check) {
          await waitForCryptoDrainPromise(check, {
            deadline,
            timeoutMs,
            label: "Matrix crypto backup-download check shutdown",
          });
        }
      }
    }
    if (keyClaimManager) {
      while (true) {
        const claim = keyClaimManager.currentClaimPromise;
        await waitForCryptoDrainPromise(claim, {
          deadline,
          timeoutMs,
          label: "Matrix crypto key-claim shutdown",
        });
        if (claim === keyClaimManager.currentClaimPromise) break;
      }
    }
    if (outgoingRequests) {
      await waitForCryptoDrainFlag(outgoingRequests, "outgoingRequestLoopRunning", {
        deadline,
        timeoutMs,
        label: "Matrix crypto outgoing-request shutdown",
      });
    }
  } catch (error) {
    throw cryptoDrainFailure(error, { unsafe: true });
  } finally {
    if (stoppedListener) client.removeListener("sync", stoppedListener);
  }
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
    this.decodeRecoveryKey = loadRecoveryKeyDecoder();
    this.cryptoStateDir = cryptoStateDirectory(
      account.accountId,
      this.settings.encryptionStateDir,
    );
    this.recoveryKeyStore = createRecoveryKeyStore({ stateDir: this.cryptoStateDir });
    this.networkFetch = globalThis.fetch?.bind(globalThis);
    this.clientFetchToken = null;
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
    this.warnedEncryptionConditions = new Set();
    this.encryptedEventContexts = new WeakMap();
    this.pendingEncryptedDeliveries = new Map();
    this.pendingRoomSends = new Map();
    this.cryptoRuntime = null;
    this.cryptoIdentity = null;
    this.cryptoRecoveryStatus = null;
    this.cryptoControlPromise = null;
    this.pendingRuntimeStop = null;
    this.runtimeCleanupError = null;
    this.encryptedClientConsumed = false;
    this.lifecycleCleanupError = null;
    this.acceptedEpoch = null;
    this.syncListener = null;
    this.timelineListener = null;
    this.decryptedListener = null;
  }

  createClient() {
    const fetchToken = {};
    this.clientFetchToken = fetchToken;
    return this.sdk.createClient({
      baseUrl: this.settings.homeserverUrl,
      accessToken: this.settings.accessToken,
      fetchFn: (...args) => this.fetchMatrix(fetchToken, ...args),
      cryptoCallbacks: this.recoveryKeyStore.cryptoCallbacks,
    });
  }

  async fetchMatrix(fetchToken, input, init) {
    if (this.settings.encryptionEnabled && incrementalSyncRequest(input)) {
      const runtime = this.cryptoRuntime;
      if (fetchToken !== this.clientFetchToken || !runtime) {
        throw new Error("refusing stale or uninitialized Matrix incremental sync");
      }
      const persisted = await this.checkpointCryptoState("incremental-sync");
      if (
        !persisted
        || fetchToken !== this.clientFetchToken
        || this.cryptoRuntime !== runtime
      ) {
        throw new Error("refusing Matrix incremental sync without current persisted crypto state");
      }
      await this.flushPendingEncryptedDeliveries(fetchToken, runtime);
      if (
        fetchToken !== this.clientFetchToken
        || this.cryptoRuntime !== runtime
      ) {
        throw new Error("refusing stale Matrix incremental sync after crypto checkpoint");
      }
    }
    if (cryptoWriteAheadRequest(input, init)) {
      const runtime = this.cryptoRuntime;
      if (
        fetchToken !== this.clientFetchToken
        || !this.settings.encryptionEnabled
        || !runtime
      ) {
        throw new Error("refusing stale or uninitialized Matrix encrypted request");
      }
      const persisted = await this.checkpointCryptoState("encrypted-request");
      if (
        !persisted
        || fetchToken !== this.clientFetchToken
        || this.cryptoRuntime !== runtime
      ) {
        throw new Error("refusing Matrix encrypted request without a current persisted crypto runtime");
      }
    }
    const roomSend = roomSendRequest(input);
    if (roomSend) this.assertRoomSendBoundary(fetchToken, roomSend);
    if (typeof this.networkFetch !== "function") {
      throw new Error("Matrix network fetch is unavailable");
    }
    return await this.networkFetch(input, init);
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
    let decryptedListener = null;
    let syncListenerAttached = false;
    let timelineListenerAttached = false;
    let decryptedListenerAttached = false;
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
        const cryptoIdentity = {
          homeserverUrl,
          userId: selfUserId,
          deviceId,
          accountId: String(this.accountId),
        };
        this.recoveryKeyStore.setIdentity(cryptoIdentity);
        this.cryptoIdentity = cryptoIdentity;
        runtime = await startCryptoRuntime({
          client,
          accountKey: `${homeserverUrl}\u0000${selfUserId}\u0000${this.accountId}`,
          stateDir: this.cryptoStateDir,
          identity: cryptoIdentity,
        });
        clientMustStop = true;
        if (epoch !== this.epoch) {
          const cleanup = await this.cleanupClientStart({
            client,
            runtime,
            syncListener,
            timelineListener,
            decryptedListener,
            syncListenerAttached,
            timelineListenerAttached,
            decryptedListenerAttached,
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
        try {
          this.cryptoRecoveryStatus = await enableExistingCryptoRecovery({
            client,
            recoveryKeyStore: this.recoveryKeyStore,
            identity: cryptoIdentity,
            persist: () => runtime.persist(),
          });
          if (
            this.cryptoRecoveryStatus.serverVersion
            && !this.cryptoRecoveryStatus.backupUsable
          ) {
            console.warn(
              `[${CHANNEL_ID}] Matrix room-key backup exists but is not usable`
              + ` account=${safeLogToken(this.accountId)}`
              + ` version=${safeLogToken(this.cryptoRecoveryStatus.serverVersion)}`,
            );
          }
        } catch (recoveryError) {
          this.cryptoRecoveryStatus = { error: recoveryError };
          console.warn(
            `[${CHANNEL_ID}] Matrix room-key backup startup check failed`
            + ` account=${safeLogToken(this.accountId)}:`,
            recoveryError,
          );
        }
        if (epoch !== this.epoch) {
          const cleanup = await this.cleanupClientStart({
            client,
            runtime,
            syncListener,
            timelineListener,
            decryptedListener,
            syncListenerAttached,
            timelineListenerAttached,
            decryptedListenerAttached,
            clientMustStop,
          });
          if (cleanup.errors.length) {
            throw this.lifecycleCleanupFailure(
              cleanup.errors,
              "Matrix cancelled recovery-check cleanup failed",
              { permanent: cleanup.permanent },
            );
          }
          return;
        }
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
      };
      timelineListener = (event, room, toStartOfTimeline, removed, data) => {
        if (!acceptsEvents()) return;
        void this.handleTimelineEvent(event, room, toStartOfTimeline, removed, data).catch((error) => {
          console.error(`[${CHANNEL_ID}] inbound event failed for ${this.accountId}:`, error);
        });
      };
      decryptedListener = (event, error) => {
        if (!acceptsEvents()) return;
        void this.handleEncryptedEventUpdate(event, error).catch((updateError) => {
          console.error(
            `[${CHANNEL_ID}] post-decryption event failed for ${safeLogToken(this.accountId)}:`,
            updateError,
          );
        });
      };
      this.acceptedEpoch = epoch;
      client.on("sync", syncListener);
      syncListenerAttached = true;
      client.on("Room.timeline", timelineListener);
      timelineListenerAttached = true;
      if (this.settings.encryptionEnabled) {
        client.on(DECRYPTED_EVENT_NAME, decryptedListener);
        decryptedListenerAttached = true;
      }
      clientMustStop = true;
      await client.startClient({ initialSyncLimit: 0 });
      if (epoch !== this.epoch) {
        const cleanup = await this.cleanupClientStart({
          client,
          runtime,
          syncListener,
          timelineListener,
          decryptedListener,
          syncListenerAttached,
          timelineListenerAttached,
          decryptedListenerAttached,
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
      this.decryptedListener = decryptedListenerAttached ? decryptedListener : null;
      this.running = true;
    } catch (error) {
      if (error?.[STARTUP_CLEANUP_COMPLETE]) throw error;
      const cleanup = await this.cleanupClientStart({
        client,
        runtime,
        syncListener,
        timelineListener,
        decryptedListener,
        syncListenerAttached,
        timelineListenerAttached,
        decryptedListenerAttached,
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
    decryptedListener,
    syncListenerAttached,
    timelineListenerAttached,
    decryptedListenerAttached,
    clientMustStop,
  }) {
    this.acceptedEpoch = null;
    this.clearEncryptedEventContexts();
    this.pendingRoomSends.clear();
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
    if (decryptedListenerAttached) {
      try {
        client.removeListener(DECRYPTED_EVENT_NAME, decryptedListener);
      } catch (error) {
        errors.push(error);
        permanent = true;
      }
    }
    let clientStopFailed = false;
    if (clientMustStop) {
      try {
        await this.drainClientCryptoWork(client);
      } catch (error) {
        errors.push(error);
        console.warn(
          `[${CHANNEL_ID}] Matrix crypto startup drain failed`
          + ` account=${safeLogToken(this.accountId)}`
          + ` unsafe=${error?.matrixCryptoClientStopUnsafe !== false}`
          + ` error=${safeLogToken(error?.message, "unknown")}`,
        );
        if (error?.matrixCryptoClientStopUnsafe !== false) {
          clientStopFailed = true;
          permanent = true;
        }
      }
      if (!clientStopFailed) {
        try {
          await client.stopClient();
        } catch (error) {
          clientStopFailed = true;
          errors.push(error);
          permanent = true;
        }
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
    if (this.decryptedListener === decryptedListener) this.decryptedListener = null;
    if (this.cryptoRuntime === runtime) this.cryptoRuntime = null;
    this.running = false;
    this.initialSyncComplete = false;
    this.outboundRoomStateFresh = false;
    return { errors, permanent };
  }

  async performStop() {
    if (this.cryptoControlPromise) {
      try {
        await this.cryptoControlPromise;
      } catch {
        // Control-plane failures do not bypass mandatory client/runtime cleanup.
      }
    }
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
    const decryptedListener = this.decryptedListener;
    const errors = [];
    let permanent = false;
    let clientStopFailed = false;
    try {
      await this.drainClientCryptoWork(this.client);
    } catch (error) {
      errors.push(error);
      console.warn(
        `[${CHANNEL_ID}] Matrix crypto stop drain failed`
        + ` account=${safeLogToken(this.accountId)}`
        + ` unsafe=${error?.matrixCryptoClientStopUnsafe !== false}`
        + ` error=${safeLogToken(error?.message, "unknown")}`,
      );
      if (error?.matrixCryptoClientStopUnsafe !== false) {
        clientStopFailed = true;
        permanent = true;
      }
    }
    this.cryptoRuntime = null;
    this.syncListener = null;
    this.timelineListener = null;
    this.decryptedListener = null;
    this.acceptedEpoch = null;
    this.running = false;
    this.initialSyncComplete = false;
    this.outboundRoomStateFresh = false;
    this.clearEncryptedEventContexts();
    this.pendingRoomSends.clear();
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
    if (decryptedListener) {
      try {
        this.client.removeListener(DECRYPTED_EVENT_NAME, decryptedListener);
      } catch (error) {
        errors.push(error);
        permanent = true;
      }
    }
    if (!clientStopFailed) {
      try {
        await this.client.stopClient();
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
    if (!room || roomIsEncrypted(room)) return;
    const content = { "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key } };
    void this.sendRoomEvent(chatId, "m.reaction", content).catch(() => {});
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

  warnDroppedEncryptedDelivery(messageId, pending, reason) {
    console.warn(
      `[${CHANNEL_ID}] dropping queued encrypted event`
      + ` account=${safeLogToken(this.accountId)}`
      + ` room=${safeLogToken(pending?.room?.roomId)}`
      + ` event=${safeLogToken(messageId)}`
      + ` reason=${safeLogToken(reason)}`,
    );
  }

  dropPendingEncryptedDelivery(messageId, pending, reason) {
    if (this.pendingEncryptedDeliveries.get(messageId) !== pending) return;
    this.warnDroppedEncryptedDelivery(messageId, pending, reason);
    this.pendingEncryptedDeliveries.delete(messageId);
  }

  clearEncryptedEventContexts(reason = "lifecycle-reset") {
    this.encryptedEventContexts = new WeakMap();
    for (const [messageId, pending] of this.pendingEncryptedDeliveries) {
      this.warnDroppedEncryptedDelivery(messageId, pending, reason);
    }
    this.pendingEncryptedDeliveries.clear();
  }

  assertRoomSendBoundary(fetchToken, {
    roomId,
    eventType,
    txnId,
  }) {
    const pending = this.pendingRoomSends.get(txnId);
    const plaintextRequest = eventType !== "m.room.encrypted";
    const pendingMatches = (
      pending
      && pending.roomId === roomId
      && pending.eventType === eventType
      && pending.client === this.client
      && pending.fetchToken === fetchToken
      && pending.epoch === this.acceptedEpoch
    );
    if (
      !roomId
      || !eventType
      || !txnId
      || (plaintextRequest && !pendingMatches)
      || fetchToken !== this.clientFetchToken
      || !this.desiredRunning
      || !this.running
      || this.acceptedEpoch === null
      || (
        plaintextRequest
        && (!this.initialSyncComplete || !this.outboundRoomStateFresh)
      )
    ) {
      throw new Error("refusing Matrix room send while lifecycle or room state is stale");
    }
    const room = this.client.getRoom?.(roomId);
    if (!room) {
      throw new Error(`refusing Matrix room send without loaded room state for ${roomId}`);
    }
    if (plaintextRequest && roomIsEncrypted(room)) {
      throw new Error(`refusing plaintext Matrix event at the encrypted-room HTTP boundary for ${roomId}`);
    }
  }

  async sendRoomEvent(chatId, eventType, content) {
    const client = this.client;
    const txnId = nonEmpty(client.makeTxnId?.());
    if (!txnId) throw new Error("Matrix client could not allocate a room-send transaction ID");
    const pending = {
      client,
      fetchToken: this.clientFetchToken,
      epoch: this.acceptedEpoch,
      roomId: chatId,
      eventType,
      operation: null,
    };
    this.pendingRoomSends.set(txnId, pending);
    try {
      pending.operation = Promise.resolve().then(
        () => client.sendEvent(chatId, eventType, content, txnId),
      );
      return await pending.operation;
    } finally {
      if (this.pendingRoomSends.get(txnId) === pending) {
        this.pendingRoomSends.delete(txnId);
      }
    }
  }

  async flushPendingEncryptedDeliveries(fetchToken, runtime) {
    for (const [messageId, pending] of [...this.pendingEncryptedDeliveries]) {
      if (
        fetchToken !== this.clientFetchToken
        || this.cryptoRuntime !== runtime
        || this.acceptedEpoch !== pending.epoch
        || this.client !== pending.client
      ) {
        this.dropPendingEncryptedDelivery(messageId, pending, "stale-lifecycle");
        continue;
      }
      if (pending.replaying) continue;
      pending.replaying = true;
      void this.handleTimelineEvent(
        pending.event,
        pending.room,
        pending.toStartOfTimeline,
        pending.removed,
        pending.data,
        {
          cryptoCheckpointSatisfied: true,
          queuedReplay: pending,
        },
      ).then(
        () => {
          if (this.pendingEncryptedDeliveries.get(messageId) === pending) {
            this.pendingEncryptedDeliveries.delete(messageId);
          }
        },
        (error) => {
          if (this.pendingEncryptedDeliveries.get(messageId) === pending) {
            pending.replaying = false;
          }
          console.error(`[${CHANNEL_ID}] inbound event failed for ${this.accountId}:`, error);
        },
      );
    }
  }

  reportDecryptionFailure(event, observer, error) {
    const reason = safeLogToken(
      event?.decryptionFailureReason ?? error?.code,
      "UNKNOWN_ERROR",
    );
    if (observer.reportedReasons.has(reason)) return;
    observer.reportedReasons.add(reason);
    const status = (
      reason === "MEGOLM_UNKNOWN_INBOUND_SESSION_ID"
      || reason === "OLM_UNKNOWN_MESSAGE_INDEX"
    )
      ? "missing_key; waiting for SDK key updates"
      : reason === "MEGOLM_KEY_WITHHELD"
        || reason === "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE"
        ? "withheld; no adapter retry"
        : "terminal; no adapter retry";
    console.warn(
      `[${CHANNEL_ID}] E2EE decryption failed account=${safeLogToken(this.accountId)}`
      + ` room=${safeLogToken(observer.chatId)} event=${safeLogToken(observer.eventId)}`
      + ` reason=${reason} status=${status}`,
    );
  }

  observeEncryptedEvent(event, context) {
    let observer = this.encryptedEventContexts.get(event);
    if (!observer) {
      observer = {
        ...context,
        eventId: nonEmpty(get(event, "getId", "event_id")),
        reportedReasons: new Set(),
      };
      this.encryptedEventContexts.set(event, observer);
    }
    if (event?.isDecryptionFailure?.()) {
      this.reportDecryptionFailure(event, observer);
    }
  }

  async handleEncryptedEventUpdate(event, error) {
    const observer = this.encryptedEventContexts.get(event);
    if (!observer) return;
    if (
      this.acceptedEpoch !== observer.epoch
      || this.client !== observer.client
    ) {
      this.encryptedEventContexts.delete(event);
      return;
    }
    if (error || event?.isDecryptionFailure?.()) {
      this.reportDecryptionFailure(event, observer, error);
      return;
    }
    this.encryptedEventContexts.delete(event);
    await this.handleTimelineEvent(
      event,
      observer.room,
      observer.toStartOfTimeline,
      observer.removed,
      observer.data,
    );
  }

  async recordEncryptionTelemetry(event, chatId) {
    let info = null;
    let semantics = "lax";
    try {
      const crypto = this.client.getCrypto?.();
      if (typeof crypto?.getEncryptionInfoForEvent === "function") {
        info = await crypto.getEncryptionInfoForEvent(event);
      }
      if (info && typeof crypto?.getUserVerificationStatus === "function") {
        const verification = await crypto.getUserVerificationStatus(event.getSender());
        const unverified = verification?.isVerified?.() === false;
        const previouslyVerified = (
          verification?.wasCrossSigningVerified?.() === true
          || verification?.needsUserApproval === true
        );
        if (info.shieldColour === SHIELD_COLOUR.NONE && unverified) {
          info = {
            shieldColour: SHIELD_COLOUR.RED,
            shieldReason: SHIELD_REASON.UNVERIFIED_IDENTITY,
          };
        } else if (
          info.shieldColour === SHIELD_COLOUR.GREY
          && info.shieldReason === SHIELD_REASON.AUTHENTICITY_NOT_GUARANTEED
        ) {
          info = {
            shieldColour: SHIELD_COLOUR.RED,
            shieldReason: SHIELD_REASON.AUTHENTICITY_NOT_GUARANTEED,
          };
        } else if (info.shieldReason === SHIELD_REASON.UNSIGNED_DEVICE) {
          info = {
            shieldColour: SHIELD_COLOUR.RED,
            shieldReason: SHIELD_REASON.UNVERIFIED_IDENTITY,
          };
        } else if (
          info.shieldReason === SHIELD_REASON.UNKNOWN
          && previouslyVerified
        ) {
          info = {
            shieldColour: SHIELD_COLOUR.RED,
            shieldReason: SHIELD_REASON.UNVERIFIED_IDENTITY,
          };
        }
        semantics = "strict";
      }
    } catch {
      console.warn(
        `[${CHANNEL_ID}] E2EE shield lookup failed account=${safeLogToken(this.accountId)}`
        + ` room=${safeLogToken(chatId)} event=${safeLogToken(get(event, "getId", "event_id"))}`,
      );
      return;
    }
    console.info(
      `[${CHANNEL_ID}] E2EE shield account=${safeLogToken(this.accountId)}`
      + ` room=${safeLogToken(chatId)} event=${safeLogToken(get(event, "getId", "event_id"))}`
      + ` semantics=${semantics}`
      + ` colour=${shieldLabel(info?.shieldColour, SHIELD_COLOUR_NAMES, "unavailable")}`
      + ` reason=${shieldLabel(
        info?.shieldReason,
        SHIELD_REASON_NAMES,
        "none",
      )}`,
    );
  }

  async checkpointCryptoState(reason) {
    const runtime = this.cryptoRuntime;
    if (!this.settings.encryptionEnabled || !runtime) return true;
    try {
      await runtime.persist();
      return true;
    } catch (error) {
      if (this.cryptoRuntime !== runtime) return false;
      console.error(
        `[${CHANNEL_ID}] crypto persistence checkpoint failed`
        + ` account=${safeLogToken(this.accountId)} reason=${safeLogToken(reason)};`
        + " the current crypto barrier failed:",
        error,
      );
      return false;
    }
  }

  runCryptoControl(operation, { timeoutMs = CRYPTO_CONTROL_TIMEOUT_MS } = {}) {
    if (!this.settings.encryptionEnabled) {
      return Promise.reject(new Error("Matrix encryption recovery is unavailable while encryption is disabled"));
    }
    if (!this.running || !this.desiredRunning || !this.cryptoRuntime || !this.cryptoIdentity) {
      return Promise.reject(new Error("Matrix encryption recovery requires a running encrypted adapter"));
    }
    if (this.cryptoControlPromise) {
      return Promise.reject(new Error("Another Matrix encryption recovery operation is already running"));
    }
    const client = this.client;
    const runtime = this.cryptoRuntime;
    const identity = this.cryptoIdentity;
    const pending = (async () => {
      const result = await operation({ client, runtime, identity });
      if (this.client !== client || this.cryptoRuntime !== runtime) {
        throw new Error("Matrix encryption recovery client changed during the operation");
      }
      return result;
    })();
    this.cryptoControlPromise = pending;
    void pending.finally(() => {
      if (this.cryptoControlPromise === pending) this.cryptoControlPromise = null;
    }).catch(() => undefined);
    return withTimeout(pending, timeoutMs, "Matrix encryption recovery operation");
  }

  async drainClientCryptoWork(
    client,
    { timeoutMs = CRYPTO_STOP_DRAIN_TIMEOUT_MS } = {},
  ) {
    if (!this.settings.encryptionEnabled) return;
    const pendingRoomSends = [...this.pendingRoomSends.values()]
      .filter((pending) => pending.client === client && pending.operation)
      .map((pending) => pending.operation);
    await drainMatrixClientCryptoWork(client, {
      timeoutMs,
      ...(pendingRoomSends.length
        ? {
            settleClientOperations: () => Promise.allSettled(pendingRoomSends),
          }
        : {}),
    });
  }

  async waitForInitialSync({ timeoutMs = CRYPTO_CONTROL_TIMEOUT_MS } = {}) {
    if (!this.running || !this.desiredRunning) {
      throw new Error("Matrix initial sync requires a running adapter");
    }
    const client = this.client;
    const epoch = this.acceptedEpoch;
    const deadline = Date.now() + timeoutMs;
    while (!this.initialSyncComplete) {
      if (
        !this.running
        || !this.desiredRunning
        || this.client !== client
        || this.acceptedEpoch !== epoch
      ) {
        throw new Error("Matrix adapter changed while waiting for initial sync");
      }
      if (Date.now() >= deadline) {
        throw new Error(`Matrix initial sync timed out after ${timeoutMs}ms`);
      }
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  getEncryptionRecoveryStatus() {
    return this.runCryptoControl(async ({ client, runtime, identity }) => {
      const status = await getCryptoRecoveryStatus({
        client,
        recoveryKeyStore: this.recoveryKeyStore,
        identity,
      });
      await runtime.persist();
      this.cryptoRecoveryStatus = status;
      return status;
    });
  }

  setupEncryptionRecovery({
    recoveryKeyExport = null,
    exportRecoveryKey,
    password,
  } = {}) {
    return this.runCryptoControl(async ({ client, runtime, identity }) => {
      const status = await setupCryptoRecovery({
        client,
        recoveryKeyStore: this.recoveryKeyStore,
        identity,
        recoveryKeyExport,
        exportRecoveryKey,
        password,
        decodeRecoveryKey: this.decodeRecoveryKey,
        persist: () => runtime.persist(),
      });
      this.cryptoRecoveryStatus = status;
      return status;
    });
  }

  restoreEncryptionRecovery({ recoveryKeyExport = null, progressCallback } = {}) {
    return this.runCryptoControl(async ({ client, runtime, identity }) => {
      const result = await restoreCryptoRecovery({
        client,
        recoveryKeyStore: this.recoveryKeyStore,
        identity,
        recoveryKeyExport,
        decodeRecoveryKey: this.decodeRecoveryKey,
        persist: () => runtime.persist(),
        progressCallback,
      });
      this.cryptoRecoveryStatus = result.status;
      return result;
    });
  }

  async handleTimelineEvent(
    event,
    room,
    toStartOfTimeline,
    removed,
    data,
    {
      cryptoCheckpointSatisfied = false,
      queuedReplay = null,
    } = {},
  ) {
    const eventEpoch = this.acceptedEpoch;
    const eventClient = this.client;
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
    const senderId = nonEmpty(get(event, "getSender", "sender"));
    if (!senderId || senderId === this.selfUserId || !this.settings.allowedUsers.has(senderId)) return;

    const encryptedRoom = roomIsEncrypted(room);
    const encryptedWireEvent = wireType === "m.room.encrypted";
    if (encryptedWireEvent && !this.settings.encryptionEnabled) {
      const warningKey = `disabled:${chatId}`;
      if (!this.warnedEncryptionConditions.has(warningKey)) {
        this.warnedEncryptionConditions.add(warningKey);
        console.warn(`[${CHANNEL_ID}] ignoring E2EE event in ${chatId}; encryption is disabled`);
      }
      return;
    }
    if (encryptedWireEvent !== encryptedRoom) {
      const warningKey = `mismatch:${chatId}`;
      if (!this.warnedEncryptionConditions.has(warningKey)) {
        this.warnedEncryptionConditions.add(warningKey);
        console.warn(
          `[${CHANNEL_ID}] ignoring Matrix room/wire encryption mismatch`
          + ` account=${safeLogToken(this.accountId)} room=${safeLogToken(chatId)}`
          + ` event=${safeLogToken(get(event, "getId", "event_id"))}`,
        );
      }
      return;
    }
    if (
      encryptedWireEvent
      && (
        type === "m.room.encrypted"
        || event?.isDecryptionFailure?.()
      )
    ) {
      this.observeEncryptedEvent(event, {
        chatId,
        room,
        toStartOfTimeline,
        removed,
        data,
        epoch: this.acceptedEpoch,
        client: this.client,
      });
      return;
    }
    if (type === "m.room.encrypted") return;
    if (type !== "m.room.message") return;

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
    if (encryptedWireEvent) {
      this.encryptedEventContexts.delete(event);
      await this.recordEncryptionTelemetry(event, chatId);
      if (
        this.acceptedEpoch !== eventEpoch
        || this.client !== eventClient
        || !this.initialSyncComplete
      ) {
        if (queuedReplay) {
          this.dropPendingEncryptedDelivery(messageId, queuedReplay, "stale-lifecycle");
        }
        this.seenEventIds.delete(messageId);
        return;
      }
      const persisted = (
        cryptoCheckpointSatisfied
        || await this.checkpointCryptoState("decrypted-event")
      );
      if (!persisted) {
        if (
          this.acceptedEpoch === eventEpoch
          && this.client === eventClient
          && this.initialSyncComplete
        ) {
          this.pendingEncryptedDeliveries.set(messageId, {
            event,
            room,
            toStartOfTimeline,
            removed,
            data,
            epoch: eventEpoch,
            client: eventClient,
          });
        }
        this.seenEventIds.delete(messageId);
        return;
      }
      if (
        this.acceptedEpoch !== eventEpoch
        || this.client !== eventClient
        || !this.initialSyncComplete
      ) {
        if (queuedReplay) {
          this.dropPendingEncryptedDelivery(messageId, queuedReplay, "stale-lifecycle");
        }
        this.seenEventIds.delete(messageId);
        return;
      }
      if (!queuedReplay) this.pendingEncryptedDeliveries.delete(messageId);
    }
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
    const encryptedRoom = roomIsEncrypted(room);
    if (encryptedRoom && !this.settings.encryptionEnabled) {
      throw new Error(`refusing to send plaintext into encrypted Matrix room ${chatId}`);
    }
    if (encryptedRoom && !this.client.getCrypto?.()) {
      throw new Error(`refusing Matrix encrypted outbound without initialized crypto for ${chatId}`);
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
    const response = await this.sendRoomEvent(chatId, "m.room.message", content);
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
