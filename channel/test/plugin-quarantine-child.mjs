import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SELF = "@matrix:example.org";
const ROOM = "!room:example.org";
const root = await mkdtemp(join(tmpdir(), "letta-matrix-plugin-quarantine-"));
const clients = [];
globalThis.__matrixCreateClient = () => {
  const client = clients.shift();
  if (!client) throw new Error("Matrix quarantine test client factory exhausted");
  return client;
};

function makeClient({ initRustCrypto }) {
  const client = {
    credentials: {},
    handlers: new Map(),
    whoami: async () => ({ user_id: SELF, device_id: "DEVICE" }),
    initRustCrypto,
    on(name, handler) {
      if (!client.handlers.has(name)) client.handlers.set(name, []);
      client.handlers.get(name).push(handler);
    },
    removeListener() {},
    startClient() {
      throw new Error("sync must not start after rejected crypto initialization");
    },
    stopCalls: 0,
    async stopClient() {
      client.stopCalls += 1;
    },
  };
  return client;
}

try {
  let enteredInit;
  let rejectInit;
  const initEntered = new Promise((resolve) => {
    enteredInit = resolve;
  });
  const initGate = new Promise((_resolve, reject) => {
    rejectInit = reject;
  });
  const firstClient = makeClient({
    initRustCrypto: async () => {
      enteredInit();
      await initGate;
    },
  });
  clients.push(firstClient);

  const { channelPlugin } = await import("../plugin.mjs");
  const adapter = channelPlugin.createAdapter({
    accountId: "quarantine",
    config: {
      homeserverUrl: "https://example.org",
      bot_token: "token",
      allowedRooms: [ROOM],
      allowedUsers: [SELF],
      encryption: { enabled: true, stateDir: join(root, "first") },
    },
  });
  const starting = adapter.start();
  await initEntered;
  const stopping = adapter.stop();
  rejectInit(new Error("Rust initialization rejected"));
  await assert.rejects(() => starting, /Rust initialization rejected/);
  await assert.rejects(() => stopping, /Rust initialization rejected/);
  assert.equal(firstClient.stopCalls, 1);
  assert.equal(adapter.isRunning(), false);
  await assert.rejects(
    () => adapter.start(),
    /cannot restart after failed lifecycle cleanup/,
  );

  let otherInit = false;
  const otherClient = makeClient({
    initRustCrypto: async () => {
      otherInit = true;
    },
  });
  clients.push(otherClient);
  const other = channelPlugin.createAdapter({
    accountId: "other",
    config: {
      homeserverUrl: "https://example.org",
      bot_token: "token",
      allowedRooms: [ROOM],
      allowedUsers: [SELF],
      encryption: { enabled: true, stateDir: join(root, "second") },
    },
  });
  await assert.rejects(() => other.start(), /already running/);
  assert.equal(otherInit, false);
} finally {
  await rm(root, { recursive: true, force: true });
}
