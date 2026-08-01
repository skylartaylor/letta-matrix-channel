import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { indexedDB } from "fake-indexeddb";
import {
  installTestCryptoDatabase,
  TEST_CRYPTO_DATABASE_NAME,
} from "./crypto-db-test-fixture.mjs";
import {
  acquireCryptoStateLock,
  clearCryptoStateActive,
  clearInMemoryCryptoState,
  markCryptoStateActive,
  persistCryptoState,
  prepareCryptoStateIdentity,
  requiresCryptoProcessQuarantine,
  restoreCryptoState,
} from "./idb-state.mjs";

globalThis.indexedDB = indexedDB;

function request(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function complete(tx) {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", resolve, { once: true });
    tx.addEventListener("error", () => reject(tx.error), { once: true });
  });
}

async function deleteDatabase(name) {
  await request(indexedDB.deleteDatabase(name));
}

const identity = {
  homeserverUrl: "https://example.org/",
  userId: "@bot:example.org",
  deviceId: "DEVICE",
  accountId: "main",
};
const stateDirs = [];
function lockMetadata(owner) {
  return {
    createdAt: new Date().toISOString(),
    ...owner,
    version: 1,
  };
}

async function makeStateDir(label) {
  const directory = await mkdtemp(join(tmpdir(), `letta-matrix-${label}-`));
  stateDirs.push(directory);
  return directory;
}

async function installLock(directory, owner) {
  const lock = join(directory, "crypto-idb.lock");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify(lockMetadata(owner))}\n`,
    { mode: 0o600 },
  );
  return lock;
}

function spawnLockChild(stateDir, mode) {
  const child = fork(
    fileURLToPath(new URL("./lock-test-child.mjs", import.meta.url)),
    [stateDir, mode],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  const outcome = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  return { child, exited, outcome };
}

const stateDir = await makeStateDir("idb");
const dbName = TEST_CRYPTO_DATABASE_NAME;
const unrelatedDbName = "letta-unrelated-test-state";
try {
  const release = await acquireCryptoStateLock(stateDir);
  await assert.rejects(() => acquireCryptoStateLock(stateDir), /already in use/);

  await installTestCryptoDatabase();
  const upgrade = indexedDB.open(dbName, 12);
  await new Promise((resolve, reject) => {
    upgrade.addEventListener("success", resolve, { once: true });
    upgrade.addEventListener("error", () => reject(upgrade.error), { once: true });
  });
  const opened = upgrade.result;
  const tx = opened.transaction("core", "readwrite");
  const writeComplete = complete(tx);
  tx.objectStore("core").put({ bytes: new Uint8Array([1, 2, 3]), buffer: new Uint8Array([4, 5]).buffer }, "crypto");
  await writeComplete;
  const expectedSnapshotStores = [...opened.objectStoreNames];
  const databasePrototype = Object.getPrototypeOf(opened);
  const originalTransaction = databasePrototype.transaction;
  opened.close();

  const unrelated = await request(indexedDB.open(unrelatedDbName, 1));
  unrelated.close();
  const snapshotTransactions = [];
  databasePrototype.transaction = function transaction(storeNames, mode, options) {
    if (this.name === dbName && mode === "readonly") {
      snapshotTransactions.push(
        typeof storeNames === "string" ? [storeNames] : [...storeNames],
      );
    }
    return originalTransaction.call(this, storeNames, mode, options);
  };
  try {
    assert.equal(await persistCryptoState(stateDir), 1);
  } finally {
    databasePrototype.transaction = originalTransaction;
  }
  assert.deepEqual(
    snapshotTransactions,
    [expectedSnapshotStores],
    "one readonly transaction captures every store in the crypto database",
  );
  assert.equal(await persistCryptoState(stateDir), 1, "second snapshot preserves a prior generation");
  await deleteDatabase(dbName);
  await writeFile(join(stateDir, "crypto-idb.snapshot"), "corrupt latest snapshot");
  const rejectedBeforeCorruption = (await readdir(stateDir))
    .filter((name) => name.startsWith("crypto-idb.snapshot.rejected.")).length;
  const corruptRecovery = await restoreCryptoState(stateDir);
  assert.equal(corruptRecovery?.generation, "previous");
  assert.match(
    corruptRecovery?.rejectedSnapshotPath ?? "",
    /crypto-idb\.snapshot\.rejected\./,
  );
  assert.equal(existsSync(join(stateDir, "crypto-idb.snapshot")), false);
  assert.equal(
    (await readdir(stateDir))
      .filter((name) => name.startsWith("crypto-idb.snapshot.rejected.")).length,
    rejectedBeforeCorruption + 1,
    "fallback retains the rejected current snapshot for diagnosis",
  );

  const restored = await request(indexedDB.open(dbName, 12));
  const readTx = restored.transaction("core", "readonly");
  const readComplete = complete(readTx);
  const value = await request(readTx.objectStore("core").get("crypto"));
  await readComplete;
  assert.deepEqual([...value.bytes], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(value.buffer)], [4, 5]);
  restored.close();

  await deleteDatabase(dbName);
  const missingCurrentRecovery = await restoreCryptoState(stateDir);
  assert.equal(missingCurrentRecovery?.generation, "previous");
  assert.equal(missingCurrentRecovery?.rejectedSnapshotPath, null);

  await persistCryptoState(stateDir);
  await deleteDatabase(dbName);
  await writeFile(
    join(stateDir, "crypto-idb.snapshot"),
    serialize({
      version: 1,
      databases: [{ name: dbName, version: 12, stores: [] }],
    }),
  );
  assert.equal((await restoreCryptoState(stateDir))?.generation, "previous");
  assert.equal(existsSync(join(stateDir, "crypto-idb.snapshot")), false);
  assert.equal(
    (await readdir(stateDir))
      .filter((name) => name.startsWith("crypto-idb.snapshot.rejected.")).length,
    rejectedBeforeCorruption + 2,
  );
  const semanticFallback = await request(indexedDB.open(dbName, 12));
  semanticFallback.close();

  await persistCryptoState(stateDir);
  const missingAccount = deserialize(await readFile(join(stateDir, "crypto-idb.snapshot")));
  const core = missingAccount.databases[0].stores.find(({ name }) => name === "core");
  core.records = core.records.filter(({ key }) => key !== "account");
  await deleteDatabase(dbName);
  await writeFile(join(stateDir, "crypto-idb.snapshot"), serialize(missingAccount));
  assert.equal(
    (await restoreCryptoState(stateDir))?.generation,
    "previous",
    "a schema-valid snapshot without the Olm account falls back",
  );
  assert.equal(existsSync(join(stateDir, "crypto-idb.snapshot")), false);
  assert.equal(
    (await readdir(stateDir))
      .filter((name) => name.startsWith("crypto-idb.snapshot.rejected.")).length,
    rejectedBeforeCorruption + 3,
  );
  assert.equal(
    (await indexedDB.databases()).some(({ name }) => name === unrelatedDbName),
    true,
    "snapshot operations leave unrelated IndexedDB state alone",
  );
  await release();

  const staleState = await makeStateDir("stale-lock");
  await chmod(staleState, 0o755);
  await installLock(staleState, {
    token: "stale-owner",
    pid: 2_147_483_647,
    createdAt: new Date(0).toISOString(),
  });
  await assert.rejects(
    () => acquireCryptoStateLock(staleState),
    /directory permissions must be 0700/,
  );
  await chmod(staleState, 0o700);
  const contenders = await Promise.allSettled([
    acquireCryptoStateLock(staleState),
    acquireCryptoStateLock(staleState),
  ]);
  const winners = contenders.filter(({ status }) => status === "fulfilled");
  const losers = contenders.filter(({ status }) => status === "rejected");
  assert.equal((await stat(staleState)).mode & 0o777, 0o700);
  assert.equal(winners.length, 1, "exactly one concurrent stale-lock reclaimer wins");
  assert.equal(losers.length, 1);
  assert.match(String(losers[0].reason), /already in use|transition/);
  await winners[0].value();
  const afterReclaim = await acquireCryptoStateLock(staleState);
  await afterReclaim();

  const retryReleaseState = await makeStateDir("retry-release");
  const retryRelease = await acquireCryptoStateLock(retryReleaseState);
  const retryTransition = join(retryReleaseState, "crypto-idb.lock.takeover");
  await mkdir(retryTransition, { mode: 0o700 });
  await writeFile(
    join(retryTransition, "owner.json"),
    `${JSON.stringify(lockMetadata({
      token: "blocking-transition",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }))}\n`,
    { mode: 0o600 },
  );
  const firstReleaseAttempt = retryRelease();
  assert.equal(
    retryRelease(),
    firstReleaseAttempt,
    "concurrent release calls share the in-flight attempt",
  );
  const acquireDuringRelease = acquireCryptoStateLock(retryReleaseState);

  const liveTransitionState = await makeStateDir("live-transition");
  const deadTransitionState = await makeStateDir("dead-transition");
  const malformedTransitionState = await makeStateDir("malformed-transition");
  await Promise.all([
    installLock(liveTransitionState, {
      token: "live-transition",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }).then((path) => rename(path, join(liveTransitionState, "crypto-idb.lock.takeover"))),
    installLock(deadTransitionState, {
      token: "dead-transition",
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString(),
    }).then((path) => rename(path, join(deadTransitionState, "crypto-idb.lock.takeover"))),
    mkdir(join(malformedTransitionState, "crypto-idb.lock.takeover"), { mode: 0o700 })
      .then(() => writeFile(
        join(malformedTransitionState, "crypto-idb.lock.takeover", "owner.json"),
        "{}\n",
        { mode: 0o600 },
      )),
  ]);
  await Promise.all([
    assert.rejects(
      firstReleaseAttempt,
      (error) => {
        assert.match(
          String(error),
          new RegExp(`transition is still held by process ${process.pid}; retry after it completes`),
        );
        assert.equal(error.matrixCryptoLockReleaseRetryable, true);
        assert.equal(error.matrixCryptoOwnershipRetained, true);
        return true;
      },
    ),
    assert.rejects(
      acquireDuringRelease,
      new RegExp(`transition is still held by process ${process.pid}; retry after it completes`),
    ),
    assert.rejects(
      () => acquireCryptoStateLock(liveTransitionState),
      new RegExp(`transition is still held by process ${process.pid}; retry after it completes`),
    ),
    assert.rejects(
      () => acquireCryptoStateLock(deadTransitionState),
      (error) => {
        assert.match(
          String(error),
          /transition owner 2147483647 is no longer running; manual recovery is required/,
        );
        assert.equal(requiresCryptoProcessQuarantine(error), true);
        return true;
      },
    ),
    assert.rejects(
      () => acquireCryptoStateLock(malformedTransitionState),
      /transition has invalid ownership metadata; manual recovery is required/,
    ),
  ]);
  await rm(retryTransition, { recursive: true });
  await retryRelease();
  await retryRelease();
  assert.deepEqual(
    (await readdir(retryReleaseState)).filter((name) => name.startsWith("crypto-idb.lock")),
    [],
    "a retried release removes canonical, transition, and retired lock artifacts",
  );
  const afterReleaseRetry = await acquireCryptoStateLock(retryReleaseState);
  await afterReleaseRetry();

  const interleavingChild = spawn(
    process.execPath,
    [fileURLToPath(new URL("./lock-interleaving-child.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
  const [interleavingExitCode, interleavingSignal] = await once(
    interleavingChild,
    "exit",
  );
  assert.equal(interleavingSignal, null);
  assert.equal(
    interleavingExitCode,
    0,
    "a contender drains a release that began after its optimistic pending check",
  );

  const processState = await makeStateDir("process-lock");
  const crashed = spawnLockChild(processState, "crash");
  assert.equal((await crashed.outcome).type, "acquired");
  await crashed.exited;
  const processContenders = [
    spawnLockChild(processState, "hold"),
    spawnLockChild(processState, "hold"),
    spawnLockChild(processState, "hold"),
  ];
  const processOutcomes = await Promise.all(processContenders.map(({ outcome }) => outcome));
  const acquiredIndexes = processOutcomes
    .map(({ type }, index) => (type === "acquired" ? index : -1))
    .filter((index) => index >= 0);
  const rejectedOutcomes = processOutcomes.filter(({ type }) => type === "error");
  assert.equal(
    acquiredIndexes.length,
    1,
    "one child reclaims the crashed process lock",
  );
  assert.equal(rejectedOutcomes.length, 2, "all other children observe the live successor");
  for (const outcome of rejectedOutcomes) {
    assert.match(outcome.message, /already in use|transition/);
  }
  const [acquiredIndex] = acquiredIndexes;
  processContenders[acquiredIndex].child.send("release");
  await Promise.all(processContenders.map(({ exited }) => exited));

  const changedState = await makeStateDir("changed-lock");
  const delayedRelease = await acquireCryptoStateLock(changedState);
  const canonical = join(changedState, "crypto-idb.lock");
  const displaced = join(changedState, "crypto-idb.lock.displaced");
  await rename(canonical, displaced);
  await installLock(changedState, {
    token: "successor-owner",
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  await assert.rejects(
    () => delayedRelease(),
    (error) => {
      assert.match(String(error), /ownership changed/);
      assert.equal(error.matrixCryptoLockReleaseRetryable, false);
      assert.equal(error.matrixCryptoOwnershipRetained, true);
      assert.equal(requiresCryptoProcessQuarantine(error), true);
      return true;
    },
  );
  const successor = JSON.parse(await readFile(join(canonical, "owner.json"), "utf8"));
  assert.equal(successor.token, "successor-owner", "delayed release leaves the successor lock intact");
  await rm(canonical, { recursive: true });
  await rm(displaced, { recursive: true });
  const afterTerminalRelease = await acquireCryptoStateLock(changedState);
  await afterTerminalRelease();

  const malformedState = await makeStateDir("malformed-lock");
  const malformedLock = join(malformedState, "crypto-idb.lock");
  await mkdir(malformedLock, { mode: 0o700 });
  await writeFile(join(malformedLock, "owner.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(
    () => acquireCryptoStateLock(malformedState),
    /invalid ownership metadata; manual recovery is required/,
  );

  const emptyLockState = await makeStateDir("empty-lock");
  await mkdir(join(emptyLockState, "crypto-idb.lock"), { mode: 0o700 });
  await assert.rejects(
    () => acquireCryptoStateLock(emptyLockState),
    /invalid ownership metadata; manual recovery is required/,
  );

  for (const [label, owner] of [
    ["unsafe-pid", {
      token: "unsafe-pid",
      pid: 1e100,
      createdAt: new Date(0).toISOString(),
    }],
    ["unsafe-token", {
      token: "../../outside",
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString(),
    }],
  ]) {
    const unsafeState = await makeStateDir(label);
    await installLock(unsafeState, owner);
    await assert.rejects(
      () => acquireCryptoStateLock(unsafeState),
      (error) => {
        assert.match(
          String(error),
          /invalid ownership metadata; manual recovery is required/,
        );
        assert.equal(requiresCryptoProcessQuarantine(error), true);
        return true;
      },
    );
  }

  const activeMarkerState = await makeStateDir("active-marker");
  const activeMarkerToken = await markCryptoStateActive(activeMarkerState);
  await assert.rejects(
    () => markCryptoStateActive(activeMarkerState),
    /EEXIST|file already exists/,
  );
  await assert.rejects(
    () => clearCryptoStateActive(activeMarkerState, "not-the-owner"),
    (error) => {
      assert.match(String(error), /marker ownership changed/);
      assert.equal(requiresCryptoProcessQuarantine(error), true);
      return true;
    },
  );
  assert.equal(existsSync(join(activeMarkerState, "crypto-runtime.active")), true);
  await clearCryptoStateActive(activeMarkerState, activeMarkerToken);
  assert.equal(existsSync(join(activeMarkerState, "crypto-runtime.active")), false);

  const freshIdentityState = await makeStateDir("identity");
  await assert.rejects(
    () => prepareCryptoStateIdentity(freshIdentityState, identity),
    /existing empty state directory cannot be trusted/,
  );
  assert.deepEqual(
    await prepareCryptoStateIdentity(freshIdentityState, identity, { allowBootstrap: true }),
    { fresh: true, identity: { version: 1, ...identity } },
  );
  const identityMode = (await stat(join(freshIdentityState, "crypto-identity.json"))).mode & 0o777;
  assert.equal(identityMode, 0o600);
  await assert.rejects(
    () => prepareCryptoStateIdentity(freshIdentityState, identity),
    /identity metadata exists but the crypto snapshot is missing/,
  );
  await persistCryptoState(freshIdentityState);
  assert.equal((await prepareCryptoStateIdentity(freshIdentityState, identity)).fresh, false);
  for (const [field, value] of [
    ["homeserverUrl", "https://other.example.org/"],
    ["userId", "@other:example.org"],
    ["deviceId", "OTHER"],
    ["accountId", "other"],
  ]) {
    await assert.rejects(
      () => prepareCryptoStateIdentity(freshIdentityState, { ...identity, [field]: value }),
      new RegExp(`stored ${field} does not match`),
    );
  }

  const missingIdentityState = await makeStateDir("missing-identity");
  await persistCryptoState(missingIdentityState);
  await assert.rejects(
    () => prepareCryptoStateIdentity(missingIdentityState, identity),
    /identity metadata is missing beside existing state/,
  );

  const malformedIdentityState = await makeStateDir("malformed-identity");
  await writeFile(join(malformedIdentityState, "crypto-identity.json"), "{broken", { mode: 0o600 });
  await assert.rejects(
    () => prepareCryptoStateIdentity(malformedIdentityState, identity),
    /identity metadata is malformed/,
  );

  const heldDatabase = await request(indexedDB.open(dbName, 12));
  try {
    const blocked = await clearInMemoryCryptoState().catch((error) => error);
    assert.match(String(blocked), /deletion is blocked by an open connection/);
    assert.equal(requiresCryptoProcessQuarantine(blocked), true);
  } finally {
    heldDatabase.close();
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await indexedDB.databases()).some(({ name }) => name === dbName)) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    (await indexedDB.databases()).some(({ name }) => name === dbName),
    false,
    "the rejected blocked deletion is still terminally completed later",
  );
  assert.equal(
    (await indexedDB.databases()).some(({ name }) => name === unrelatedDbName),
    true,
  );
  console.log("crypto IDB state tests passed");
} finally {
  await deleteDatabase(dbName);
  await deleteDatabase(unrelatedDbName);
  await Promise.all(stateDirs.map((directory) => rm(directory, { recursive: true, force: true })));
}
