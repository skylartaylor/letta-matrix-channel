import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import {
  decryptExistingEvent,
  mkDecryptionFailureMatrixEvent,
} from "matrix-js-sdk/lib/testing.js";
import { installTestCryptoDatabase } from "../crypto/crypto-db-test-fixture.mjs";

const SELF = "@matrix:example.org";
const DEVICE = "DEVICE";
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
const channelDir = fileURLToPath(new URL("../", import.meta.url));
const cryptoStateDirs = [];
function makeCryptoStateDir(label) {
  const root = mkdtempSync(join(tmpdir(), `letta-matrix-plugin-${label}-`));
  cryptoStateDirs.push(root);
  return join(root, "state");
}

mkdirSync(runtime, { recursive: true });
writeFileSync(new URL("package.json", runtime), '{"type":"commonjs"}\n');
mkdirSync(new URL("node_modules/matrix-js-sdk/", runtime), { recursive: true });
writeFileSync(
  new URL("node_modules/matrix-js-sdk/index.js", runtime),
  "module.exports = { createClient: (...args) => globalThis.__matrixCreateClient(...args) };\n",
);

function makeClient(overrides = {}) {
  let txnCounter = 0;
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
    makeTxnId: () => `mtest.${txnCounter++}`,
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
    getRoom: () => ({
      currentState: { getStateEvents: () => null },
    }),
    ...overrides,
  };
  return client;
}

function room(extra = {}) {
  return { roomId: ROOM, name: "Matrix Test Room", getMember: () => ({ name: "Test User" }), ...extra };
}

function encryptedRoom(extra = {}) {
  return room({
    hasEncryptionStateEvent: () => true,
    currentState: {
      getStateEvents: (type, key) => (
        type === "m.room.encryption" && key === "" ? { type } : null
      ),
    },
    ...extra,
  });
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

function encryptedMessageEvent(id, body, { state = "pending", sender = SENDER } = {}) {
  let currentState = state;
  let currentBody = body;
  let failureReason = null;
  const event = {
    getType: () => (currentState === "pending" ? "m.room.encrypted" : "m.room.message"),
    getWireType: () => "m.room.encrypted",
    getContent: () => (
      currentState === "decrypted"
        ? { msgtype: "m.text", body: currentBody }
        : { msgtype: "m.bad.encrypted", body: "synthetic decryption placeholder" }
    ),
    getId: () => id,
    getRoomId: () => ROOM,
    getSender: () => sender,
    getTs: () => 1_700_000_000_000,
    getUnsigned: () => ({}),
    isDecryptionFailure: () => currentState === "failure",
    emitDecryption({ decryptedBody, reason, error } = {}) {
      if (reason) {
        currentState = "failure";
        failureReason = reason;
      } else {
        currentState = "decrypted";
        failureReason = null;
        if (typeof decryptedBody === "string") currentBody = decryptedBody;
      }
      return error;
    },
  };
  Object.defineProperty(event, "decryptionFailureReason", {
    get: () => failureReason,
  });
  return event;
}

async function emit(client, event, target = room()) {
  for (const handler of [...(client.handlers.get("Room.timeline") ?? [])]) {
    await handler(event, target, false, false, { liveEvent: true });
  }
}

async function emitDecryption(client, event, update) {
  const error = event.emitDecryption(update);
  for (const handler of [...(client.handlers.get("Event.decrypted") ?? [])]) {
    await handler(event, error);
  }
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const { channelPlugin, installMatrixSyncLoopTracking } = await import("../plugin.mjs");

function makeAdapter({ config = {}, client: clientOverrides = {} } = {}) {
  const client = makeClient(clientOverrides);
  const createOptions = [];
  globalThis.__matrixCreateClient = (options) => {
    createOptions.push(options);
    return client;
  };
  const adapter = channelPlugin.createAdapter({ accountId: "main", config: { ...BASE_CONFIG, ...config } });
  const inbound = [];
  adapter.onMessage = async (message) => inbound.push(message);
  return { adapter, client, inbound, getCreateOptions: () => createOptions };
}

function makeFactoryAdapter({ clients, accountId = "main", config = {} }) {
  let createCount = 0;
  const createOptions = [];
  globalThis.__matrixCreateClient = (options) => {
    createOptions.push(options);
    const client = clients[createCount];
    createCount += 1;
    if (!client) throw new Error("Matrix test client factory exhausted");
    return client;
  };
  const adapter = channelPlugin.createAdapter({
    accountId,
    config: { ...BASE_CONFIG, ...config },
  });
  const inbound = [];
  adapter.onMessage = async (message) => inbound.push(message);
  return {
    adapter,
    inbound,
    getCreateCount: () => createCount,
    getCreateOptions: () => createOptions,
  };
}

function makeEncryptedClient(overrides = {}) {
  const initRustCrypto = overrides.initRustCrypto;
  const client = makeClient({
    ...overrides,
    ...(Object.hasOwn(overrides, "initRustCrypto")
      ? {
          initRustCrypto: async (...args) => {
            await initRustCrypto(...args);
            await installTestCryptoDatabase();
          },
        }
      : {}),
  });
  if (!overrides.whoami) {
    client.whoami = async () => {
      client.calls.push("whoami");
      return { user_id: SELF, device_id: DEVICE };
    };
  }
  if (!overrides.getCrypto) {
    client.getCrypto = () => ({
      getEncryptionInfoForEvent: async () => ({
        shieldColour: 0,
        shieldReason: null,
      }),
      getUserVerificationStatus: async () => ({
        isVerified: () => true,
        needsUserApproval: false,
      }),
    });
  }
  return client;
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
  await test("sync-loop tracking retains a settled loop for shutdown", async () => {
    class TestSyncApi {
      sync() {
        return Promise.resolve("settled");
      }
    }
    installMatrixSyncLoopTracking(TestSyncApi);
    const syncApi = new TestSyncApi();
    const loop = syncApi.sync();
    await loop;
    assert.equal(
      syncApi[Symbol.for("letta.matrix.syncLoopPromise")],
      loop,
    );
  });

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

  await test("fails specifically when encrypted whoami omits the device ID", async () => {
    let cryptoStarted = false;
    const client = makeClient({
      initRustCrypto: async () => {
        cryptoStarted = true;
      },
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true } },
    });
    await assert.rejects(
      () => adapter.start(),
      /Matrix whoami returned no device_id; encrypted mode requires a stable Matrix device/,
    );
    assert.equal(cryptoStarted, false);
    assert.equal(adapter.isRunning(), false);
    assert.equal(client.calls.includes("startClient"), false);
  });

  await test("fails closed when encrypted mode has no Rust crypto runtime", async () => {
    const client = makeEncryptedClient();
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true } },
    });
    await assert.rejects(() => adapter.start(), /Matrix Rust crypto is unavailable/);
    assert.equal(adapter.isRunning(), false);
    assert.equal(client.calls.includes("startClient"), false);
  });

  await test("encrypted startup binds the whoami device before Rust crypto and sync", async () => {
    const stateDir = makeCryptoStateDir("startup");
    const client = makeEncryptedClient();
    client.initRustCrypto = async (options) => {
      client.calls.push("initRustCrypto");
      assert.deepEqual(options, { useIndexedDB: true });
      assert.equal(client.deviceId, DEVICE);
      assert.equal(client.credentials.deviceId, DEVICE);
      assert.equal(client.credentials.userId, SELF);
      await installTestCryptoDatabase();
    };
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      assert.equal(adapter.isRunning(), true);
      assert.deepEqual(client.calls.slice(0, 3), ["whoami", "initRustCrypto", "startClient"]);
    } finally {
      await adapter.stop();
    }
    assert.equal(existsSync(join(stateDir, "crypto-identity.json")), true);
    assert.equal(existsSync(join(stateDir, "crypto-idb.snapshot")), true);
  });

  await test("Desktop SIGTERM stays handled until encrypted cleanup settles", async () => {
    const priorDesktopMode = process.env.LETTA_DESKTOP_MODE;
    const baselineHandlers = process.listeners("SIGTERM");
    process.env.LETTA_DESKTOP_MODE = "1";
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      accountId: "desktop-sigterm",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("desktop-sigterm"),
        },
      },
    });
    let hostStopPromise;
    let observedSignalHandlerCount = null;
    const hostHandler = () => {
      hostStopPromise = made.adapter.stop();
    };
    const signalExitLikeHandler = () => {
      const testHandlers = process.listeners("SIGTERM")
        .filter((handler) => !baselineHandlers.includes(handler));
      observedSignalHandlerCount = testHandlers.length;
    };
    try {
      await made.adapter.start();
      const guard = made.adapter.desktopSigtermHandler;
      assert.equal(typeof guard, "function");
      const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(
        made.adapter.cryptoRuntime,
      );
      let runtimeStopCalls = 0;
      made.adapter.cryptoRuntime.stop = async () => {
        runtimeStopCalls += 1;
        if (runtimeStopCalls === 1) {
          const error = new Error("transient Desktop crypto cleanup failure");
          error.matrixCryptoRuntimeStopRetryable = true;
          error.matrixCryptoOwnershipRetained = true;
          throw error;
        }
        return await realRuntimeStop();
      };
      process.once("SIGTERM", hostHandler);
      process.on("SIGTERM", signalExitLikeHandler);

      process.emit("SIGTERM");
      await hostStopPromise;

      assert.equal(observedSignalHandlerCount, 2);
      assert.equal(runtimeStopCalls, 2);
      assert.equal(made.adapter.desktopSigtermHandler, null);
      assert.equal(
        process.listeners("SIGTERM").includes(guard),
        false,
      );
      assert.equal(client.calls.filter((call) => call === "stopClient").length, 1);
    } finally {
      process.removeListener("SIGTERM", hostHandler);
      process.removeListener("SIGTERM", signalExitLikeHandler);
      if (priorDesktopMode === undefined) delete process.env.LETTA_DESKTOP_MODE;
      else process.env.LETTA_DESKTOP_MODE = priorDesktopMode;
      await made.adapter.stop();
    }
  });

  await test("Desktop SIGTERM releases its guard after exhausted cleanup retries", async () => {
    const priorDesktopMode = process.env.LETTA_DESKTOP_MODE;
    process.env.LETTA_DESKTOP_MODE = "1";
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      accountId: "desktop-sigterm-retry",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("desktop-sigterm-retry"),
        },
      },
    });
    const originalConsoleError = console.error;
    try {
      await made.adapter.start();
      const guard = made.adapter.desktopSigtermHandler;
      const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(
        made.adapter.cryptoRuntime,
      );
      let runtimeStopCalls = 0;
      made.adapter.cryptoRuntime.stop = async () => {
        runtimeStopCalls += 1;
        if (runtimeStopCalls <= 3) {
          const error = new Error("transient Desktop crypto cleanup failure");
          error.matrixCryptoRuntimeStopRetryable = true;
          error.matrixCryptoOwnershipRetained = true;
          throw error;
        }
        return await realRuntimeStop();
      };

      console.error = () => {};
      guard();
      const signalStop = made.adapter.lifecyclePromise;
      await assert.rejects(
        signalStop,
        /transient Desktop crypto cleanup failure/,
      );
      await Promise.resolve();
      assert.equal(made.adapter.desktopSigtermHandler, null);
      assert.equal(process.listeners("SIGTERM").includes(guard), false);
      assert.equal(runtimeStopCalls, 3);
      assert.equal(made.adapter.isRunning(), true);

      await made.adapter.stop();
      assert.equal(runtimeStopCalls, 4);
      assert.equal(made.adapter.desktopSigtermHandler, null);
      assert.equal(process.listeners("SIGTERM").includes(guard), false);
    } finally {
      console.error = originalConsoleError;
      if (priorDesktopMode === undefined) delete process.env.LETTA_DESKTOP_MODE;
      else process.env.LETTA_DESKTOP_MODE = priorDesktopMode;
      await made.adapter.stop();
    }
  });

  await test("Desktop SIGTERM retries wrapped cancellation cleanup", async () => {
    const priorDesktopMode = process.env.LETTA_DESKTOP_MODE;
    process.env.LETTA_DESKTOP_MODE = "1";
    const stateDir = makeCryptoStateDir("desktop-sigterm-cancel-retry");
    let enteredStartClient;
    let releaseStartClient;
    const startClientEntered = new Promise((resolveEntered) => {
      enteredStartClient = resolveEntered;
    });
    const startClientGate = new Promise((resolveStartClient) => {
      releaseStartClient = resolveStartClient;
    });
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      startClient: async () => {
        client.calls.push("startClient");
        enteredStartClient();
        await startClientGate;
      },
    });
    const made = makeFactoryAdapter({
      clients: [client],
      accountId: "desktop-sigterm-cancel-retry",
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      const starting = made.adapter.start();
      await startClientEntered;
      const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(
        made.adapter.cryptoRuntime,
      );
      let runtimeStopCalls = 0;
      made.adapter.cryptoRuntime.stop = async () => {
        runtimeStopCalls += 1;
        if (runtimeStopCalls === 1) {
          const error = new Error("transient cancelled-start release failure");
          error.matrixCryptoRuntimeStopRetryable = true;
          error.matrixCryptoOwnershipRetained = true;
          throw error;
        }
        return await realRuntimeStop();
      };

      made.adapter.desktopSigtermHandler();
      releaseStartClient();
      await starting;

      assert.equal(runtimeStopCalls, 2);
      assert.equal(made.adapter.isRunning(), false);
      assert.equal(made.adapter.desktopSigtermHandler, null);
      assert.equal(client.calls.filter((call) => call === "stopClient").length, 1);
    } finally {
      releaseStartClient?.();
      if (priorDesktopMode === undefined) delete process.env.LETTA_DESKTOP_MODE;
      else process.env.LETTA_DESKTOP_MODE = priorDesktopMode;
      await made.adapter.stop();
    }
  });

  await test("encrypted startup only enables an existing backup and installs secret-storage callbacks", async () => {
    const stateDir = makeCryptoStateDir("backup-startup");
    const calls = [];
    const backupInfo = {
      version: "4\u009b[2Kforged",
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      auth_data: { public_key: "public" },
      count: 2,
    };
    const crypto = {
      checkKeyBackupAndEnable: async () => {
        calls.push("checkKeyBackupAndEnable");
        return {
          backupInfo,
          trustInfo: { trusted: true, matchesDecryptionKey: false },
        };
      },
      isKeyBackupTrusted: async () => ({ trusted: true, matchesDecryptionKey: false }),
      getActiveSessionBackupVersion: async () => backupInfo.version,
      getSessionBackupPrivateKey: async () => null,
      isSecretStorageReady: async () => false,
      isCrossSigningReady: async () => false,
      getCrossSigningStatus: async () => ({ privateKeysInSecretStorage: false }),
      getDeviceVerificationStatus: async () => ({
        signedByOwner: false,
        crossSigningVerified: false,
        localVerified: false,
      }),
      bootstrapSecretStorage: async () => calls.push("bootstrapSecretStorage"),
      resetKeyBackup: async () => calls.push("resetKeyBackup"),
    };
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => crypto,
      getKeyBackupVersion: async () => backupInfo,
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const originalWarn = console.warn;
    const warningLines = [];
    try {
      console.warn = (...args) => warningLines.push(args.map(String).join(" "));
      await made.adapter.start();
      assert.deepEqual(calls, ["checkKeyBackupAndEnable"]);
      const createOptions = made.getCreateOptions()[0];
      assert.equal(typeof createOptions.cryptoCallbacks.getSecretStorageKey, "function");
      assert.equal(typeof createOptions.cryptoCallbacks.cacheSecretStorageKey, "function");
      assert.equal(made.adapter.cryptoRecoveryStatus.serverVersion, backupInfo.version);
      assert.equal(made.adapter.cryptoRecoveryStatus.backupUsable, false);
      assert.doesNotMatch(warningLines.join("\n"), /\u009b/);
    } finally {
      console.warn = originalWarn;
      await made.adapter.stop();
    }
  });

  await test("crypto recovery timeout preserves the control guard until the operation settles", async () => {
    const stateDir = makeCryptoStateDir("control-timeout");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    let releaseOperation;
    let stopped = false;
    try {
      await made.adapter.start();
      await assert.rejects(
        () => made.adapter.runCryptoControl(
          () => new Promise((resolveOperation) => { releaseOperation = resolveOperation; }),
          { timeoutMs: 20 },
        ),
        /Matrix encryption recovery operation timed out after 20ms/,
      );
      assert.ok(made.adapter.cryptoControlPromise);
      await assert.rejects(
        () => made.adapter.runCryptoControl(async () => undefined),
        /Another Matrix encryption recovery operation is already running/,
      );
      let stopResolved = false;
      const stopping = made.adapter.stop().then(() => { stopResolved = true; });
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      assert.equal(stopResolved, false);
      releaseOperation();
      await stopping;
      stopped = true;
      assert.equal(made.adapter.cryptoControlPromise, null);
    } finally {
      releaseOperation?.();
      if (!stopped) await made.adapter.stop();
    }
  });

  await test("recovery readiness waits for the initial sync boundary", async () => {
    const stateDir = makeCryptoStateDir("initial-sync-ready");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await made.adapter.start();
      let ready = false;
      const waiting = made.adapter.waitForInitialSync({ timeoutMs: 1_000 }).then(() => {
        ready = true;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      assert.equal(ready, false);
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      await waiting;
      assert.equal(ready, true);
    } finally {
      await made.adapter.stop();
    }
  });

  await test("recovery readiness rejects a timeout and a stopped lifecycle", async () => {
    const timeoutClient = makeEncryptedClient({ initRustCrypto: async () => {} });
    const timeoutAdapter = makeFactoryAdapter({
      clients: [timeoutClient],
      config: { encryption: { enabled: true, stateDir: makeCryptoStateDir("initial-sync-timeout") } },
    }).adapter;
    await timeoutAdapter.start();
    await assert.rejects(
      () => timeoutAdapter.waitForInitialSync({ timeoutMs: 20 }),
      /Matrix initial sync timed out after 20ms/,
    );
    await timeoutAdapter.stop();

    const stoppedClient = makeEncryptedClient({ initRustCrypto: async () => {} });
    const stoppedAdapter = makeFactoryAdapter({
      clients: [stoppedClient],
      config: { encryption: { enabled: true, stateDir: makeCryptoStateDir("initial-sync-stopped") } },
    }).adapter;
    await stoppedAdapter.start();
    const waiting = stoppedAdapter.waitForInitialSync({ timeoutMs: 1_000 });
    const rejected = assert.rejects(
      () => waiting,
      /Matrix adapter changed while waiting for initial sync/,
    );
    await stoppedAdapter.stop();
    await rejected;
  });

  await test("encrypted stop drains all pinned SDK crypto workers before closing Rust", async () => {
    const order = [];
    let syncState = "SYNCING";
    let releaseBackup;
    const backupGate = new Promise((resolveBackup) => { releaseBackup = resolveBackup; });
    let releaseBackupCheck;
    const backupCheckGate = new Promise((resolveCheck) => { releaseBackupCheck = resolveCheck; });
    let releaseBackupDownload;
    const backupDownloadGate = new Promise((resolveDownload) => {
      releaseBackupDownload = resolveDownload;
    });
    let releaseBackupDownloadCheck;
    const backupDownloadCheckGate = new Promise((resolveCheck) => {
      releaseBackupDownloadCheck = resolveCheck;
    });
    let releaseKeyClaim;
    const keyClaimGate = new Promise((resolveKeyClaim) => { releaseKeyClaim = resolveKeyClaim; });
    let releaseOutgoing;
    const outgoingGate = new Promise((resolveOutgoing) => { releaseOutgoing = resolveOutgoing; });
    const crypto = {
      backupManager: {
        stopped: false,
        backupKeysLoopRunning: true,
        keyBackupCheckInProgress: null,
        stop() {
          this.stopped = true;
          order.push("backup-stop");
          void backupGate.then(() => {
            const pending = backupCheckGate.finally(() => {
              if (this.keyBackupCheckInProgress === pending) {
                this.keyBackupCheckInProgress = null;
              }
            });
            this.keyBackupCheckInProgress = pending;
            this.backupKeysLoopRunning = false;
          });
        },
      },
      perSessionBackupDownloader: {
        stopped: false,
        downloadLoopRunning: true,
        currentBackupVersionCheck: null,
        stop() {
          this.stopped = true;
          order.push("backup-download-stop");
          void backupDownloadGate.then(() => {
            const pending = backupDownloadCheckGate.finally(() => {
              if (this.currentBackupVersionCheck === pending) {
                this.currentBackupVersionCheck = null;
              }
            });
            this.currentBackupVersionCheck = pending;
            this.downloadLoopRunning = false;
          });
        },
      },
      keyClaimManager: {
        stopped: false,
        currentClaimPromise: keyClaimGate,
        stop() {
          this.stopped = true;
          order.push("key-claim-stop");
        },
      },
      outgoingRequestsManager: {
        stopped: false,
        outgoingRequestLoopRunning: true,
        stop() {
          this.stopped = true;
          order.push("outgoing-stop");
          void outgoingGate.then(() => {
            this.outgoingRequestLoopRunning = false;
          });
        },
      },
    };
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => crypto,
      http: { abort: () => { order.push("http-abort"); } },
      stopClient: async () => { order.push("stopClient"); },
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir: makeCryptoStateDir("sync-stop-drain") } },
    });
    await made.adapter.start();
    client.syncApi = {
      running: true,
      getSyncState: () => syncState,
      stop() {
        this.running = false;
        order.push("sync-stop");
      },
      retryImmediately() { order.push("sync-retry"); },
    };
    const stopping = made.adapter.stop();
    await waitUntil(() => order.includes("sync-stop"), "sync drain start");
    assert.deepEqual(order, ["sync-stop", "sync-retry", "http-abort"]);
    assert.equal(order.includes("stopClient"), false);
    syncState = "STOPPED";
    for (const handler of [...(client.handlers.get("sync") ?? [])]) handler("STOPPED");
    await waitUntil(() => order.includes("backup-stop"), "backup crypto drain start");
    assert.equal(order.includes("backup-download-stop"), true);
    assert.equal(order.includes("key-claim-stop"), true);
    assert.equal(order.includes("outgoing-stop"), true);
    assert.equal(order.includes("http-abort"), true);
    assert.equal(order.includes("stopClient"), false);
    releaseBackup();
    releaseBackupDownload();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(order.includes("stopClient"), false);
    releaseBackupCheck();
    releaseBackupDownloadCheck();
    releaseKeyClaim();
    releaseOutgoing();
    await stopping;
    assert.deepEqual(order, [
      "sync-stop",
      "sync-retry",
      "http-abort",
      "backup-stop",
      "backup-download-stop",
      "key-claim-stop",
      "outgoing-stop",
      "http-abort",
      "stopClient",
    ]);
  });

  await test("encrypted stop quarantines without closing Rust after a backup-drain timeout", async () => {
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => ({
        backupManager: {
          stopped: false,
          backupKeysLoopRunning: true,
          keyBackupCheckInProgress: null,
          stop() { this.stopped = true; },
        },
      }),
      http: { abort() {} },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient],
      accountId: "backup-drain-timeout",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("backup-drain-timeout"),
        },
      },
    });
    await made.adapter.start();
    const runtime = made.adapter.cryptoRuntime;
    const realRuntimeStop = runtime.stop.bind(runtime);
    let quarantineCalls = 0;
    runtime.quarantine = async () => {
      quarantineCalls += 1;
      await realRuntimeStop();
    };
    const realDrain = made.adapter.drainClientCryptoWork.bind(made.adapter);
    made.adapter.drainClientCryptoWork = (drainClient) => realDrain(
      drainClient,
      { timeoutMs: 20 },
    );

    await assert.rejects(
      () => made.adapter.stop(),
      /Matrix crypto backup shutdown timed out after 20ms/,
    );
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 0);
    assert.equal(quarantineCalls, 1);
    assert.equal(made.adapter.isRunning(), false);
  });

  await test("encrypted stop drains a pre-PREPARED initial sync before closing Rust", async () => {
    const order = [];
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      stopClient: async () => {
        client.clientRunning = false;
        order.push("stopClient");
      },
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("initial-sync-stop-drain"),
        },
      },
    });
    await made.adapter.start();
    client.clientRunning = true;
    client.syncApi = {
      running: true,
      catchingUp: true,
      currentSyncRequest: Promise.resolve(),
      getSyncState: () => null,
      stop() {
        this.running = false;
        order.push("sync-stop");
      },
      retryImmediately() {},
    };
    const stopping = made.adapter.stop();
    await waitUntil(() => order.includes("sync-stop"), "initial sync drain start");
    assert.equal(order.includes("stopClient"), false);
    for (const handler of [...(client.handlers.get("sync") ?? [])]) handler("STOPPED");
    await stopping;
    assert.deepEqual(order, ["sync-stop", "stopClient"]);
  });

  await test("encrypted stop quarantines without closing Rust after a sync-drain timeout", async () => {
    const firstClient = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [firstClient],
      accountId: "sync-drain-timeout",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("sync-drain-timeout"),
        },
      },
    });
    await made.adapter.start();
    firstClient.syncApi = {
      running: true,
      getSyncState: () => "SYNCING",
      stop() { this.running = false; },
      retryImmediately() {},
    };
    const runtime = made.adapter.cryptoRuntime;
    const realRuntimeStop = runtime.stop.bind(runtime);
    let quarantineCalls = 0;
    runtime.quarantine = async () => {
      quarantineCalls += 1;
      await realRuntimeStop();
    };
    const realDrain = made.adapter.drainClientCryptoWork.bind(made.adapter);
    made.adapter.drainClientCryptoWork = (drainClient) => realDrain(
      drainClient,
      { timeoutMs: 20 },
    );

    await assert.rejects(
      () => made.adapter.stop(),
      /Matrix sync drain timed out after 20ms/,
    );
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 0);
    assert.equal(quarantineCalls, 1);
    assert.equal(made.adapter.isRunning(), false);
    await assert.rejects(
      () => made.adapter.start(),
      /cannot restart after failed lifecycle cleanup/,
    );
  });

  await test("encrypted stop quarantines without closing Rust after an outgoing-drain timeout", async () => {
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => ({
        outgoingRequestsManager: {
          stopped: true,
          outgoingRequestLoopRunning: true,
          stop() { this.stopped = true; },
        },
      }),
      http: { abort() {} },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient],
      accountId: "outgoing-drain-timeout",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("outgoing-drain-timeout"),
        },
      },
    });
    await made.adapter.start();
    const runtime = made.adapter.cryptoRuntime;
    const realRuntimeStop = runtime.stop.bind(runtime);
    let quarantineCalls = 0;
    runtime.quarantine = async () => {
      quarantineCalls += 1;
      await realRuntimeStop();
    };
    const realDrain = made.adapter.drainClientCryptoWork.bind(made.adapter);
    made.adapter.drainClientCryptoWork = (drainClient) => realDrain(
      drainClient,
      { timeoutMs: 20 },
    );

    await assert.rejects(
      () => made.adapter.stop(),
      /Matrix crypto outgoing-request shutdown timed out after 20ms/,
    );
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 0);
    assert.equal(quarantineCalls, 1);
    assert.equal(made.adapter.isRunning(), false);
  });

  await test("encrypted stop drains live sync loops in recovery states", async () => {
    for (const state of ["ERROR", "RECONNECTING"]) {
      const firstClient = makeEncryptedClient({ initRustCrypto: async () => {} });
      const secondClient = makeEncryptedClient({ initRustCrypto: async () => {} });
      const made = makeFactoryAdapter({
        clients: [firstClient, secondClient],
        accountId: `inactive-sync-${state.toLowerCase()}`,
        config: {
          encryption: {
            enabled: true,
            stateDir: makeCryptoStateDir(`inactive-sync-${state.toLowerCase()}`),
          },
        },
      });
      await made.adapter.start();
      let syncStopCalls = 0;
      firstClient.syncApi = {
        running: true,
        getSyncState: () => state,
        stop() {
          this.running = false;
          syncStopCalls += 1;
        },
        retryImmediately() {},
      };
      const realDrain = made.adapter.drainClientCryptoWork.bind(made.adapter);
      made.adapter.drainClientCryptoWork = (drainClient) => realDrain(
        drainClient,
        { timeoutMs: 20 },
      );
      const stopping = made.adapter.stop();
      await waitUntil(() => syncStopCalls === 1, `${state} sync drain start`);
      assert.equal(firstClient.calls.includes("stopClient"), false);
      for (const handler of [...(firstClient.handlers.get("sync") ?? [])]) handler("STOPPED");
      await stopping;
      assert.equal(syncStopCalls, 1, state);
      assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
      try {
        await made.adapter.start();
        assert.equal(made.getCreateCount(), 2);
      } finally {
        await made.adapter.stop();
      }
    }
  });

  await test("encrypted stop accepts a tracked sync loop settling without STOPPED", async () => {
    let settleLoop;
    const loop = new Promise((resolveLoop) => { settleLoop = resolveLoop; });
    const firstClient = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [firstClient],
      accountId: "settled-sync-loop",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("settled-sync-loop"),
        },
      },
    });
    await made.adapter.start();
    firstClient.syncApi = {
      running: true,
      getSyncState: () => "ERROR",
      stop() { this.running = false; },
      retryImmediately() { settleLoop(); },
      [Symbol.for("letta.matrix.syncLoopPromise")]: loop,
    };
    await made.adapter.stop();
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
  });

  await test("encrypted stop skips a sync loop that is already not running", async () => {
    const firstClient = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [firstClient],
      accountId: "inactive-sync-loop",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("inactive-sync-loop"),
        },
      },
    });
    await made.adapter.start();
    let syncStopCalls = 0;
    firstClient.syncApi = {
      running: false,
      getSyncState: () => "ERROR",
      stop() { syncStopCalls += 1; },
      retryImmediately() {},
    };
    await made.adapter.stop();
    assert.equal(syncStopCalls, 0);
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
  });

  await test("cancelled startup quarantines without closing Rust after an unsafe drain failure", async () => {
    let enteredStartClient;
    let releaseStartClient;
    const startClientEntered = new Promise((resolveEntered) => {
      enteredStartClient = resolveEntered;
    });
    const startClientGate = new Promise((resolveStartClient) => {
      releaseStartClient = resolveStartClient;
    });
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      startClient: async () => {
        firstClient.calls.push("startClient");
        enteredStartClient();
        await startClientGate;
      },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient],
      accountId: "startup-drain-failure",
      config: {
        encryption: {
          enabled: true,
          stateDir: makeCryptoStateDir("startup-drain-failure"),
        },
      },
    });
    const starting = made.adapter.start();
    await startClientEntered;
    const runtime = made.adapter.cryptoRuntime;
    const realRuntimeStop = runtime.stop.bind(runtime);
    let quarantineCalls = 0;
    runtime.quarantine = async () => {
      quarantineCalls += 1;
      await realRuntimeStop();
    };
    made.adapter.drainClientCryptoWork = async () => {
      throw new Error("startup crypto drain failed");
    };
    const stopping = made.adapter.stop();
    releaseStartClient();
    const results = await Promise.allSettled([starting, stopping]);
    assert.equal(results.every(({ status }) => status === "rejected"), true);
    assert.match(String(results[0].reason), /Matrix cancelled startup cleanup failed/);
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 0);
    assert.equal(quarantineCalls, 1);
    await assert.rejects(
      () => made.adapter.start(),
      /cannot restart after failed lifecycle cleanup/,
    );
  });

  await test("encrypted incremental sync checkpoints before acknowledging crypto state", async () => {
    const stateDir = makeCryptoStateDir("sync-barriers");
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const { adapter } = made;
    const originalError = console.error;
    try {
      await adapter.start();
      const fetchFn = made.getCreateOptions()[0].fetchFn;
      const order = [];
      adapter.cryptoRuntime.persist = async () => {
        order.push("persist");
      };
      adapter.networkFetch = async () => {
        order.push("fetch");
        return { ok: true };
      };

      await fetchFn("https://example.org/_matrix/client/v3/sync?timeout=30000");
      assert.deepEqual(order, ["fetch"], "initial sync has no prior crypto response to acknowledge");
      order.length = 0;
      await fetchFn(
        "https://example.org/_matrix/client/v3/sync?since=next_batch_1&timeout=30000",
      );
      assert.deepEqual(order, ["persist", "fetch"]);
      order.length = 0;

      console.error = () => {};
      adapter.cryptoRuntime.persist = async () => {
        order.push("persist-failed");
        throw new Error("injected sync checkpoint failure");
      };
      await assert.rejects(
        () => fetchFn(
          "https://example.org/_matrix/client/v3/sync?since=next_batch_2&timeout=30000",
        ),
        /refusing Matrix incremental sync without current persisted crypto state/,
      );
      assert.deepEqual(order, ["persist-failed"], "failed persistence prevents sync acknowledgement");
    } finally {
      console.error = originalError;
      await adapter.stop();
    }
  });

  await test("default crypto state is durable beside runtime", async () => {
    const accountId = `default-${process.pid}-${Date.now()}`;
    const expected = resolve(channelDir, "state", accountId);
    const disposable = resolve(channelDir, "runtime", "state", accountId);
    cryptoStateDirs.push(expected);
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      accountId,
      config: { encryption: { enabled: true } },
    });
    try {
      await adapter.start();
    } finally {
      await adapter.stop();
    }
    assert.equal(existsSync(join(expected, "crypto-idb.snapshot")), true);
    assert.equal(existsSync(disposable), false);
  });

  await test("unsafe account IDs use a collision-free default state component", async () => {
    const accountId = "/";
    const expected = resolve(channelDir, "state", "~Lw");
    const literalCollision = resolve(channelDir, "state", "account-Lw");
    cryptoStateDirs.push(expected);
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      accountId,
      config: { encryption: { enabled: true } },
    });
    try {
      await adapter.start();
    } finally {
      await adapter.stop();
    }
    assert.equal(existsSync(join(expected, "crypto-identity.json")), true);
    assert.equal(existsSync(literalCollision), false);
  });

  await test("relative crypto state paths resolve from the channel directory", async () => {
    const segment = `relative-${process.pid}-${Date.now()}`;
    const configured = `state/${segment}`;
    const expected = resolve(channelDir, configured);
    const cwdRelative = resolve(configured);
    cryptoStateDirs.push(expected);
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir: configured } },
    });
    try {
      await adapter.start();
    } finally {
      await adapter.stop();
    }
    assert.equal(existsSync(join(expected, "crypto-identity.json")), true);
    assert.equal(existsSync(cwdRelative), false);
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
    assert.equal(adapter.isRunning(), true, "the host must stop an adapter while startup is pending");
    const stopping = adapter.stop();
    release({ user_id: SELF });
    await Promise.all([starting, stopping]);
    assert.equal(adapter.isRunning(), false);
    assert.equal(client.calls.includes("startClient"), false);
    assert.equal((client.handlers.get("Room.timeline") ?? []).length, 0);
    for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
    await emit(client, messageEvent("$during", "matrix hi"));
    assert.equal(inbound.length, 0);
  });

  await test("stop() during crypto startup releases state and never starts sync", async () => {
    const priorDesktopMode = process.env.LETTA_DESKTOP_MODE;
    process.env.LETTA_DESKTOP_MODE = "1";
    const stateDir = makeCryptoStateDir("cancel");
    let enteredCrypto;
    let releaseCrypto;
    const cryptoEntered = new Promise((resolveEntered) => {
      enteredCrypto = resolveEntered;
    });
    const cryptoGate = new Promise((resolveCrypto) => {
      releaseCrypto = resolveCrypto;
    });
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {
        firstClient.calls.push("initRustCrypto");
        enteredCrypto();
        await cryptoGate;
      },
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {
        secondClient.calls.push("initRustCrypto");
      },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      const starting = made.adapter.start();
      await cryptoEntered;
      assert.equal(typeof made.adapter.desktopSigtermHandler, "function");
      assert.equal(made.adapter.isRunning(), true);
      const stopping = made.adapter.stop();
      releaseCrypto();
      await Promise.all([starting, stopping]);
      assert.equal(made.adapter.desktopSigtermHandler, null);
      assert.equal(made.adapter.isRunning(), false);
      assert.equal(firstClient.calls.includes("startClient"), false);
      assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
      assert.equal((firstClient.handlers.get("Room.timeline") ?? []).length, 0);
      await made.adapter.start();
      assert.equal(made.getCreateCount(), 2);
      assert.equal(secondClient.calls.includes("startClient"), true);
      assert.equal(made.adapter.isRunning(), true);
    } finally {
      if (priorDesktopMode === undefined) delete process.env.LETTA_DESKTOP_MODE;
      else process.env.LETTA_DESKTOP_MODE = priorDesktopMode;
      releaseCrypto?.();
      await made.adapter.stop();
    }
  });

  await test("rejected crypto initialization poisons lifecycle and process ownership", async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./plugin-quarantine-child.mjs", import.meta.url))],
      { stdio: "inherit" },
    );
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
  });

  await test("stop() while startClient is pending removes listeners and releases crypto", async () => {
    const stateDir = makeCryptoStateDir("start-client-cancel");
    let enteredStartClient;
    let releaseStartClient;
    const startClientEntered = new Promise((resolveEntered) => {
      enteredStartClient = resolveEntered;
    });
    const startClientGate = new Promise((resolveStartClient) => {
      releaseStartClient = resolveStartClient;
    });
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      startClient: async () => {
        client.calls.push("startClient");
        enteredStartClient();
        await startClientGate;
      },
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const starting = made.adapter.start();
    await startClientEntered;
    const stopping = made.adapter.stop();
    for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
    await emit(client, messageEvent("$cancelled-start", "matrix should not run"));
    assert.equal(made.inbound.length, 0);
    releaseStartClient();
    await Promise.all([starting, stopping]);
    assert.equal(made.adapter.isRunning(), false);
    assert.equal(client.calls.filter((call) => call === "stopClient").length, 1);
    assert.equal((client.handlers.get("sync") ?? []).length, 0);
    assert.equal((client.handlers.get("Room.timeline") ?? []).length, 0);
  });

  await test("cancelled encrypted startup can retry only runtime cleanup", async () => {
    const stateDir = makeCryptoStateDir("cancel-runtime-retry");
    let enteredStartClient;
    let releaseStartClient;
    const startClientEntered = new Promise((resolveEntered) => {
      enteredStartClient = resolveEntered;
    });
    const startClientGate = new Promise((resolveStartClient) => {
      releaseStartClient = resolveStartClient;
    });
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      startClient: async () => {
        firstClient.calls.push("startClient");
        enteredStartClient();
        await startClientGate;
      },
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    const starting = made.adapter.start();
    await startClientEntered;
    const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(made.adapter.cryptoRuntime);
    let runtimeStopCalls = 0;
    made.adapter.cryptoRuntime.stop = async () => {
      runtimeStopCalls += 1;
      if (runtimeStopCalls === 1) {
        const error = new Error("transient cancelled-start release failure");
        error.matrixCryptoRuntimeStopRetryable = true;
        error.matrixCryptoOwnershipRetained = true;
        throw error;
      }
      return await realRuntimeStop();
    };
    const stopping = made.adapter.stop();
    releaseStartClient();
    const results = await Promise.allSettled([starting, stopping]);
    assert.equal(results.every(({ status }) => status === "rejected"), true);
    assert.match(String(results[0].reason), /cancelled startup cleanup failed/);
    await assert.rejects(
      () => made.adapter.start(),
      /cleanup is still pending/,
    );
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
    await made.adapter.stop();
    assert.equal(runtimeStopCalls, 2);
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
    try {
      await made.adapter.start();
      assert.equal(made.getCreateCount(), 2);
      assert.equal(secondClient.calls.filter((call) => call === "startClient").length, 1);
    } finally {
      await made.adapter.stop();
    }
  });

  await test("failed crypto cancellation cleanup blocks encrypted restart", async () => {
    const stateDir = makeCryptoStateDir("cancel-cleanup-failure");
    let enteredStartClient;
    let releaseStartClient;
    const startClientEntered = new Promise((resolveEntered) => {
      enteredStartClient = resolveEntered;
    });
    const startClientGate = new Promise((resolveStartClient) => {
      releaseStartClient = resolveStartClient;
    });
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      startClient: async () => {
        firstClient.calls.push("startClient");
        enteredStartClient();
        await startClientGate;
      },
      removeListener: () => {
        throw new Error("old crypto listener was not removed");
      },
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    const starting = made.adapter.start();
    await startClientEntered;
    const stopping = made.adapter.stop();
    releaseStartClient();
    const results = await Promise.allSettled([starting, stopping]);
    assert.equal(results.every(({ status }) => status === "rejected"), true);
    assert.match(String(results[0].reason), /cancelled startup cleanup failed/);
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
    await assert.rejects(
      () => made.adapter.start(),
      /cannot restart after failed lifecycle cleanup/,
    );
    assert.equal(made.getCreateCount(), 1);
  });

  await test("restart requested during crypto cancellation uses a fresh client", async () => {
    const stateDir = makeCryptoStateDir("cancel-restart");
    let enteredCrypto;
    let releaseCrypto;
    const cryptoEntered = new Promise((resolveEntered) => {
      enteredCrypto = resolveEntered;
    });
    const cryptoGate = new Promise((resolveCrypto) => {
      releaseCrypto = resolveCrypto;
    });
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {
        firstClient.calls.push("initRustCrypto");
        enteredCrypto();
        await cryptoGate;
      },
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {
        secondClient.calls.push("initRustCrypto");
      },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      const starting = made.adapter.start();
      await cryptoEntered;
      const stopping = made.adapter.stop();
      const restarting = made.adapter.start();
      releaseCrypto();
      await Promise.all([starting, stopping, restarting]);
      assert.equal(firstClient.calls.includes("startClient"), false);
      assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
      assert.equal(secondClient.calls.filter((call) => call === "startClient").length, 1);
      assert.equal(made.getCreateCount(), 2);
      assert.equal(made.adapter.isRunning(), true);
    } finally {
      releaseCrypto?.();
      await made.adapter.stop();
    }
  });

  await test("encrypted start waits for stop cleanup and recreates the client", async () => {
    const stateDir = makeCryptoStateDir("restart");
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {
        firstClient.calls.push("initRustCrypto");
      },
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {
        secondClient.calls.push("initRustCrypto");
      },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    let releaseStop;
    let stopEntered;
    const stopGate = new Promise((resolveStop) => {
      releaseStop = resolveStop;
    });
    const enteredStop = new Promise((resolveEntered) => {
      stopEntered = resolveEntered;
    });
    try {
      await made.adapter.start();
      const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(made.adapter.cryptoRuntime);
      made.adapter.cryptoRuntime.stop = async () => {
        stopEntered();
        await stopGate;
        return await realRuntimeStop();
      };
      const stopping = made.adapter.stop();
      await enteredStop;
      let restartSettled = false;
      const restarting = made.adapter.start().finally(() => {
        restartSettled = true;
      });
      await Promise.resolve();
      assert.equal(restartSettled, false);
      assert.equal(made.getCreateCount(), 1);
      releaseStop();
      await stopping;
      await restarting;
      assert.equal(made.getCreateCount(), 2);
      assert.equal(firstClient.calls.filter((call) => call === "startClient").length, 1);
      assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
      assert.equal(secondClient.calls.filter((call) => call === "startClient").length, 1);
      assert.equal((firstClient.handlers.get("Room.timeline") ?? []).length, 0);
      assert.equal((secondClient.handlers.get("Room.timeline") ?? []).length, 1);
      assert.equal(made.adapter.isRunning(), true);
    } finally {
      releaseStop?.();
      await made.adapter.stop();
    }
  });

  await test("encrypted stop retries runtime cleanup without stopping the client twice", async () => {
    const stateDir = makeCryptoStateDir("stop-retry");
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    await made.adapter.start();
    const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(made.adapter.cryptoRuntime);
    let runtimeStopCalls = 0;
    made.adapter.cryptoRuntime.stop = async () => {
      runtimeStopCalls += 1;
      if (runtimeStopCalls === 1) {
        const error = new Error("transient crypto state release failure");
        error.matrixCryptoRuntimeStopRetryable = true;
        error.matrixCryptoOwnershipRetained = true;
        throw error;
      }
      return await realRuntimeStop();
    };
    await assert.rejects(
      () => made.adapter.stop(),
      /transient crypto state release failure/,
    );
    await assert.rejects(
      () => made.adapter.start(),
      /cleanup is still pending; call stop\(\) again/,
    );
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
    await made.adapter.stop();
    assert.equal(runtimeStopCalls, 2);
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
    try {
      await made.adapter.start();
      assert.equal(made.getCreateCount(), 2);
      assert.equal(secondClient.calls.filter((call) => call === "startClient").length, 1);
    } finally {
      await made.adapter.stop();
    }
  });

  await test("a permanent runtime cleanup failure quarantines the adapter after a retry", async () => {
    const stateDir = makeCryptoStateDir("stop-retry-permanent");
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    await made.adapter.start();
    const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(
      made.adapter.cryptoRuntime,
    );
    let runtimeStopCalls = 0;
    made.adapter.cryptoRuntime.stop = async () => {
      runtimeStopCalls += 1;
      const error = new Error(
        runtimeStopCalls === 1
          ? "transient crypto cleanup failure"
          : "crypto cleanup ownership changed",
      );
      error.matrixCryptoRuntimeStopRetryable = runtimeStopCalls === 1;
      error.matrixCryptoOwnershipRetained = true;
      if (runtimeStopCalls > 1) error.matrixCryptoProcessQuarantined = true;
      throw error;
    };
    await assert.rejects(
      () => made.adapter.stop(),
      /transient crypto cleanup failure/,
    );
    await assert.rejects(
      () => made.adapter.stop(),
      /crypto cleanup ownership changed/,
    );
    assert.equal(runtimeStopCalls, 2);
    assert.equal(client.calls.filter((call) => call === "stopClient").length, 1);
    await assert.rejects(
      () => made.adapter.start(),
      /cannot restart after failed lifecycle cleanup/,
    );
    assert.equal(made.getCreateCount(), 1);
    await realRuntimeStop();
  });

  await test("a later stop cancels an encrypted restart queued behind cleanup", async () => {
    const stateDir = makeCryptoStateDir("restart-cancel");
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    let releaseStop;
    let stopEntered;
    const stopGate = new Promise((resolveStop) => {
      releaseStop = resolveStop;
    });
    const enteredStop = new Promise((resolveEntered) => {
      stopEntered = resolveEntered;
    });
    try {
      await made.adapter.start();
      const realRuntimeStop = made.adapter.cryptoRuntime.stop.bind(made.adapter.cryptoRuntime);
      made.adapter.cryptoRuntime.stop = async () => {
        stopEntered();
        await stopGate;
        return await realRuntimeStop();
      };
      const stopping = made.adapter.stop();
      await enteredStop;
      const queuedRestart = made.adapter.start();
      const finalStop = made.adapter.stop();
      releaseStop();
      await Promise.all([stopping, queuedRestart, finalStop]);
      assert.equal(made.getCreateCount(), 1);
      assert.equal(secondClient.calls.length, 0);
      assert.equal(made.adapter.isRunning(), false);
    } finally {
      releaseStop?.();
      await made.adapter.stop();
    }
  });

  await test("encrypted startup failure releases runtime ownership for a fresh client", async () => {
    const stateDir = makeCryptoStateDir("start-failure");
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {
        firstClient.calls.push("initRustCrypto");
      },
      startClient: () => {
        firstClient.calls.push("startClient");
        throw new Error("sync startup failed");
      },
    });
    const secondClient = makeEncryptedClient({
      initRustCrypto: async () => {
        secondClient.calls.push("initRustCrypto");
      },
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    await assert.rejects(() => made.adapter.start(), /sync startup failed/);
    assert.equal(firstClient.calls.filter((call) => call === "stopClient").length, 1);
    assert.equal((firstClient.handlers.get("sync") ?? []).length, 0);
    assert.equal((firstClient.handlers.get("Room.timeline") ?? []).length, 0);
    try {
      await made.adapter.start();
      assert.equal(made.getCreateCount(), 2);
      assert.equal(made.adapter.isRunning(), true);
    } finally {
      await made.adapter.stop();
    }
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

  await test("redundant start followed immediately by stop still stops", async () => {
    const { adapter, client, inbound } = await startedAdapter();
    const redundantStart = adapter.start();
    const stopping = adapter.stop();
    await Promise.all([redundantStart, stopping]);
    assert.equal(adapter.isRunning(), false);
    assert.equal(client.calls.filter((call) => call === "stopClient").length, 1);
    assert.equal((client.handlers.get("Room.timeline") ?? []).length, 0);
  });

  await test("failed plaintext listener cleanup blocks a duplicate-handler restart", async () => {
    const { adapter, client, inbound } = await startedAdapter();
    client.removeListener = () => {
      throw new Error("listener cleanup failed");
    };
    await assert.rejects(
      () => adapter.stop(),
      /Matrix client lifecycle cleanup failed/,
    );
    await assert.rejects(
      () => adapter.start(),
      /Matrix adapter cannot restart after failed lifecycle cleanup/,
    );
    for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
    await emit(client, messageEvent("$after-failed-stop", "matrix should not run"));
    assert.equal(inbound.length, 0);
    assert.equal((client.handlers.get("Room.timeline") ?? []).length, 1);
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

  await test("ignores unsafe encryption events and warns once per condition per room", async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(line);
    try {
      const { client, inbound } = await startedAdapter();
      const encrypted = messageEvent("$enc", "matrix hi", { type: "m.room.encrypted" });
      await emit(client, encrypted);
      await emit(client, messageEvent("$enc2", "matrix hi", { type: "m.room.encrypted" }));
      const quicklyDecrypted = messageEvent("$enc3", "matrix decrypted too early");
      quicklyDecrypted.getWireType = () => "m.room.encrypted";
      await emit(client, quicklyDecrypted);
      await emit(
        client,
        messageEvent("$clear-in-encrypted", "matrix injected cleartext"),
        encryptedRoom(),
      );
      await emit(
        client,
        messageEvent("$clear-in-encrypted-2", "matrix injected cleartext again"),
        encryptedRoom(),
      );
      assert.equal(inbound.length, 0);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], /ignoring E2EE event/);
      assert.match(warnings[1], /room\/wire encryption mismatch/);
    } finally {
      console.warn = warn;
    }
  });

  await test("encrypted mode delivers already-decrypted live messages with shield telemetry", async () => {
    const stateDir = makeCryptoStateDir("decrypted-inbound");
    const shieldEvents = [];
    const telemetry = [];
    const quietInfo = console.info;
    console.info = (...args) => telemetry.push(args.join(" "));
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => ({
        getEncryptionInfoForEvent: async (event) => {
          shieldEvents.push(event.getId());
          return { shieldColour: 2, shieldReason: 0 };
        },
        getUserVerificationStatus: async () => ({
          isVerified: () => false,
          wasCrossSigningVerified: () => true,
          needsUserApproval: false,
        }),
      }),
    });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const encrypted = encryptedMessageEvent("$decrypted", "matrix secret", {
        state: "decrypted",
      });
      await emit(client, encrypted, encryptedRoom());
      await waitUntil(() => inbound.length === 1, "already-decrypted delivery");
      await emit(client, encrypted, encryptedRoom());
      assert.equal(inbound.length, 1, "encrypted delivery uses the existing event-id dedupe");
      assert.deepEqual(shieldEvents, ["$decrypted"]);
      assert.match(
        telemetry.join("\n"),
        /semantics=strict colour=red reason=unverified_identity/,
      );
      assert.equal(inbound[0].text, "matrix secret");
    } finally {
      console.info = quietInfo;
      await adapter.stop();
    }
  });

  await test("encrypted inbound delivery retries at the next persisted sync boundary", async () => {
    const stateDir = makeCryptoStateDir("decrypted-inbound-checkpoint");
    const errors = [];
    const quietError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const { adapter, inbound } = made;
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const realPersist = adapter.cryptoRuntime.persist.bind(adapter.cryptoRuntime);
      adapter.cryptoRuntime.persist = async () => {
        throw new Error("synthetic checkpoint failure");
      };
      const encrypted = encryptedMessageEvent("$checkpoint-failure", "matrix secret", {
        state: "decrypted",
      });
      await emit(client, encrypted, encryptedRoom());
      await waitUntil(() => errors.length === 1, "failed inbound crypto checkpoint");
      assert.equal(inbound.length, 0);
      assert.equal(adapter.seenEventIds.has("$checkpoint-failure"), false);
      assert.equal(adapter.pendingEncryptedDeliveries.size, 1);
      assert.match(errors.join("\n"), /crypto persistence checkpoint failed/);

      const order = [];
      adapter.cryptoRuntime.persist = async () => {
        order.push("persist");
        await realPersist();
      };
      adapter.onMessage = async (message) => {
        order.push("deliver");
        inbound.push(message);
      };
      adapter.networkFetch = async () => {
        order.push("fetch");
        return { ok: true };
      };
      await made.getCreateOptions()[0].fetchFn(
        "https://example.org/_matrix/client/v3/sync?since=retry_batch&timeout=30000",
      );
      await waitUntil(
        () => (
          inbound.length === 1
          && adapter.pendingEncryptedDeliveries.size === 0
        ),
        "queued inbound replay",
      );
      assert.equal(inbound.length, 1);
      assert.equal(adapter.pendingEncryptedDeliveries.size, 0);
      assert.equal(order[0], "persist");
      assert.deepEqual(order.slice(1).sort(), ["deliver", "fetch"]);
    } finally {
      console.error = quietError;
      await adapter.stop();
    }
  });

  await test("queued inbound replay retries after the host rejects delivery", async () => {
    const stateDir = makeCryptoStateDir("decrypted-inbound-host-retry");
    const errors = [];
    const quietError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const { adapter, inbound } = made;
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      adapter.cryptoRuntime.persist = async () => {
        throw new Error("synthetic checkpoint failure");
      };
      const encrypted = encryptedMessageEvent("$queued-host-retry", "matrix retry", {
        state: "decrypted",
      });
      await emit(client, encrypted, encryptedRoom());
      await waitUntil(
        () => adapter.pendingEncryptedDeliveries.size === 1,
        "queued inbound before host retry",
      );

      let hostAttempts = 0;
      adapter.cryptoRuntime.persist = async () => {};
      adapter.onMessage = async (message) => {
        hostAttempts += 1;
        if (hostAttempts === 1) throw new Error("synthetic host rejection");
        inbound.push(message);
      };
      adapter.networkFetch = async () => ({ ok: true });
      const fetchFn = made.getCreateOptions()[0].fetchFn;
      await fetchFn(
        "https://example.org/_matrix/client/v3/sync?since=host_retry_1",
      );
      await waitUntil(
        () => (
          hostAttempts === 1
          && adapter.pendingEncryptedDeliveries.get("$queued-host-retry")?.replaying === false
        ),
        "queued inbound reset after host rejection",
      );
      assert.equal(adapter.pendingEncryptedDeliveries.size, 1);
      assert.equal(adapter.seenEventIds.has("$queued-host-retry"), false);
      assert.match(errors.join("\n"), /synthetic host rejection/);

      await fetchFn(
        "https://example.org/_matrix/client/v3/sync?since=host_retry_2",
      );
      await waitUntil(
        () => (
          inbound.length === 1
          && adapter.pendingEncryptedDeliveries.size === 0
        ),
        "queued inbound host retry delivery",
      );
      assert.equal(hostAttempts, 2);
      assert.equal(inbound[0].messageId, "$queued-host-retry");
    } finally {
      console.error = quietError;
      await adapter.stop();
    }
  });

  await test("a slow host while flushing queued inbound does not stop sync", async () => {
    const stateDir = makeCryptoStateDir("decrypted-inbound-host-failure");
    const errors = [];
    const quietError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const { adapter, inbound } = made;
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      adapter.cryptoRuntime.persist = async () => {
        throw new Error("synthetic checkpoint failure");
      };
      const encrypted = encryptedMessageEvent("$queued-host-failure", "matrix secret", {
        state: "decrypted",
      });
      await emit(client, encrypted, encryptedRoom());
      await waitUntil(
        () => adapter.pendingEncryptedDeliveries.size === 1,
        "queued inbound after checkpoint failure",
      );

      const order = [];
      let releaseHost;
      const hostReleased = new Promise((resolve) => {
        releaseHost = resolve;
      });
      adapter.cryptoRuntime.persist = async () => {
        order.push("persist");
      };
      adapter.onMessage = async () => {
        order.push("deliver");
        await hostReleased;
      };
      adapter.networkFetch = async () => {
        order.push("fetch");
        return { ok: true };
      };
      await made.getCreateOptions()[0].fetchFn(
        "https://example.org/_matrix/client/v3/sync?since=host_failure_batch",
      );
      await waitUntil(() => order.includes("deliver"), "detached queued inbound replay");
      assert.equal(order[0], "persist");
      assert.deepEqual(order.slice(1).sort(), ["deliver", "fetch"]);
      assert.equal(adapter.pendingEncryptedDeliveries.size, 1);
      releaseHost();
      await waitUntil(
        () => adapter.pendingEncryptedDeliveries.size === 0,
        "completed detached queued inbound replay",
      );
      assert.equal(adapter.pendingEncryptedDeliveries.size, 0);
      assert.equal(adapter.seenEventIds.has("$queued-host-failure"), true);
      assert.equal(inbound.length, 0);
    } finally {
      console.error = quietError;
      await adapter.stop();
    }
  });

  await test("stopping during queued replay telemetry logs the lifecycle drop", async () => {
    const stateDir = makeCryptoStateDir("decrypted-inbound-replay-stop");
    const warnings = [];
    const quietError = console.error;
    const quietWarn = console.warn;
    console.error = () => {};
    console.warn = (...args) => warnings.push(args.join(" "));
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const { adapter, inbound } = made;
    let releaseTelemetry;
    const telemetryReleased = new Promise((resolve) => {
      releaseTelemetry = resolve;
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      adapter.cryptoRuntime.persist = async () => {
        throw new Error("synthetic checkpoint failure");
      };
      const encrypted = encryptedMessageEvent(
        "$queued-replay-stop",
        "matrix replay content must not be logged",
        { state: "decrypted" },
      );
      await emit(client, encrypted, encryptedRoom());
      await waitUntil(
        () => adapter.pendingEncryptedDeliveries.size === 1,
        "queued inbound before replay",
      );

      adapter.cryptoRuntime.persist = async () => {};
      adapter.recordEncryptionTelemetry = async () => {
        await telemetryReleased;
      };
      adapter.networkFetch = async () => ({ ok: true });
      await made.getCreateOptions()[0].fetchFn(
        "https://example.org/_matrix/client/v3/sync?since=replay_stop_batch",
      );
      assert.equal(adapter.pendingEncryptedDeliveries.size, 1);
      await adapter.stop();
      releaseTelemetry();
      await waitUntil(
        () => adapter.seenEventIds.has("$queued-replay-stop") === false,
        "stale queued replay completion",
      );

      assert.equal(inbound.length, 0);
      assert.equal(adapter.pendingEncryptedDeliveries.size, 0);
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0],
        /dropping queued encrypted event account=main room=!room:example\.org event=\$queued-replay-stop reason=lifecycle-reset/,
      );
      assert.doesNotMatch(warnings[0], /matrix replay content must not be logged/);
    } finally {
      releaseTelemetry();
      console.error = quietError;
      console.warn = quietWarn;
      await adapter.stop();
    }
  });

  await test("stopping logs queued encrypted delivery loss without message content", async () => {
    const stateDir = makeCryptoStateDir("decrypted-inbound-stop-drop");
    const errors = [];
    const warnings = [];
    const quietError = console.error;
    const quietWarn = console.warn;
    console.error = (...args) => errors.push(args.join(" "));
    console.warn = (...args) => warnings.push(args.join(" "));
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      adapter.cryptoRuntime.persist = async () => {
        throw new Error("synthetic checkpoint failure");
      };
      const encrypted = encryptedMessageEvent(
        "$queued-stop-drop",
        "matrix content must not be logged",
        { state: "decrypted" },
      );
      await emit(client, encrypted, encryptedRoom());
      await waitUntil(
        () => adapter.pendingEncryptedDeliveries.size === 1,
        "queued inbound before stop",
      );

      await adapter.stop();

      assert.equal(inbound.length, 0);
      assert.equal(adapter.pendingEncryptedDeliveries.size, 0);
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0],
        /dropping queued encrypted event account=main room=!room:example\.org event=\$queued-stop-drop reason=lifecycle-reset/,
      );
      assert.doesNotMatch(warnings[0], /matrix content must not be logged/);
    } finally {
      console.error = quietError;
      console.warn = quietWarn;
      await adapter.stop();
    }
  });

  await test("encrypted mode rejects room and wire encryption mismatches", async () => {
    const stateDir = makeCryptoStateDir("inbound-encryption-mismatch");
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");

      await emit(
        client,
        messageEvent("$clear-in-encrypted", "matrix injected cleartext"),
        encryptedRoom(),
      );
      await emit(
        client,
        encryptedMessageEvent("$encrypted-in-clear", "matrix wrong state", {
          state: "decrypted",
        }),
        room(),
      );

      assert.equal(inbound.length, 0);
      assert.equal(warnings.length, 1, "mismatch diagnostics are bounded per room");
      assert.match(warnings[0], /room\/wire encryption mismatch/);
    } finally {
      console.warn = warn;
      await adapter.stop();
    }
  });

  await test("missing encrypted keys are diagnosed and a later SDK retry delivers once", async () => {
    const stateDir = makeCryptoStateDir("decryption-retry");
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const encrypted = encryptedMessageEvent("$withheld", "matrix recovered");
      await emit(client, encrypted, encryptedRoom());
      assert.equal((client.handlers.get("Event.decrypted") ?? []).length, 1);
      await emitDecryption(client, encrypted, {
        reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
        error: Object.assign(new Error("do not log this detail"), { code: "UNSAFE DETAIL" }),
      });
      await waitUntil(() => warnings.length === 1, "decryption failure diagnostic");
      assert.match(
        warnings[0],
        /room=!room:example\.org event=\$withheld reason=MEGOLM_UNKNOWN_INBOUND_SESSION_ID status=missing_key; waiting for SDK key updates/,
      );
      assert.doesNotMatch(warnings[0], /do not log this detail|synthetic decryption placeholder/);
      assert.equal(inbound.length, 0);

      await emitDecryption(client, encrypted, { decryptedBody: "matrix recovered" });
      await waitUntil(() => inbound.length === 1, "retried decryption delivery");
      await emitDecryption(client, encrypted, { decryptedBody: "matrix duplicate" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(inbound.length, 1);
      assert.equal((client.handlers.get("Event.decrypted") ?? []).length, 1);
      assert.equal(inbound[0].text, "matrix recovered");
    } finally {
      console.warn = warn;
      await adapter.stop();
    }
  });

  await test("withheld and terminal decryption failures get distinct safe diagnostics", async () => {
    const stateDir = makeCryptoStateDir("decryption-diagnostics");
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const withheld = encryptedMessageEvent("$withheld-diagnostic", "secret withheld");
      const terminal = encryptedMessageEvent("$terminal-diagnostic", "secret terminal");
      await emit(client, withheld, encryptedRoom());
      await emit(client, terminal, encryptedRoom());
      await emitDecryption(client, withheld, {
        reason: "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE",
        error: new Error("private withheld detail"),
      });
      await emitDecryption(client, terminal, {
        reason: "MEGOLM_BAD_ROOM",
        error: new Error("private terminal detail"),
      });
      await waitUntil(() => warnings.length === 2, "classified decryption diagnostics");
      assert.match(warnings[0], /reason=MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE status=withheld; no adapter retry/);
      assert.match(warnings[1], /reason=MEGOLM_BAD_ROOM status=terminal; no adapter retry/);
      assert.doesNotMatch(
        warnings.join("\n"),
        /private withheld detail|private terminal detail|secret withheld|secret terminal/,
      );
      assert.equal(inbound.length, 0);
    } finally {
      console.warn = warn;
      await adapter.stop();
    }
  });

  await test("real MatrixEvent retry emits post-decryption delivery", async () => {
    const stateDir = makeCryptoStateDir("real-event-decryption-retry");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const encrypted = await mkDecryptionFailureMatrixEvent({
        roomId: ROOM,
        sender: SENDER,
        eventId: "$real-sdk-retry",
        code: DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
        msg: "test key is not available yet",
      });
      await emit(client, encrypted, encryptedRoom());
      await decryptExistingEvent(encrypted, {
        plainType: "m.room.message",
        plainContent: { msgtype: "m.text", body: "matrix real retry" },
      });
      for (const handler of client.handlers.get("Event.decrypted") ?? []) {
        await handler(encrypted);
      }
      await waitUntil(() => inbound.length === 1, "real MatrixEvent decrypted retry");
      assert.equal(inbound[0].text, "matrix real retry");
      assert.equal((client.handlers.get("Event.decrypted") ?? []).length, 1);
    } finally {
      await adapter.stop();
    }
  });

  await test("encrypted decryption observers are removed on stop", async () => {
    const stateDir = makeCryptoStateDir("decryption-stop");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const { adapter, inbound } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    await adapter.start();
    for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
    const encrypted = encryptedMessageEvent("$pending-stop", "matrix late");
      await emit(client, encrypted, encryptedRoom());
      assert.equal((client.handlers.get("Event.decrypted") ?? []).length, 1);
      await adapter.stop();
      assert.equal((client.handlers.get("Event.decrypted") ?? []).length, 0);
      await emitDecryption(client, encrypted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inbound.length, 0);
  });

  await test("an old lifecycle cannot deliver after encrypted telemetry awaits", async () => {
    const stateDir = makeCryptoStateDir("decryption-lifecycle-race");
    let enterTelemetry;
    let releaseTelemetry;
    const telemetryEntered = new Promise((resolve) => {
      enterTelemetry = resolve;
    });
    const telemetryGate = new Promise((resolve) => {
      releaseTelemetry = resolve;
    });
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => ({
        getEncryptionInfoForEvent: async () => {
          enterTelemetry();
          await telemetryGate;
          return { shieldColour: 0, shieldReason: null };
        },
        getUserVerificationStatus: async () => ({
          isVerified: () => true,
          needsUserApproval: false,
        }),
      }),
    });
    const secondClient = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [firstClient, secondClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await made.adapter.start();
      for (const handler of firstClient.handlers.get("sync") ?? []) handler("PREPARED");
      await emit(
        firstClient,
        encryptedMessageEvent("$old-lifecycle", "matrix stale", { state: "decrypted" }),
        encryptedRoom(),
      );
      await telemetryEntered;
      await made.adapter.stop();
      await made.adapter.start();
      for (const handler of secondClient.handlers.get("sync") ?? []) handler("PREPARED");
      releaseTelemetry();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(made.inbound.length, 0);
    } finally {
      releaseTelemetry?.();
      await made.adapter.stop();
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

  await test("ack reactions never send into encrypted rooms", async () => {
    const { adapter, client, inbound } = await startedAdapter({
      config: { ackReaction: true },
      client: {
        getRoom: () => ({
          hasEncryptionStateEvent: () => true,
          currentState: {
            getStateEvents: () => null,
          },
        }),
      },
    });
    await emit(
      client,
      messageEvent("$encrypted-room-cleartext", "matrix hi"),
      encryptedRoom(),
    );
    await adapter.handleTurnLifecycleEvent({
      type: "finished",
      outcome: "completed",
      sources: [{
        channel: "matrix",
        chatId: ROOM,
        messageId: "$encrypted-room-cleartext",
      }],
    });
    assert.equal(inbound.length, 0, "cleartext injection into an encrypted room is dropped");
    assert.equal(
      client.outbound.filter(([, type]) => type === "m.reaction").length,
      0,
    );
  });

  await test("plaintext mode refuses outbound before room state is ready", async () => {
    const preSync = await startedAdapter({
      prepared: false,
      config: { ackReaction: true },
    });
    await assert.rejects(
      () => preSync.adapter.sendMessage({ chatId: ROOM, text: "too early" }),
      /before initial sync completes/,
    );
    await preSync.adapter.handleTurnLifecycleEvent({
      type: "finished",
      outcome: "completed",
      sources: [{ channel: "matrix", chatId: ROOM, messageId: "$pre-sync" }],
    });
    assert.equal(preSync.client.outbound.length, 0);
    await preSync.adapter.stop();

    const missingRoom = await startedAdapter({
      client: { getRoom: () => undefined },
    });
    await assert.rejects(
      () => missingRoom.adapter.sendMessage({ chatId: ROOM, text: "still unknown" }),
      /without loaded room state/,
    );
    assert.equal(missingRoom.client.outbound.length, 0);
    await missingRoom.adapter.stop();
  });

  await test("plaintext mode refuses outbound while synced room state is stale", async () => {
    const { adapter, client } = await startedAdapter({
      config: { ackReaction: true },
    });
    for (const state of ["RECONNECTING", "ERROR", "CATCHUP", "STOPPED"]) {
      for (const handler of client.handlers.get("sync") ?? []) handler("SYNCING");
      for (const handler of client.handlers.get("sync") ?? []) handler(state);
      await assert.rejects(
        () => adapter.sendMessage({ chatId: ROOM, text: `blocked during ${state}` }),
        /room encryption state is not fresh/,
      );
      await adapter.handleTurnLifecycleEvent({
        type: "finished",
        outcome: "completed",
        sources: [{
          channel: "matrix",
          chatId: ROOM,
          messageId: `$stale-${state}`,
        }],
      });
    }
    assert.equal(client.outbound.length, 0);
    for (const handler of client.handlers.get("sync") ?? []) handler("SYNCING");
    await adapter.sendMessage({ chatId: ROOM, text: "fresh again" });
    assert.equal(client.outbound.length, 1);
    await adapter.stop();
  });

  await test("room send boundary rejects unregistered plaintext requests", async () => {
    const made = await startedAdapter();
    let networkCalls = 0;
    try {
      made.adapter.networkFetch = async () => {
        networkCalls += 1;
        return { ok: true };
      };
      const fetchFn = made.getCreateOptions()[0].fetchFn;
      await assert.rejects(
        () => fetchFn(
          "https://example.org/_matrix/client/v3/rooms/%21room%3Aexample.org"
          + "/send/m.room.message/unregistered",
          { method: "PUT" },
        ),
        /refusing Matrix room send while lifecycle or room state is stale/,
      );
      assert.equal(networkCalls, 0);
    } finally {
      await made.adapter.stop();
    }
  });

  await test("room send boundary revalidates an in-flight stale-to-fresh transition", async () => {
    let enterSend;
    let releaseSend;
    let fetchFn;
    const sendEntered = new Promise((resolve) => {
      enterSend = resolve;
    });
    const sendGate = new Promise((resolve) => {
      releaseSend = resolve;
    });
    let networkCalls = 0;
    const made = makeAdapter({
      client: {
        sendEvent: async (chatId, eventType, content, txnId) => {
          made.client.outbound.push([chatId, eventType, content, txnId]);
          enterSend();
          await sendGate;
          await fetchFn(
            `https://example.org/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}`
            + `/send/${eventType}/${encodeURIComponent(txnId)}`,
            { method: "PUT" },
          );
          return { event_id: "$revalidated-send" };
        },
      },
    });
    try {
      await made.adapter.start();
      for (const handler of made.client.handlers.get("sync") ?? []) handler("PREPARED");
      for (const handler of made.client.handlers.get("sync") ?? []) handler("SYNCING");
      fetchFn = made.getCreateOptions()[0].fetchFn;
      made.adapter.networkFetch = async () => {
        networkCalls += 1;
        return { ok: true };
      };

      const sending = made.adapter.sendMessage({ chatId: ROOM, text: "racing state" });
      await sendEntered;
      for (const handler of made.client.handlers.get("sync") ?? []) handler("RECONNECTING");
      for (const handler of made.client.handlers.get("sync") ?? []) handler("SYNCING");
      releaseSend();
      assert.deepEqual(await sending, { messageId: "$revalidated-send" });
      assert.equal(networkCalls, 1);
    } finally {
      releaseSend?.();
      await made.adapter.stop();
    }
  });

  await test("room send boundary rejects an in-flight stale state", async () => {
    let enterSend;
    let releaseSend;
    let fetchFn;
    const sendEntered = new Promise((resolve) => {
      enterSend = resolve;
    });
    const sendGate = new Promise((resolve) => {
      releaseSend = resolve;
    });
    let networkCalls = 0;
    const made = makeAdapter({
      client: {
        sendEvent: async (chatId, eventType, content, txnId) => {
          made.client.outbound.push([chatId, eventType, content, txnId]);
          enterSend();
          await sendGate;
          await fetchFn(
            `https://example.org/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}`
            + `/send/${eventType}/${encodeURIComponent(txnId)}`,
            { method: "PUT" },
          );
          return { event_id: "$fresh-send" };
        },
      },
    });
    try {
      await made.adapter.start();
      for (const handler of made.client.handlers.get("sync") ?? []) handler("PREPARED");
      fetchFn = made.getCreateOptions()[0].fetchFn;
      made.adapter.networkFetch = async () => {
        networkCalls += 1;
        return { ok: true };
      };

      const sending = made.adapter.sendMessage({ chatId: ROOM, text: "stale at boundary" });
      await sendEntered;
      for (const handler of made.client.handlers.get("sync") ?? []) handler("RECONNECTING");
      releaseSend();
      await assert.rejects(
        () => sending,
        /refusing Matrix room send while lifecycle or room state is stale/,
      );
      assert.equal(networkCalls, 0);
    } finally {
      releaseSend?.();
      await made.adapter.stop();
    }
  });

  await test("room send boundary rejects encryption enabled during an in-flight send", async () => {
    let enterSend;
    let releaseSend;
    let fetchFn;
    let encrypted = false;
    const sendEntered = new Promise((resolve) => {
      enterSend = resolve;
    });
    const sendGate = new Promise((resolve) => {
      releaseSend = resolve;
    });
    const loadedRoom = {
      hasEncryptionStateEvent: () => encrypted,
      currentState: {
        getStateEvents: (type, key) => (
          encrypted && type === "m.room.encryption" && key === "" ? { type } : null
        ),
      },
    };
    let networkCalls = 0;
    const made = makeAdapter({
      client: {
        getRoom: () => loadedRoom,
        sendEvent: async (chatId, eventType, content, txnId) => {
          made.client.outbound.push([chatId, eventType, content, txnId]);
          enterSend();
          await sendGate;
          await fetchFn(
            `https://example.org/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}`
            + `/send/${eventType}/${encodeURIComponent(txnId)}`,
            { method: "PUT" },
          );
          return { event_id: "$should-not-send" };
        },
      },
    });
    try {
      await made.adapter.start();
      for (const handler of made.client.handlers.get("sync") ?? []) handler("PREPARED");
      fetchFn = made.getCreateOptions()[0].fetchFn;
      made.adapter.networkFetch = async () => {
        networkCalls += 1;
        return { ok: true };
      };

      const sending = made.adapter.sendMessage({ chatId: ROOM, text: "racing encryption" });
      await sendEntered;
      encrypted = true;
      releaseSend();
      await assert.rejects(
        () => sending,
        /refusing plaintext Matrix event at the encrypted-room HTTP boundary/,
      );
      assert.equal(networkCalls, 0);
    } finally {
      releaseSend?.();
      await made.adapter.stop();
    }
  });

  await test("encrypted mode refuses outbound until room encryption state is loaded", async () => {
    const stateDir = makeCryptoStateDir("outbound-gate");
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getRoom: () => undefined,
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      await assert.rejects(
        () => adapter.sendMessage({ chatId: ROOM, text: "too early" }),
        /before initial sync completes/,
      );
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      await assert.rejects(
        () => adapter.sendMessage({ chatId: ROOM, text: "still unknown" }),
        /without loaded room state/,
      );
      assert.equal(client.outbound.length, 0);
    } finally {
      await adapter.stop();
    }
  });

  await test("encrypted mode delegates encrypted-room messages to the initialized SDK", async () => {
    const stateDir = makeCryptoStateDir("encrypted-outbound");
    const cryptoApi = {};
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => cryptoApi,
      getRoom: () => ({
        hasEncryptionStateEvent: () => true,
        currentState: { getStateEvents: () => ({ type: "m.room.encryption" }) },
      }),
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const result = await adapter.sendMessage({ chatId: ROOM, text: "matrix encrypted hello" });
      assert.equal(result.messageId, "$reply");
      assert.deepEqual(client.outbound, [[
        ROOM,
        "m.room.message",
        { msgtype: "m.text", body: "matrix encrypted hello" },
        "mtest.0",
      ]]);
    } finally {
      await adapter.stop();
    }
  });

  await test("encrypted stop waits for an in-flight room encryption", async () => {
    const stateDir = makeCryptoStateDir("encrypted-send-stop-drain");
    let enterSend;
    let releaseSend;
    let sendSettled = false;
    let abortBeforeSendSettled = false;
    const sendEntered = new Promise((resolveEntered) => { enterSend = resolveEntered; });
    const sendGate = new Promise((resolveSend) => { releaseSend = resolveSend; });
    const crypto = {
      backupManager: {
        stopped: false,
        backupKeysLoopRunning: false,
        keyBackupCheckInProgress: null,
        stop() { this.stopped = true; },
      },
      perSessionBackupDownloader: {
        stopped: false,
        downloadLoopRunning: false,
        currentBackupVersionCheck: null,
        stop() { this.stopped = true; },
      },
      keyClaimManager: {
        stopped: false,
        currentClaimPromise: Promise.resolve(),
        stop() { this.stopped = true; },
      },
      outgoingRequestsManager: {
        stopped: false,
        outgoingRequestLoopRunning: false,
        stop() { this.stopped = true; },
      },
    };
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => crypto,
      http: {
        abort() {
          if (!sendSettled) abortBeforeSendSettled = true;
        },
      },
      getRoom: () => ({
        hasEncryptionStateEvent: () => true,
        currentState: { getStateEvents: () => ({ type: "m.room.encryption" }) },
      }),
      sendEvent: async () => {
        enterSend();
        await sendGate;
        sendSettled = true;
        return { event_id: "$drained" };
      },
    });
    const { adapter } = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const sending = adapter.sendMessage({ chatId: ROOM, text: "matrix wait for encryption" });
      await sendEntered;
      client.syncApi = {
        running: true,
        getSyncState: () => "SYNCING",
        stop() { this.running = false; },
        retryImmediately() {},
        [Symbol.for("letta.matrix.syncLoopPromise")]: Promise.resolve(),
      };
      const stopping = adapter.stop();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(client.calls.includes("stopClient"), false);
      assert.equal(abortBeforeSendSettled, false);
      releaseSend();
      assert.equal((await sending).messageId, "$drained");
      await stopping;
      assert.equal(abortBeforeSendSettled, false);
      assert.equal(client.calls.filter((call) => call === "stopClient").length, 1);
    } finally {
      releaseSend?.();
      await adapter.stop();
    }
  });

  await test("encrypted room-send timeout quarantines without closing Rust", async () => {
    const stateDir = makeCryptoStateDir("encrypted-send-stop-timeout");
    let enterSend;
    let releaseSend;
    let sending;
    const sendEntered = new Promise((resolveEntered) => { enterSend = resolveEntered; });
    const sendGate = new Promise((resolveSend) => { releaseSend = resolveSend; });
    const client = makeEncryptedClient({
      initRustCrypto: async () => {},
      getCrypto: () => ({
        outgoingRequestsManager: {
          stopped: false,
          outgoingRequestLoopRunning: false,
          stop() { this.stopped = true; },
        },
      }),
      http: { abort() {} },
      getRoom: () => ({
        hasEncryptionStateEvent: () => true,
        currentState: { getStateEvents: () => ({ type: "m.room.encryption" }) },
      }),
      sendEvent: async () => {
        enterSend();
        await sendGate;
        return { event_id: "$late" };
      },
    });
    const made = makeFactoryAdapter({
      clients: [client],
      accountId: "encrypted-send-stop-timeout",
      config: { encryption: { enabled: true, stateDir } },
    });
    try {
      await made.adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      sending = made.adapter.sendMessage({ chatId: ROOM, text: "matrix send timeout" });
      await sendEntered;
      const runtime = made.adapter.cryptoRuntime;
      const realRuntimeStop = runtime.stop.bind(runtime);
      let quarantineCalls = 0;
      runtime.quarantine = async () => {
        quarantineCalls += 1;
        await realRuntimeStop();
      };
      const realDrain = made.adapter.drainClientCryptoWork.bind(made.adapter);
      made.adapter.drainClientCryptoWork = (drainClient) => realDrain(
        drainClient,
        { timeoutMs: 20 },
      );

      await assert.rejects(
        () => made.adapter.stop(),
        /Matrix encrypted room-send shutdown timed out after 20ms/,
      );
      assert.equal(client.calls.filter((call) => call === "stopClient").length, 0);
      assert.equal(quarantineCalls, 1);
      await assert.rejects(
        () => made.adapter.start(),
        /cannot restart after failed lifecycle cleanup/,
      );
    } finally {
      releaseSend?.();
      await sending?.catch(() => {});
    }
  });

  await test("encrypted Matrix requests persist before reaching the network", async () => {
    const stateDir = makeCryptoStateDir("encrypted-request-barrier");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    const errors = console.error;
    try {
      await made.adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      const fetchFn = made.getCreateOptions()[0].fetchFn;
      const order = [];
      made.adapter.cryptoRuntime.persist = async () => {
        order.push("persist");
      };
      made.adapter.networkFetch = async () => {
        order.push("fetch");
        return { ok: true };
      };

      await fetchFn("https://example.org/_matrix/client/v3/sync");
      assert.deepEqual(order, ["fetch"], "ordinary requests do not force a crypto snapshot");
      order.length = 0;
      await fetchFn(
        "https://example.org/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.encrypted/txn",
        { method: "PUT" },
      );
      assert.deepEqual(order, ["persist", "fetch"]);
      order.length = 0;
      await fetchFn(
        "https://example.org/_matrix/client/v3/sendToDevice/m.room.encrypted/txn",
        { method: "PUT" },
      );
      assert.deepEqual(order, ["persist", "fetch"]);
      order.length = 0;
      await fetchFn(
        "https://example.org/_matrix/client/v3/keys/upload",
        { method: "POST" },
      );
      assert.deepEqual(order, ["persist", "fetch"]);
      order.length = 0;
      for (const [path, method] of [
        ["/_matrix/client/v3/keys/device_signing/upload", "POST"],
        ["/_matrix/client/v3/keys/signatures/upload", "POST"],
        ["/_matrix/client/v3/user/%40matrix%3Aexample.org/account_data/m.secret_storage.default_key", "PUT"],
        ["/_matrix/client/v3/room_keys/version", "POST"],
        ["/_matrix/client/v3/room_keys/keys?version=4", "PUT"],
      ]) {
        await fetchFn(`https://example.org${path}`, { method });
        assert.deepEqual(order, ["persist", "fetch"], `${path} uses a crypto write-ahead barrier`);
        order.length = 0;
      }
      await fetchFn(
        "https://example.org/_matrix/client/v3/room_keys/version",
        { method: "GET" },
      );
      assert.deepEqual(order, ["fetch"], "read-only backup status does not force a snapshot");
      order.length = 0;
      await fetchFn(
        "https://example.org/%ZZ/proxy/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.encrypted/txn",
        { method: "PUT" },
      );
      assert.deepEqual(
        order,
        ["persist", "fetch"],
        "a malformed unrelated base-path escape cannot bypass the barrier",
      );
      order.length = 0;

      made.adapter.cryptoRuntime.persist = async () => {
        order.push("persist-failed");
        throw new Error("injected write-ahead failure");
      };
      console.error = () => {};
      await assert.rejects(
        () => fetchFn(
          "https://example.org/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.encrypted/rejected",
          { method: "PUT" },
        ),
        /refusing Matrix encrypted request without a current persisted crypto runtime/,
      );
      assert.deepEqual(order, ["persist-failed"], "ciphertext never reaches fetch after a failed barrier");
      order.length = 0;
      made.adapter.cryptoRuntime.persist = async () => {
        order.push("persist-recovered");
      };
      await fetchFn(
        "https://example.org/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.encrypted/recovered",
        { method: "PUT" },
      );
      assert.deepEqual(
        order,
        ["persist-recovered", "fetch"],
        "the next product request retries the barrier after a transient failure",
      );
    } finally {
      console.error = errors;
      await made.adapter.stop();
    }
  });

  await test("stopping during an encrypted request barrier prevents the network write", async () => {
    const stateDir = makeCryptoStateDir("encrypted-request-stop-race");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    let enterBarrier;
    let releaseBarrier;
    const barrierEntered = new Promise((resolve) => {
      enterBarrier = resolve;
    });
    const barrierGate = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    let networkCalls = 0;
    try {
      await made.adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      made.adapter.cryptoRuntime.persist = async () => {
        enterBarrier();
        await barrierGate;
      };
      made.adapter.networkFetch = async () => {
        networkCalls += 1;
        return { ok: true };
      };
      const request = made.getCreateOptions()[0].fetchFn(
        "https://example.org/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.encrypted/racing",
        { method: "PUT" },
      );
      await barrierEntered;
      await made.adapter.stop();
      releaseBarrier();
      await assert.rejects(
        () => request,
        /refusing Matrix encrypted request without a current persisted crypto runtime/,
      );
      assert.equal(networkCalls, 0);
    } finally {
      releaseBarrier?.();
      await made.adapter.stop();
    }
  });

  await test("an already encrypted request may finish across a sync reconnect", async () => {
    const stateDir = makeCryptoStateDir("encrypted-request-reconnect");
    const client = makeEncryptedClient({ initRustCrypto: async () => {} });
    const made = makeFactoryAdapter({
      clients: [client],
      config: { encryption: { enabled: true, stateDir } },
    });
    let enterBarrier;
    let releaseBarrier;
    const barrierEntered = new Promise((resolve) => {
      enterBarrier = resolve;
    });
    const barrierGate = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    let networkCalls = 0;
    try {
      await made.adapter.start();
      for (const handler of client.handlers.get("sync") ?? []) handler("PREPARED");
      made.adapter.cryptoRuntime.persist = async () => {
        enterBarrier();
        await barrierGate;
      };
      made.adapter.networkFetch = async () => {
        networkCalls += 1;
        return { ok: true };
      };
      const request = made.getCreateOptions()[0].fetchFn(
        "https://example.org/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.encrypted/reconnecting",
        { method: "PUT" },
      );
      await barrierEntered;
      for (const handler of client.handlers.get("sync") ?? []) handler("RECONNECTING");
      releaseBarrier();
      await request;
      assert.equal(networkCalls, 1);
    } finally {
      releaseBarrier?.();
      await made.adapter.stop();
    }
  });

  await test("failed encrypted client stop quarantines crypto ownership until process exit", async () => {
    const stateDir = makeCryptoStateDir("stop-failure");
    const firstClient = makeEncryptedClient({
      initRustCrypto: async () => {},
      stopClient: () => {
        firstClient.calls.push("stopClient");
        throw new Error("crypto client stop failed");
      },
    });
    const replacementClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const made = makeFactoryAdapter({
      clients: [firstClient, replacementClient],
      config: { encryption: { enabled: true, stateDir } },
    });
    await made.adapter.start();
    await assert.rejects(() => made.adapter.stop(), /crypto client stop failed/);
    assert.equal(existsSync(join(stateDir, "crypto-runtime.active")), true);
    await assert.rejects(
      () => made.adapter.start(),
      /cannot restart after failed lifecycle cleanup/,
    );
    assert.equal(made.getCreateCount(), 1);

    const otherStateDir = makeCryptoStateDir("stop-failure-other");
    const otherClient = makeEncryptedClient({
      initRustCrypto: async () => {},
    });
    const other = makeFactoryAdapter({
      clients: [otherClient],
      accountId: "other",
      config: { encryption: { enabled: true, stateDir: otherStateDir } },
    });
    await assert.rejects(() => other.adapter.start(), /already running/);
    await other.adapter.stop();
    assert.equal(otherClient.calls.includes("initRustCrypto"), false);
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

  await test("completed tool progress does not restart typing after a reply", async () => {
    const { adapter, client } = await startedAdapter();
    await adapter.handleTurnProgressEvent({
      kind: "tool",
      state: "started",
      sources: [{ channel: "matrix", chatId: ROOM }],
    });
    await adapter.sendMessage({ chatId: ROOM, text: "done" });
    const typingCallsAfterReply = client.typing.length;

    await adapter.handleTurnProgressEvent({
      kind: "tool",
      state: "completed",
      sources: [{ channel: "matrix", chatId: ROOM }],
    });

    assert.equal(client.typing.length, typingCallsAfterReply);
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
  for (const stateDir of new Set(cryptoStateDirs)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
