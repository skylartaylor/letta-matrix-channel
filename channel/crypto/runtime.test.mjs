import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";
import {
  installTestCryptoDatabase,
  TEST_CRYPTO_DATABASE_NAME,
} from "./crypto-db-test-fixture.mjs";
import { createCryptoPersistenceController, startCryptoRuntime } from "./runtime.mjs";

function request(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function writeProbe(value) {
  await installTestCryptoDatabase();
  const open = globalThis.indexedDB.open(TEST_CRYPTO_DATABASE_NAME, 12);
  await request(open);
  const db = open.result;
  const tx = db.transaction("core", "readwrite");
  tx.objectStore("core").put(value, "value");
  await new Promise((resolve, reject) => {
    tx.addEventListener("complete", resolve, { once: true });
    tx.addEventListener("error", () => reject(tx.error), { once: true });
  });
  db.close();
}

async function readProbe() {
  const databases = await globalThis.indexedDB.databases();
  if (!databases.some(({ name }) => name === TEST_CRYPTO_DATABASE_NAME)) return undefined;
  const db = await request(globalThis.indexedDB.open(TEST_CRYPTO_DATABASE_NAME, 12));
  const value = await request(db.transaction("core", "readonly").objectStore("core").get("value"));
  db.close();
  return value;
}

function makeRuntimeClient(initRustCrypto) {
  return {
    initRustCrypto,
    stopClient: async () => {},
  };
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const identityOne = {
  homeserverUrl: "https://example.org/",
  userId: "@one:example.org",
  deviceId: "ONE",
  accountId: "one",
};
const identityTwo = {
  homeserverUrl: "https://example.org/",
  userId: "@two:example.org",
  deviceId: "TWO",
  accountId: "two",
};
const roots = await Promise.all(
  ["a", "b", "c", "d", "e", "f", "g", "h"].map((label) => (
    mkdtemp(join(tmpdir(), `letta-matrix-crypto-${label}-`))
  )),
);
const [
  stateA,
  stateB,
  stateC,
  stateD,
  stateE,
  stateF,
  stateG,
  stateH,
] = roots.map((root) => join(root, "state"));
try {
  const calls = [];
  let scheduledTick;
  let timerCleared = false;
  let timerUnrefed = false;
  const timer = { unref: () => { timerUnrefed = true; } };
  const first = await startCryptoRuntime({
    accountKey: "one",
    stateDir: stateA,
    identity: identityOne,
    client: makeRuntimeClient(async (args) => { calls.push(args); await writeProbe("persisted"); }),
    persistenceOptions: {
      setIntervalFn: (callback, intervalMs) => {
        assert.equal(intervalMs, 60_000);
        scheduledTick = callback;
        return timer;
      },
      clearIntervalFn: (activeTimer) => {
        assert.equal(activeTimer, timer);
        timerCleared = true;
      },
    },
  });
  assert.deepEqual(calls, [{ useIndexedDB: true }]);
  assert.equal(typeof scheduledTick, "function");
  assert.equal(timerUnrefed, true);
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "two",
      stateDir: stateB,
      identity: identityTwo,
      client: makeRuntimeClient(async () => { await installTestCryptoDatabase(); }),
    }),
    /Encrypted Matrix account one is already running/,
  );
  await first.stop();
  assert.equal(timerCleared, true);
  scheduledTick();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await startCryptoRuntime({
    accountKey: "two",
    stateDir: stateB,
    identity: identityTwo,
    client: makeRuntimeClient(async () => {
      assert.equal(await readProbe(), undefined);
      await installTestCryptoDatabase();
    }),
  });
  await second.stop();
  const restored = await startCryptoRuntime({
    accountKey: "one",
    stateDir: stateA,
    identity: identityOne,
    client: makeRuntimeClient(async () => { assert.equal(await readProbe(), "persisted"); }),
  });
  await restored.stop();

  let mismatchedInit = false;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "one",
      stateDir: stateA,
      identity: { ...identityOne, deviceId: "OTHER" },
      client: makeRuntimeClient(async () => { mismatchedInit = true; }),
    }),
    /stored deviceId does not match/,
  );
  assert.equal(mismatchedInit, false, "identity mismatch rejects before crypto initialization");

  const recoverableIdentity = {
    ...identityOne,
    userId: "@recoverable:example.org",
    deviceId: "RECOVERABLE",
    accountId: "recoverable",
  };
  const recoverable = await startCryptoRuntime({
    accountKey: "recoverable",
    stateDir: stateD,
    identity: recoverableIdentity,
    client: makeRuntimeClient(async () => { await writeProbe("recoverable"); }),
  });
  await recoverable.stop();
  await writeFile(join(stateD, "crypto-idb.snapshot"), "corrupt current snapshot");
  const recoveryDiagnostics = [];
  const originalConsoleError = console.error;
  let recovered;
  try {
    console.error = (...args) => recoveryDiagnostics.push(args.join(" "));
    recovered = await startCryptoRuntime({
      accountKey: "recoverable",
      stateDir: stateD,
      identity: recoverableIdentity,
      client: makeRuntimeClient(async () => {
        assert.equal(await readProbe(), "recoverable");
      }),
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(
    recoveryDiagnostics.join("\n"),
    /current crypto snapshot was rejected; restored the previous generation/,
  );
  await recovered.stop();
  await rm(join(stateD, "crypto-idb.snapshot"));
  const missingSnapshotDiagnostics = [];
  let recoveredAfterMissingCurrent;
  try {
    console.error = (...args) => missingSnapshotDiagnostics.push(args.join(" "));
    recoveredAfterMissingCurrent = await startCryptoRuntime({
      accountKey: "recoverable",
      stateDir: stateD,
      identity: recoverableIdentity,
      client: makeRuntimeClient(async () => {
        assert.equal(await readProbe(), "recoverable");
      }),
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(
    missingSnapshotDiagnostics.join("\n"),
    /current crypto snapshot was missing; restored the previous generation/,
  );
  await recoveredAfterMissingCurrent.stop();

  let controllerTick;
  let controllerCleared = false;
  let controllerUnrefed = false;
  const releases = [];
  let persistenceCalls = 0;
  let activePersistence = 0;
  let maximumPersistence = 0;
  const controller = createCryptoPersistenceController({
    stateDir: "unused",
    persistState: async () => {
      persistenceCalls += 1;
      activePersistence += 1;
      maximumPersistence = Math.max(maximumPersistence, activePersistence);
      await new Promise((resolve) => releases.push(resolve));
      activePersistence -= 1;
    },
    setIntervalFn: (callback) => {
      controllerTick = callback;
      return { unref: () => { controllerUnrefed = true; } };
    },
    clearIntervalFn: () => { controllerCleared = true; },
  });
  assert.equal(controllerUnrefed, true);
  controllerTick();
  controllerTick();
  const barriers = Array.from({ length: 100 }, () => controller.persist());
  assert.equal(new Set(barriers).size, 1, "queued explicit barriers coalesce");
  await waitUntil(() => persistenceCalls === 1, "first interval persistence");
  releases.shift()();
  await waitUntil(() => persistenceCalls === 2, "explicit barrier persistence");
  const lateBarriers = Array.from({ length: 100 }, () => controller.persist());
  assert.equal(new Set(lateBarriers).size, 1, "barriers coalesce behind an active barrier");
  assert.notEqual(lateBarriers[0], barriers[0], "a barrier arriving during a dump gets a later pass");
  releases.shift()();
  await Promise.all(barriers);
  await waitUntil(() => persistenceCalls === 3, "late explicit barrier persistence");
  releases.shift()();
  await Promise.all(lateBarriers);
  const stopping = controller.stop();
  assert.equal(controllerCleared, true);
  await waitUntil(() => persistenceCalls === 4, "final persistence");
  releases.shift()();
  await stopping;
  assert.equal(maximumPersistence, 1, "persistence passes never overlap");
  controllerTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistenceCalls, 4, "cleared timer cannot queue persistence after stop");
  await assert.rejects(() => controller.persist(), /persistence is stopping/);

  let errorTick;
  const intervalErrors = [];
  let errorPasses = 0;
  const recoveringController = createCryptoPersistenceController({
    stateDir: "unused",
    persistState: async () => {
      errorPasses += 1;
      if (errorPasses === 1) throw new Error("snapshot failed");
    },
    setIntervalFn: (callback) => {
      errorTick = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    onError: (error) => intervalErrors.push(error.message),
  });
  errorTick();
  await waitUntil(() => intervalErrors.length === 1, "reported interval failure");
  await recoveringController.persist();
  await recoveringController.stop();
  assert.deepEqual(intervalErrors, ["snapshot failed"]);
  assert.equal(errorPasses, 3, "an interval error does not poison barrier or final persistence");

  let retryingFinalPasses = 0;
  let retryingTimerClears = 0;
  const retryingController = createCryptoPersistenceController({
    stateDir: "unused",
    persistState: async () => {
      retryingFinalPasses += 1;
      if (retryingFinalPasses === 1) throw new Error("transient final snapshot failure");
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {
      retryingTimerClears += 1;
    },
  });
  const failedControllerStop = retryingController.stop();
  assert.equal(
    retryingController.stop(),
    failedControllerStop,
    "concurrent persistence stops share one attempt",
  );
  await assert.rejects(failedControllerStop, /transient final snapshot failure/);
  await retryingController.stop();
  assert.equal(retryingFinalPasses, 2, "a rejected final checkpoint is retried");
  assert.equal(retryingTimerClears, 1, "the persistence timer is cleared once");

  for (const mode of [
    "post-init-stop-failure",
    "init-rejection",
    "initial-persistence-failure",
    "explicit-quarantine",
    "final-persistence-failure",
    "marker-ownership-change",
  ]) {
    const quarantineChild = spawn(
      process.execPath,
      [fileURLToPath(new URL("./runtime-quarantine-child.mjs", import.meta.url)), mode],
      { stdio: "inherit" },
    );
    const [quarantineExitCode, quarantineSignal] = await once(quarantineChild, "exit");
    assert.equal(quarantineSignal, null);
    assert.equal(quarantineExitCode, 0, `${mode} quarantines crypto ownership safely`);
  }

  let retryingRuntimePasses = 0;
  const retryingRuntimeIdentity = {
    ...identityOne,
    userId: "@retry:example.org",
    deviceId: "RETRY",
    accountId: "retry",
  };
  const retryingRuntime = await startCryptoRuntime({
    accountKey: "retry",
    stateDir: stateC,
    identity: retryingRuntimeIdentity,
    client: makeRuntimeClient(async () => { await installTestCryptoDatabase(); }),
    persistenceOptions: {
      persistState: async () => {
        retryingRuntimePasses += 1;
        if (retryingRuntimePasses === 1) throw new Error("transient runtime snapshot failure");
      },
    },
  });
  await assert.rejects(
    () => retryingRuntime.stop(),
    (error) => {
      assert.match(String(error), /transient runtime snapshot failure/);
      assert.equal(error.matrixCryptoRuntimeStopRetryable, true);
      assert.equal(error.matrixCryptoOwnershipRetained, true);
      return true;
    },
  );
  assert.equal(existsSync(join(stateC, "crypto-runtime.active")), true);
  assert.equal(existsSync(join(stateC, "crypto-idb.lock")), true);
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "blocked-during-retry",
      stateDir: stateG,
      identity: {
        ...identityTwo,
        userId: "@blocked:example.org",
        deviceId: "BLOCKED",
        accountId: "blocked",
      },
      client: makeRuntimeClient(async () => {}),
    }),
    /Encrypted Matrix account retry is already running/,
  );
  await retryingRuntime.stop();
  assert.equal(retryingRuntimePasses, 2);
  assert.equal(existsSync(join(stateC, "crypto-runtime.active")), false);
  assert.equal(existsSync(join(stateC, "crypto-idb.lock")), false);

  let lockRetryPersistencePasses = 0;
  const lockRetryIdentity = {
    ...identityOne,
    userId: "@lock-retry:example.org",
    deviceId: "LOCK_RETRY",
    accountId: "lock-retry",
  };
  const lockRetryRuntime = await startCryptoRuntime({
    accountKey: "lock-retry",
    stateDir: stateH,
    identity: lockRetryIdentity,
    client: makeRuntimeClient(async () => { await installTestCryptoDatabase(); }),
    persistenceOptions: {
      persistState: async () => {
        lockRetryPersistencePasses += 1;
      },
    },
  });
  const blockingTransition = join(stateH, "crypto-idb.lock.takeover");
  await mkdir(blockingTransition, { mode: 0o700 });
  await writeFile(
    join(blockingTransition, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: "runtime-stop-blocker",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    () => lockRetryRuntime.stop(),
    (error) => {
      assert.match(String(error), /transition is still held/);
      assert.equal(error.matrixCryptoRuntimeStopRetryable, true);
      return true;
    },
  );
  assert.equal(lockRetryPersistencePasses, 1);
  assert.equal(existsSync(join(stateH, "crypto-runtime.active")), false);
  assert.equal(existsSync(join(stateH, "crypto-idb.lock")), true);
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "blocked-by-lock-retry",
      stateDir: stateG,
      identity: identityTwo,
      client: makeRuntimeClient(async () => {}),
    }),
    /Encrypted Matrix account lock-retry is already running/,
  );
  await rm(blockingTransition, { recursive: true });
  await lockRetryRuntime.stop();
  assert.equal(lockRetryPersistencePasses, 1, "lock retry skips completed shutdown phases");
  assert.equal(existsSync(join(stateH, "crypto-idb.lock")), false);
  const afterLockRetry = await startCryptoRuntime({
    accountKey: "lock-retry",
    stateDir: stateH,
    identity: lockRetryIdentity,
    client: makeRuntimeClient(async () => {}),
  });
  await afterLockRetry.stop();

  const heldCryptoDatabase = await request(
    globalThis.indexedDB.open(TEST_CRYPTO_DATABASE_NAME, 12),
  );
  let blockedInit = false;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "five",
      stateDir: stateE,
      identity: { ...identityOne, userId: "@five:example.org", deviceId: "FIVE", accountId: "five" },
      client: makeRuntimeClient(async () => { blockedInit = true; }),
    }),
    /deletion is blocked by an open connection/,
  );
  assert.equal(blockedInit, false);
  heldCryptoDatabase.close();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await globalThis.indexedDB.databases()).some(
      ({ name }) => name === TEST_CRYPTO_DATABASE_NAME,
    )) {
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  let quarantinedRetryInit = false;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "six",
      stateDir: stateF,
      identity: { ...identityOne, userId: "@six:example.org", deviceId: "SIX", accountId: "six" },
      client: makeRuntimeClient(async () => { quarantinedRetryInit = true; }),
    }),
    /Encrypted Matrix account five is already running/,
  );
  assert.equal(quarantinedRetryInit, false, "a dangling blocked delete quarantines the process");
  console.log("crypto runtime tests passed");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
