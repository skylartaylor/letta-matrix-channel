import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const SELF = "@matrix:example.org";
const SENDER = "@sky:example.org";
const ROOM = "!room:example.org";
const ROOM2 = "!second:example.org";
const BASE_CONFIG = {
  homeserverUrl: "https://example.org",
  bot_token: "test-token",
  allowedRooms: [ROOM, ROOM2],
  allowedUsers: [SENDER],
  requireMention: true,
  mentionAliases: ["matrix"],
};

const runtime = new URL("../runtime/", import.meta.url);
mkdirSync(runtime, { recursive: true });
writeFileSync(new URL("package.json", runtime), '{"type":"commonjs"}\n');
mkdirSync(new URL("node_modules/matrix-js-sdk/", runtime), { recursive: true });
writeFileSync(
  new URL("node_modules/matrix-js-sdk/index.js", runtime),
  "module.exports = { createClient: (...args) => globalThis.__matrixCreateClient(...args) };\n",
);

function makeClient(overrides = {}) {
  const client = {
    credentials: {},
    handlers: new Map(),
    outbound: [],
    calls: [],
    typing: [],
    receipts: [],
    sendTyping: async (roomId, isTyping, timeoutMs) => {
      client.typing.push([roomId, isTyping, timeoutMs]);
    },
    sendReadReceipt: async (event) => {
      client.receipts.push(event);
    },
    getUserId: () => null,
    whoami: async () => {
      client.calls.push("whoami");
      return { user_id: SELF };
    },
    on: (name, handler) => {
      if (!client.handlers.has(name)) client.handlers.set(name, []);
      client.handlers.get(name).push(handler);
    },
    removeListener: (name, handler) => {
      const registered = client.handlers.get(name) ?? [];
      const index = registered.indexOf(handler);
      if (index >= 0) registered.splice(index, 1);
    },
    startClient: () => client.calls.push("startClient"),
    stopClient: () => client.calls.push("stopClient"),
    sendEvent: async (...args) => {
      client.outbound.push(args);
      return { event_id: "$reply" };
    },
    getRoom: () => undefined,
    ...overrides,
  };
  return client;
}

function room(extra = {}) {
  return { roomId: ROOM, name: "Matrix Test Room", getMember: () => ({ name: "Test User" }), ...extra };
}

function messageEvent(id, body, extra = {}) {
  const content = { msgtype: "m.text", body, ...extra.content };
  return {
    getType: () => extra.type ?? "m.room.message",
    getContent: () => content,
    getId: () => id,
    getSender: () => extra.sender ?? SENDER,
    getTs: () => extra.ts ?? 1_700_000_000_000,
    getUnsigned: () => extra.unsigned ?? {},
  };
}

async function emit(client, event, target = room()) {
  for (const handler of [...(client.handlers.get("Room.timeline") ?? [])]) {
    await handler(event, target, false, false, { liveEvent: true });
  }
}

const { channelPlugin } = await import("../plugin.mjs");

function makeAdapter({ config = {}, client: clientOverrides = {} } = {}) {
  const client = makeClient(clientOverrides);
  globalThis.__matrixCreateClient = () => client;
  const adapter = channelPlugin.createAdapter({ accountId: "main", config: { ...BASE_CONFIG, ...config } });
  const inbound = [];
  adapter.onMessage = async (message) => inbound.push(message);
  return { adapter, client, inbound };
}

async function startedAdapter(options = {}) {
  const { prepared = true, ...rest } = options;
  const made = makeAdapter(rest);
  await made.adapter.start();
  if (prepared) for (const handler of made.client.handlers.get("sync") ?? []) handler("PREPARED");
  return made;
}

const info = console.info;
console.info = () => undefined;
const passed = [];
async function test(name, fn) {
  await fn();
  passed.push(name);
}

try {
  await test("whoami resolves identity before startClient", async () => {
    const { adapter, client } = await startedAdapter();
    assert.equal(adapter.selfUserId, SELF);
    assert.equal(client.credentials.userId, SELF);
    assert.deepEqual(client.calls, ["whoami", "startClient"]);
  });

  await test("whoami retries transient failures", async () => {
    let attempts = 0;
    const { adapter } = await startedAdapter({
      config: { whoamiRetryDelaysMs: [0, 0] },
      client: {
        whoami: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("socket hang up");
          return { user_id: SELF };
        },
      },
    });
    assert.equal(attempts, 3);
    assert.equal(adapter.isRunning(), true);
  });

  await test("whoami does not retry auth rejections", async () => {
    let attempts = 0;
    const { adapter } = makeAdapter({
      config: { whoamiRetryDelaysMs: [0, 0] },
      client: {
        whoami: async () => {
          attempts += 1;
          throw Object.assign(new Error("Invalid token"), { errcode: "M_UNKNOWN_TOKEN", httpStatus: 401 });
        },
      },
    });
    await assert.rejects(() => adapter.start(), /Invalid token/);
    assert.equal(attempts, 1);
    assert.equal(adapter.isRunning(), false);
  });

  await test("hung whoami times out instead of blocking start()", async () => {
    const { adapter } = makeAdapter({
      config: { whoamiTimeoutMs: 30, whoamiRetryDelaysMs: [] },
      client: { whoami: () => new Promise(() => undefined) },
    });
    await assert.rejects(() => adapter.start(), /Matrix whoami timed out after 30ms/);
    assert.equal(adapter.isRunning(), false);
  });

  await test("stop() during start() abandons the start", async () => {
    let release;
    const { adapter, client, inbound } = makeAdapter({
      client: { whoami: () => new Promise((resolve) => { release = resolve; }) },
    });
    const starting = adapter.start();
    await Promise.resolve();
    await adapter.stop();
    release({ user_id: SELF });
    await starting;
    assert.equal(adapter.isRunning(), false);
    assert.equal(client.calls.includes("startClient"), false);
    assert.equal((client.handlers.get("Room.timeline") ?? []).length, 0);
    for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
    await emit(client, messageEvent("$during", "matrix hi"));
    assert.equal(inbound.length, 0);
  });

  await test("concurrent start() registers listeners once", async () => {
    let release;
    const { adapter, client } = makeAdapter({
      client: { whoami: () => new Promise((resolve) => { release = resolve; }) },
    });
    const first = adapter.start();
    const second = adapter.start();
    release({ user_id: SELF });
    await Promise.all([first, second]);
    assert.equal(client.handlers.get("Room.timeline").length, 1);
    assert.equal(client.handlers.get("sync").length, 1);
    assert.equal(client.calls.filter((call) => call === "startClient").length, 1);
  });

  await test("delivers a mention once and shapes the host payload", async () => {
    const { client, inbound } = await startedAdapter();
    const event = messageEvent("$one", "matrix hi");
    await emit(client, event);
    assert.equal(inbound.length, 1);
    const [message] = inbound;
    assert.equal(message.chatId, ROOM);
    assert.equal(message.chatType, "channel");
    assert.equal(message.isMention, true);
    assert.equal(typeof message.timestamp, "number");
    assert.equal(message.timestamp, 1_700_000_000_000);
    assert.equal(message.messageId, "$one");
    assert.equal(message.senderName, "Test User");
    assert.equal(message.chatLabel, "Matrix Test Room");
    assert.equal(message.text, "matrix hi");
    await emit(client, event);
    assert.equal(inbound.length, 1, "replayed event must not redeliver");
  });

  await test("falls back to the sender id and drops an empty chatLabel", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$two", "matrix hi"), { roomId: ROOM });
    assert.equal(inbound[0].senderName, SENDER);
    assert.equal("chatLabel" in inbound[0], false);
  });

  await test("ignores non-live timeline events", async () => {
    const { client, inbound } = await startedAdapter();
    for (const handler of client.handlers.get("Room.timeline")) {
      await handler(messageEvent("$back", "matrix hi"), room(), true, false, { liveEvent: true });
      await handler(messageEvent("$gone", "matrix hi"), room(), false, true, { liveEvent: true });
      await handler(messageEvent("$paged", "matrix hi"), room(), false, false, { liveEvent: false });
      await handler(messageEvent("$bare", "matrix hi"), room(), false, false, undefined);
    }
    assert.equal(inbound.length, 0);
  });

  await test("drops events until the initial sync completes", async () => {
    const { client, inbound } = await startedAdapter({ prepared: false });
    await emit(client, messageEvent("$early", "matrix hi"));
    assert.equal(inbound.length, 0);
    for (const handler of client.handlers.get("sync")) handler("PREPARED");
    await emit(client, messageEvent("$late", "matrix hi"));
    assert.equal(inbound.length, 1);
  });

  await test("drops senders outside the allowlist", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$mallory", "matrix hi", { sender: "@mallory:example.org" }));
    assert.equal(inbound.length, 0);
  });

  await test("drops the bot's own messages", async () => {
    const { client, inbound } = await startedAdapter({ config: { allowedUsers: [SENDER, SELF] } });
    await emit(client, messageEvent("$echo", "matrix hi", { sender: SELF }));
    assert.equal(inbound.length, 0);
  });

  await test("drops rooms outside the allowlist", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$elsewhere", "matrix hi"), { roomId: "!other:example.org" });
    assert.equal(inbound.length, 0);
  });

  await test("ignores encrypted events and warns once per room", async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(line);
    try {
      const { client, inbound } = await startedAdapter();
      const encrypted = messageEvent("$enc", "matrix hi", { type: "m.room.encrypted" });
      await emit(client, encrypted);
      await emit(client, messageEvent("$enc2", "matrix hi", { type: "m.room.encrypted" }));
      assert.equal(inbound.length, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /ignoring E2EE event/);
    } finally {
      console.warn = warn;
    }
  });

  await test("drops non-text msgtypes", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$img", "matrix cat.jpg", { content: { msgtype: "m.image" } }));
    assert.equal(inbound.length, 0);
  });

  await test("requireMention defaults on when unset", async () => {
    const { client, inbound } = await startedAdapter({ config: { requireMention: undefined } });
    await emit(client, messageEvent("$plain", "hello there"));
    assert.equal(inbound.length, 0);
    await emit(client, messageEvent("$hail", "matrix hello"));
    assert.equal(inbound.length, 1);
  });

  await test("drops edits but keeps originals carrying bundled edits", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$edit", "* matrix hi again", {
      content: { "m.relates_to": { rel_type: "m.replace", event_id: "$one" } },
    }));
    assert.equal(inbound.length, 0);
    await emit(client, messageEvent("$bundled", "matrix original", {
      unsigned: { "m.relations": { "m.replace": { event_id: "$edit" } } },
    }));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].text, "matrix original");
  });

  await test("honours m.mentions without a textual mention", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$mentions", "any news?", {
      content: { "m.mentions": { user_ids: [SELF] } },
    }));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].isMention, true);
  });

  await test("matches bare MXID mentions", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$mxid", `${SELF} hi`));
    await emit(client, messageEvent("$mxid-mid", `hey ${SELF}, ping`));
    assert.equal(inbound.length, 2);
    assert.equal(inbound[0].isMention, true);
  });

  await test("rejects alias lookalikes on foreign homeservers", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$evil", "@matrix:evil.example.net please help"));
    await emit(client, messageEvent("$cc", "cc @matrix:other.org on this"));
    assert.equal(inbound.length, 0);
  });

  await test("matches punctuation-wrapped aliases", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$paren", "(matrix) hi"));
    await emit(client, messageEvent("$dot", "matrix. take a look"));
    await emit(client, messageEvent("$quote", '"matrix" ping'));
    assert.equal(inbound.length, 3);
  });

  await test("drops unmentioned text when requireMention is set", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$quiet", "hello there"));
    await emit(client, messageEvent("$suffix", "vespers unite"));
    await emit(client, messageEvent("$email", "mail bob@matrix.com please"));
    assert.equal(inbound.length, 0);
  });

  await test("reports isMention when requireMention is off", async () => {
    const { client, inbound } = await startedAdapter({ config: { requireMention: false } });
    await emit(client, messageEvent("$quiet", "hello there"));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].isMention, false);
  });

  await test("strips one leading mention only for known slash commands", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$cmd", `${SELF} /status`));
    await emit(client, messageEvent("$cmd-alias", "matrix: /status now"));
    await emit(client, messageEvent("$path", "matrix /Users/sky/notes.md is missing"));
    await emit(client, messageEvent("$regex", "matrix /^foo$/ matches what?"));
    await emit(client, messageEvent("$chat", "matrix how are you"));
    assert.deepEqual(inbound.map((message) => message.text), [
      "/status",
      "/status now",
      "matrix /Users/sky/notes.md is missing",
      "matrix /^foo$/ matches what?",
      "matrix how are you",
    ]);
  });

  await test("strips rich-reply fallback quotes before gating", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$reply-cmd", `> <${SELF}> earlier message\n\nmatrix /status`, {
      content: { "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } } },
    }));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].text, "/status");
    assert.deepEqual(inbound[0].replyContext, { messageId: "$orig" });
    await emit(client, messageEvent("$reply-quiet", `> <${SELF}> earlier message\n\nthanks all`, {
      content: { "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } } },
    }));
    assert.equal(inbound.length, 1, "quoting the bot is not a mention");
  });

  await test("stop() then start() leaves exactly one handler per event", async () => {
    const { adapter, client } = await startedAdapter();
    assert.equal(client.handlers.get("Room.timeline").length, 1);
    await adapter.stop();
    assert.equal(client.handlers.get("Room.timeline").length, 0);
    assert.equal(client.handlers.get("sync").length, 0);
    await adapter.start();
    assert.equal(client.handlers.get("Room.timeline").length, 1);
    assert.equal(client.handlers.get("sync").length, 1);
    assert.equal(adapter.isRunning(), true);
  });

  await test("redelivers an event when the host fails to take delivery", async () => {
    const { adapter, client } = await startedAdapter();
    const delivered = [];
    let failures = 0;
    adapter.onMessage = async (message) => {
      if (failures === 0) {
        failures += 1;
        throw new Error("host unavailable");
      }
      delivered.push(message);
    };
    const errors = console.error;
    console.error = () => undefined;
    try {
      const event = messageEvent("$flaky", "matrix hi");
      await emit(client, event);
      await emit(client, event);
    } finally {
      console.error = errors;
    }
    assert.equal(delivered.length, 1);
  });

  await test("sendMessage returns the event_id string", async () => {
    const { adapter, client } = await startedAdapter();
    const result = await adapter.sendMessage({ chatId: ROOM, text: "hello" });
    assert.deepEqual(result, { messageId: "$reply" });
    assert.equal(typeof result.messageId, "string");
    assert.equal(client.outbound.length, 1);
    const [chatId, type, content] = client.outbound[0];
    assert.equal(chatId, ROOM);
    assert.equal(type, "m.room.message");
    assert.deepEqual(content, { msgtype: "m.text", body: "hello" });
  });

  await test("falls back to \"unknown\" when the server omits event_id", async () => {
    const { adapter } = await startedAdapter({ client: { sendEvent: async () => ({}) } });
    const result = await adapter.sendMessage({ chatId: ROOM, text: "hello" });
    assert.equal(result.messageId, "unknown");
  });

  await test("rejects outbound messages outside configured rooms", async () => {
    const { adapter } = await startedAdapter();
    await assert.rejects(() => adapter.sendMessage({ chatId: "!other:example.org", text: "no" }));
  });

  await test("threaded send falls back to the latest known thread event", async () => {
    const { adapter, client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$t2", "matrix hi", {
      content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
    }));
    assert.equal(inbound[0].threadId, "$root");
    await adapter.sendMessage({ chatId: ROOM, text: "one", threadId: "$root" });
    assert.deepEqual(client.outbound[0][2]["m.relates_to"], {
      rel_type: "m.thread",
      event_id: "$root",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$t2" },
    });
    await adapter.sendMessage({ chatId: ROOM, text: "two", threadId: "$root" });
    assert.equal(client.outbound[1][2]["m.relates_to"]["m.in_reply_to"].event_id, "$reply");
    await adapter.sendMessage({ chatId: ROOM, text: "three", threadId: "$unseen" });
    assert.equal(client.outbound[2][2]["m.relates_to"]["m.in_reply_to"].event_id, "$unseen");
  });

  await test("thread tips are room-scoped", async () => {
    const { adapter, client } = await startedAdapter();
    await emit(client, messageEvent("$tip", "matrix hi", {
      content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
    }));
    await adapter.sendMessage({ chatId: ROOM2, text: "cross", threadId: "$root" });
    assert.equal(client.outbound[0][2]["m.relates_to"]["m.in_reply_to"].event_id, "$root");
  });

  await test("explicit reply inside a thread drops the fallback flag", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendMessage({ chatId: ROOM, text: "hi", threadId: "$root", replyToMessageId: "$target" });
    assert.deepEqual(client.outbound[0][2]["m.relates_to"], {
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: "$target" },
    });
  });

  await test("reply without a thread uses a plain in_reply_to", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendMessage({ chatId: ROOM, text: "hi", replyToMessageId: "$target" });
    assert.deepEqual(client.outbound[0][2]["m.relates_to"], { "m.in_reply_to": { event_id: "$target" } });
  });

  await test("sendDirectReply passes thread and reply targets through", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendDirectReply(ROOM, "hi", { threadId: "$root", replyToMessageId: "$target" });
    assert.deepEqual(client.outbound[0][2]["m.relates_to"], {
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: "$target" },
    });
  });

  await test("refuses to send plaintext into an encrypted room", async () => {
    const { adapter, client } = await startedAdapter({
      client: {
        getRoom: (roomId) => (roomId === ROOM
          ? { currentState: { getStateEvents: (type, key) => (type === "m.room.encryption" && key === "" ? { type } : null) } }
          : undefined),
      },
    });
    await assert.rejects(
      () => adapter.sendMessage({ chatId: ROOM, text: "hi" }),
      /refusing to send plaintext into encrypted Matrix room !room:example\.org/,
    );
    assert.equal(client.outbound.length, 0);
  });

  await test("attaches formatted_body only when markdown fired", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendMessage({ chatId: ROOM, text: "**bold**" });
    assert.equal(client.outbound[0][2].format, "org.matrix.custom.html");
    assert.equal(client.outbound[0][2].formatted_body, "<strong>bold</strong>");
    assert.equal(client.outbound[0][2].body, "**bold**");

    await adapter.sendMessage({ chatId: ROOM, text: "plain <text> & more" });
    assert.equal("format" in client.outbound[1][2], false);

    await adapter.sendMessage({ chatId: ROOM, text: "line one\nline two" });
    assert.equal("formatted_body" in client.outbound[2][2], false);

    await adapter.sendMessage({
      chatId: ROOM,
      text: "see [docs](https://example.org/a?b=1) and `x<y` and ~~no~~ and *it*\nnext",
    });
    assert.equal(
      client.outbound[3][2].formatted_body,
      'see <a href="https://example.org/a?b=1">docs</a> and <code>x&lt;y</code> and <del>no</del> and <em>it</em><br/>next',
    );
  });

  await test("markdown avoids glob and arithmetic false positives", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendMessage({ chatId: ROOM, text: "2 ** 3 and 4 * 5" });
    assert.equal("formatted_body" in client.outbound[0][2], false);
    await adapter.sendMessage({ chatId: ROOM, text: "*.js and *.ts files" });
    assert.equal("formatted_body" in client.outbound[1][2], false);
    await adapter.sendMessage({ chatId: ROOM, text: 'say "hi" **now**' });
    assert.equal(client.outbound[2][2].formatted_body, "say &quot;hi&quot; <strong>now</strong>");
  });

  await test("code fences keep their content", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendMessage({ chatId: ROOM, text: "```code```" });
    assert.equal(client.outbound[0][2].formatted_body, "<pre><code>code</code></pre>");
    await adapter.sendMessage({ chatId: ROOM, text: "```js\nconst a = 1 < 2;\n```" });
    assert.equal(client.outbound[1][2].formatted_body, "<pre><code>const a = 1 &lt; 2;</code></pre>");
    await adapter.sendMessage({ chatId: ROOM, text: "```js\nconst x = **1** < 2;" });
    assert.equal("formatted_body" in client.outbound[2][2], false, "unterminated fence stays plain");
  });

  await test("marks read and starts typing when a message is grabbed", async () => {
    const { client, inbound } = await startedAdapter();
    const event = messageEvent("$grab", "matrix hi");
    await emit(client, event);
    assert.equal(inbound.length, 1);
    assert.equal(client.receipts.length, 1);
    assert.equal(client.receipts[0], event);
    assert.deepEqual(client.typing, [[ROOM, true, 30_000]]);
  });

  await test("sends no receipt or typing for dropped messages", async () => {
    const { client, inbound } = await startedAdapter();
    await emit(client, messageEvent("$ignored", "no mention here"));
    await emit(client, messageEvent("$edit-drop", "* matrix edit", {
      content: { "m.relates_to": { rel_type: "m.replace", event_id: "$x" } },
    }));
    assert.equal(inbound.length, 0);
    assert.equal(client.receipts.length, 0);
    assert.equal(client.typing.length, 0);
  });

  await test("throttles typing refreshes but not receipts", async () => {
    const { client } = await startedAdapter();
    await emit(client, messageEvent("$fast1", "matrix one"));
    await emit(client, messageEvent("$fast2", "matrix two"));
    assert.equal(client.receipts.length, 2);
    assert.equal(client.typing.filter(([, isTyping]) => isTyping).length, 1);
  });

  await test("sendMessage clears typing", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.sendMessage({ chatId: ROOM, text: "done" });
    assert.deepEqual(client.typing.at(-1), [ROOM, false, 30_000]);
  });

  await test("turn lifecycle and progress events drive typing", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.handleTurnProgressEvent({ kind: "responding", state: "started", sources: [
      { channel: "matrix", chatId: ROOM },
      { channel: "telegram", chatId: "999" },
    ] });
    assert.deepEqual(client.typing, [[ROOM, true, 30_000]], "foreign channels ignored");
    await adapter.handleTurnProgressEvent({ kind: "approval", state: "waiting", sources: [{ channel: "matrix", chatId: ROOM }] });
    assert.deepEqual(client.typing.at(-1), [ROOM, false, 30_000]);
    await adapter.handleTurnLifecycleEvent({ type: "queued", source: { channel: "matrix", chatId: ROOM } });
    assert.deepEqual(client.typing.at(-1), [ROOM, true, 30_000]);
    await adapter.handleTurnLifecycleEvent({ type: "finished", sources: [{ channel: "matrix", chatId: ROOM }] });
    assert.deepEqual(client.typing.at(-1), [ROOM, false, 30_000]);
  });

  await test("ack reactions are off by default", async () => {
    const { adapter, client } = await startedAdapter();
    await emit(client, messageEvent("$noack", "matrix hi"));
    await adapter.handleTurnLifecycleEvent({ type: "finished", outcome: "completed", sources: [{ channel: "matrix", chatId: ROOM, messageId: "$noack" }] });
    assert.equal(client.outbound.filter(([, type]) => type === "m.reaction").length, 0);
  });

  await test("ackReaction reacts 👀 on grab and ✅ on completion", async () => {
    const { adapter, client } = await startedAdapter({ config: { ackReaction: true } });
    await emit(client, messageEvent("$acked", "matrix hi"));
    const reactions = () => client.outbound.filter(([, type]) => type === "m.reaction").map(([room, , content]) => [room, content["m.relates_to"].event_id, content["m.relates_to"].key, content["m.relates_to"].rel_type]);
    assert.deepEqual(reactions(), [[ROOM, "$acked", "👀", "m.annotation"]]);
    await adapter.handleTurnLifecycleEvent({ type: "finished", outcome: "error", sources: [{ channel: "matrix", chatId: ROOM, messageId: "$acked" }] });
    assert.equal(reactions().length, 1, "no checkmark on error");
    await adapter.handleTurnLifecycleEvent({ type: "finished", outcome: "completed", sources: [
      { channel: "matrix", chatId: ROOM, messageId: "$acked" },
      { channel: "telegram", chatId: "999", messageId: "42" },
    ] });
    assert.deepEqual(reactions().at(-1), [ROOM, "$acked", "✅", "m.annotation"]);
    assert.equal(reactions().length, 2, "foreign channels ignored");
  });

  await test("indicator config flags disable receipts and typing", async () => {
    const { client, inbound } = await startedAdapter({ config: { readReceipts: false, typingIndicators: false } });
    await emit(client, messageEvent("$quiet-mode", "matrix hi"));
    assert.equal(inbound.length, 1);
    assert.equal(client.receipts.length, 0);
    assert.equal(client.typing.length, 0);
  });

  await test("rejects the renamed accessToken config key", () => {
    globalThis.__matrixCreateClient = () => makeClient();
    const migration = /Matrix config renamed: move config\.accessToken to config\.bot_token/;
    assert.throws(
      () => channelPlugin.createAdapter({
        accountId: "main",
        config: { ...BASE_CONFIG, bot_token: undefined, accessToken: "test-token" },
      }),
      migration,
    );
    assert.throws(
      () => channelPlugin.createAdapter({
        accountId: "main",
        config: { ...BASE_CONFIG, accessToken: "stale-old-token" },
      }),
      migration,
      "both keys present must still fail",
    );
    assert.throws(
      () => channelPlugin.createAdapter({
        accountId: "main",
        config: { ...BASE_CONFIG, bot_token: undefined },
      }),
      /Matrix config requires a bot_token/,
    );
  });

  await test("rejects a bare or non-https homeserverUrl", () => {
    globalThis.__matrixCreateClient = () => makeClient();
    for (const homeserverUrl of ["https://", "http://matrix.example.org", "matrix.example.org"]) {
      assert.throws(
        () => channelPlugin.createAdapter({ accountId: "main", config: { ...BASE_CONFIG, homeserverUrl } }),
        /Matrix config requires an HTTPS homeserverUrl/,
      );
    }
  });

  await test("accepts bot_token", () => {
    globalThis.__matrixCreateClient = () => makeClient();
    const adapter = channelPlugin.createAdapter({ accountId: "main", config: BASE_CONFIG });
    assert.equal(adapter.settings.accessToken, "test-token");
  });

  console.info = info;
  for (const name of passed) console.log(`ok - ${name}`);
  console.log(`matrix plugin tests passed (${passed.length})`);
} finally {
  console.info = info;
  rmSync(runtime, { recursive: true, force: true });
}
