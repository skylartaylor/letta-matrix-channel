import { createRequire } from "node:module";

const CHANNEL_ID = "matrix";
const MAX_DEDUPED_EVENT_IDS = 2_000;
const MAX_TRACKED_THREAD_TIPS = 500;
const WHOAMI_RETRY_DELAYS_MS = [500, 1500];
const WHOAMI_TIMEOUT_MS = 10_000;
const TYPING_TIMEOUT_MS = 30_000;
const TYPING_REFRESH_MS = 10_000;
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
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
    this.client = loadSdk().createClient({
      baseUrl: this.settings.homeserverUrl,
      accessToken: this.settings.accessToken,
    });
    this.id = `${CHANNEL_ID}:${account.accountId}`;
    this.channelId = CHANNEL_ID;
    this.accountId = account.accountId;
    this.name = account.displayName ?? "Matrix";
    this.onMessage = undefined;
    this.running = false;
    this.startPending = false;
    this.epoch = 0;
    this.initialSyncComplete = false;
    this.selfUserId = null;
    this.seenEventIds = new Set();
    this.threadTips = new Map();
    this.lastTypingSentAt = new Map();
    this.warnedEncryptedRooms = new Set();
    // Bound once: the host reuses this instance across stop()/start() cycles.
    this.onSync = (state) => {
      if (String(state).toUpperCase() === "PREPARED") this.initialSyncComplete = true;
    };
    this.onTimeline = (event, room, toStartOfTimeline, removed, data) =>
      this.handleTimelineEvent(event, room, toStartOfTimeline, removed, data).catch((error) => {
        console.error(`[${CHANNEL_ID}] inbound event failed for ${this.accountId}:`, error);
      });
  }

  async start() {
    if (this.running || this.startPending) return;
    this.startPending = true;
    const epoch = ++this.epoch;
    try {
      const identity = await whoamiWithRetry(this.client, this.settings);
      const selfUserId = nonEmpty(identity?.user_id);
      if (!selfUserId) throw new Error("Matrix whoami returned no user_id; check the configured bot_token");
      // stop() during the whoami round-trip abandons this start.
      if (epoch !== this.epoch) return;
      this.selfUserId = selfUserId;
      // createClient() without userId never resolves one; SDK internals (sync filter
      // name, Room.myUserId) read credentials.userId and must be set before startClient.
      (this.client.credentials ??= {}).userId = selfUserId;
      this.client.on("sync", this.onSync);
      this.client.on("Room.timeline", this.onTimeline);
      this.client.startClient({ initialSyncLimit: 0 });
      this.running = true;
    } finally {
      this.startPending = false;
    }
  }

  async stop() {
    this.epoch += 1;
    if (!this.running) return;
    this.client.removeListener("sync", this.onSync);
    this.client.removeListener("Room.timeline", this.onTimeline);
    this.client.stopClient();
    this.running = false;
    this.initialSyncComplete = false;
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
    if (type === "m.room.encrypted") {
      if (!this.warnedEncryptedRooms.has(chatId)) {
        this.warnedEncryptedRooms.add(chatId);
        console.warn(`[${CHANNEL_ID}] ignoring E2EE event in ${chatId}; v1 does not implement Matrix crypto`);
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
    if (this.client.getRoom?.(chatId)?.currentState?.getStateEvents?.("m.room.encryption", "")) {
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
