import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "fake-indexeddb/auto";
import { installTestCryptoDatabase } from "./crypto-db-test-fixture.mjs";
import { startCryptoRuntime } from "./runtime.mjs";

const mode = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "letta-matrix-runtime-quarantine-"));
const firstState = join(root, "first");
const secondState = join(root, "second");
const identity = {
  homeserverUrl: "https://example.org/",
  userId: "@quarantine:example.org",
  deviceId: "QUARANTINE",
  accountId: "quarantine",
};

async function assertOwnershipRetained() {
  assert.equal(existsSync(join(firstState, "crypto-runtime.active")), true);
  assert.equal(existsSync(join(firstState, "crypto-idb.lock")), true);
  let retryInit = false;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "other",
      stateDir: secondState,
      identity: { ...identity, accountId: "other", deviceId: "OTHER" },
      client: {
        initRustCrypto: async () => { retryInit = true; },
        stopClient: async () => {},
      },
    }),
    /Encrypted Matrix account quarantine is already running/,
  );
  assert.equal(retryInit, false);
}

async function postInitStopFailure() {
  let stopCalls = 0;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "quarantine",
      stateDir: firstState,
      identity,
      client: {
        initRustCrypto: installTestCryptoDatabase,
        stopClient: async () => {
          stopCalls += 1;
          throw new Error("initialized crypto client did not stop");
        },
      },
      persistenceOptions: {
        setIntervalFn: () => {
          throw new Error("persistence timer setup failed");
        },
      },
    }),
    (error) => {
      assert.match(String(error), /persistence timer setup failed/);
      assert.match(
        error.errors.map((nested) => String(nested)).join("\n"),
        /initialized crypto client did not stop/,
      );
      assert.equal(error.matrixCryptoProcessQuarantined, true);
      return true;
    },
  );
  assert.equal(stopCalls, 1, "startup cleanup attempts client shutdown exactly once");
  await assertOwnershipRetained();
}

async function rejectedInitialization() {
  let stopCalls = 0;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "quarantine",
      stateDir: firstState,
      identity,
      client: {
        initRustCrypto: async () => {
          throw Object.freeze(new Error("Rust initialization rejected"));
        },
        stopClient: async () => {
          stopCalls += 1;
        },
      },
    }),
    (error) => {
      assert.match(String(error), /Rust initialization rejected/);
      assert.equal(error.matrixCryptoProcessQuarantined, true);
      return true;
    },
  );
  assert.equal(stopCalls, 1);
  await assertOwnershipRetained();
}

async function initialPersistenceFailure() {
  let stopCalls = 0;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "quarantine",
      stateDir: firstState,
      identity,
      client: {
        initRustCrypto: async () => {},
        stopClient: async () => {
          stopCalls += 1;
        },
      },
    }),
    (error) => {
      assert.match(String(error), /snapshot does not contain the pinned Matrix crypto database/);
      assert.equal(error.matrixCryptoClientStopHandled, true);
      assert.equal(error.matrixCryptoProcessQuarantined, true);
      return true;
    },
  );
  assert.equal(stopCalls, 1);
  await assertOwnershipRetained();
}

async function explicitQuarantine() {
  let timerTick;
  let timerCleared = false;
  let persistencePasses = 0;
  const runtime = await startCryptoRuntime({
    accountKey: "quarantine",
    stateDir: firstState,
    identity,
    client: {
      initRustCrypto: installTestCryptoDatabase,
      stopClient: async () => {},
    },
    persistenceOptions: {
      persistState: async () => {
        persistencePasses += 1;
      },
      setIntervalFn: (callback) => {
        timerTick = callback;
        return { unref() {} };
      },
      clearIntervalFn: () => {
        timerCleared = true;
      },
    },
  });
  await runtime.quarantine();
  assert.equal(timerCleared, true);
  assert.equal(persistencePasses, 1, "quarantine takes one serialized final checkpoint");
  timerTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistencePasses, 1, "a cleared timer cannot checkpoint after quarantine");
  await assert.rejects(() => runtime.stop(), /runtime is quarantined/);
  await assertOwnershipRetained();
}

async function finalPersistenceFailure() {
  let persistencePasses = 0;
  const runtime = await startCryptoRuntime({
    accountKey: "quarantine",
    stateDir: firstState,
    identity,
    client: {
      initRustCrypto: installTestCryptoDatabase,
      stopClient: async () => {},
    },
    persistenceOptions: {
      persistState: async () => {
        persistencePasses += 1;
        throw new Error("final snapshot failed");
      },
    },
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await assert.rejects(
      () => runtime.stop(),
      (error) => {
        assert.match(String(error), /final snapshot failed/);
        assert.equal(error.matrixCryptoRuntimeStopRetryable, true);
        assert.equal(error.matrixCryptoOwnershipRetained, true);
        return true;
      },
    );
    assert.equal(persistencePasses, attempt);
    await assertOwnershipRetained();
  }
}

async function markerOwnershipChange() {
  const runtime = await startCryptoRuntime({
    accountKey: "quarantine",
    stateDir: firstState,
    identity,
    client: {
      initRustCrypto: installTestCryptoDatabase,
      stopClient: async () => {},
    },
  });
  await writeFile(
    join(firstState, "crypto-runtime.active"),
    `${JSON.stringify({
      version: 1,
      token: "successor-marker",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => runtime.stop(),
      (error) => {
        assert.match(String(error), /marker ownership changed/);
        assert.equal(error.matrixCryptoRuntimeStopRetryable, false);
        assert.equal(error.matrixCryptoOwnershipRetained, true);
        assert.equal(error.matrixCryptoProcessQuarantined, true);
        return true;
      },
    );
  }
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "blocked-after-marker-change",
      stateDir: secondState,
      identity: {
        ...identity,
        userId: "@blocked:example.org",
        deviceId: "BLOCKED",
        accountId: "blocked",
      },
      client: {
        initRustCrypto: async () => {},
        stopClient: async () => {},
      },
    }),
    /Encrypted Matrix account quarantine is already running/,
  );
}

try {
  if (mode === "post-init-stop-failure") await postInitStopFailure();
  else if (mode === "init-rejection") await rejectedInitialization();
  else if (mode === "initial-persistence-failure") await initialPersistenceFailure();
  else if (mode === "explicit-quarantine") await explicitQuarantine();
  else if (mode === "final-persistence-failure") await finalPersistenceFailure();
  else if (mode === "marker-ownership-change") await markerOwnershipChange();
  else throw new Error(`Unknown runtime quarantine test mode: ${mode}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
