// Adapted from the persistence approach in OpenClaw's Matrix extension
// (MIT, OpenClaw Foundation, 2026). See ../../THIRD_PARTY_NOTICES.md.
//
// Node has no persistent IndexedDB. The Matrix Rust/WASM crypto adapter uses
// IndexedDB, so this module snapshots its fake-indexeddb databases to a
// per-account state directory. Snapshot values use v8 serialization rather
// than JSON so Uint8Array and ArrayBuffer crypto records round-trip intact.

import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";

const SNAPSHOT_FILE = "crypto-idb.snapshot";
const PREVIOUS_SNAPSHOT_FILE = "crypto-idb.snapshot.previous";
const IDENTITY_FILE = "crypto-identity.json";
const LOCK_DIRECTORY = "crypto-idb.lock";
const LOCK_TAKEOVER_DIRECTORY = "crypto-idb.lock.takeover";
const LOCK_OWNER_FILE = "owner.json";
const ACTIVE_RUNTIME_FILE = "crypto-runtime.active";
const SNAPSHOT_VERSION = 1;
const IDENTITY_VERSION = 1;
const LOCK_VERSION = 1;
const LOCK_TRANSITION_TIMEOUT_MS = 5_000;
const MAX_PROCESS_ID = 2_147_483_647;
const OWNERSHIP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING_TRANSITION_RELEASES = new Map();
const PENDING_CANONICAL_RELEASES = new Map();
const ACTIVE_MARKER_CLEARERS = new Map();
const CRYPTO_DATABASE_NAMES = new Set([
  "matrix-js-sdk::matrix-sdk-crypto",
  "matrix-js-sdk::matrix-sdk-crypto-meta",
]);
const MAIN_CRYPTO_DATABASE = "matrix-js-sdk::matrix-sdk-crypto";
const META_CRYPTO_DATABASE = "matrix-js-sdk::matrix-sdk-crypto-meta";
const MAIN_CRYPTO_STORES = new Map([
  ["backup_keys", []],
  ["core", []],
  ["devices", []],
  ["direct_withheld_info", []],
  ["gossip_requests", [
    { name: "by_info", keyPath: "info", unique: true, multiEntry: false },
    { name: "unsent", keyPath: "unsent", unique: false, multiEntry: false },
  ]],
  ["identities", []],
  ["inbound_group_sessions3", [
    { name: "backed_up_to", keyPath: "backed_up_to", unique: false, multiEntry: false },
    { name: "backup", keyPath: "needs_backup", unique: false, multiEntry: false },
    {
      name: "inbound_group_session_sender_key_sender_data_type_idx",
      keyPath: ["sender_key", "sender_data_type", "session_id"],
      unique: false,
      multiEntry: false,
    },
  ]],
  ["olm_hashes", []],
  ["outbound_group_sessions", []],
  ["room_settings", []],
  ["secrets_inbox", []],
  ["session", []],
  ["tracked_users", []],
]);

function cryptoIndexedDb() {
  if (!globalThis.indexedDB) {
    throw new Error("Matrix crypto runtime has not installed IndexedDB");
  }
  return globalThis.indexedDB;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

function keyPathsEqual(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual)
      && actual.length === expected.length
      && actual.every((value, index) => value === expected[index])
    );
  }
  return actual === expected;
}

function validateStoreSnapshot(store, expectedIndexes) {
  if (
    !store
    || typeof store.name !== "string"
    || store.keyPath !== null
    || store.autoIncrement !== false
    || !Array.isArray(store.indexes)
    || !Array.isArray(store.records)
    || store.indexes.length !== expectedIndexes.length
  ) {
    throw new Error("snapshot contains an invalid Matrix crypto object store");
  }
  const indexes = new Map(store.indexes.map((index) => [index?.name, index]));
  if (indexes.size !== store.indexes.length) {
    throw new Error("snapshot contains duplicate Matrix crypto indexes");
  }
  for (const expected of expectedIndexes) {
    const index = indexes.get(expected.name);
    if (
      !index
      || !keyPathsEqual(index.keyPath, expected.keyPath)
      || index.unique !== expected.unique
      || index.multiEntry !== expected.multiEntry
    ) {
      throw new Error("snapshot contains an invalid Matrix crypto index");
    }
  }
  for (const record of store.records) {
    if (
      !record
      || typeof record !== "object"
      || !Object.hasOwn(record, "key")
      || !Object.hasOwn(record, "value")
    ) {
      throw new Error("snapshot contains an invalid Matrix crypto record");
    }
  }
}

function validateDatabaseSnapshot(database) {
  if (!database || !Array.isArray(database.stores)) {
    throw new Error("snapshot contains an invalid Matrix crypto database");
  }
  const expectedVersion = database.name === MAIN_CRYPTO_DATABASE ? 12 : 1;
  const expectedStores = database.name === MAIN_CRYPTO_DATABASE
    ? MAIN_CRYPTO_STORES
    : new Map([["matrix-sdk-crypto", []]]);
  if (
    database.version !== expectedVersion
    || database.stores.length !== expectedStores.size
  ) {
    throw new Error("snapshot contains an unsupported Matrix crypto database schema");
  }
  const stores = new Map(database.stores.map((store) => [store?.name, store]));
  if (stores.size !== database.stores.length) {
    throw new Error("snapshot contains duplicate Matrix crypto object stores");
  }
  for (const [name, expectedIndexes] of expectedStores) {
    const store = stores.get(name);
    if (!store) {
      throw new Error("snapshot is missing a required Matrix crypto object store");
    }
    validateStoreSnapshot(store, expectedIndexes);
  }
  const requiredRecord = database.name === MAIN_CRYPTO_DATABASE
    ? { store: "core", key: "account" }
    : { store: "matrix-sdk-crypto", key: "store_cipher" };
  if (
    stores.get(requiredRecord.store).records.filter(
      (record) => record.key === requiredRecord.key,
    ).length !== 1
  ) {
    throw new Error("snapshot is missing required Matrix crypto identity material");
  }
}

function validateSnapshotDatabases(databases) {
  if (!Array.isArray(databases) || databases.length < 1 || databases.length > 2) {
    throw new Error("snapshot does not contain the pinned Matrix crypto database");
  }
  const seen = new Set();
  for (const database of databases) {
    if (
      !database
      || !CRYPTO_DATABASE_NAMES.has(database.name)
      || seen.has(database.name)
    ) {
      throw new Error("snapshot contains an unexpected Matrix crypto database");
    }
    seen.add(database.name);
    validateDatabaseSnapshot(database);
  }
  if (!seen.has(MAIN_CRYPTO_DATABASE)) {
    throw new Error("snapshot is missing the pinned Matrix crypto database");
  }
}

export function requiresCryptoProcessQuarantine(error) {
  if (!error) return false;
  if (error.matrixCryptoProcessQuarantine === true) return true;
  if (
    error instanceof AggregateError
    && error.errors.some((nested) => requiresCryptoProcessQuarantine(nested))
  ) {
    return true;
  }
  return requiresCryptoProcessQuarantine(error.cause);
}

function statePath(stateDir) {
  return join(stateDir, SNAPSHOT_FILE);
}

function previousStatePath(stateDir) {
  return join(stateDir, PREVIOUS_SNAPSHOT_FILE);
}

function lockPath(stateDir) {
  return join(stateDir, LOCK_DIRECTORY);
}

function lockTakeoverPath(stateDir) {
  return join(stateDir, LOCK_TAKEOVER_DIRECTORY);
}

function identityPath(stateDir) {
  return join(stateDir, IDENTITY_FILE);
}

function ensureStateDirectory(stateDir) {
  mkdirSync(dirname(stateDir), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    mkdirSync(stateDir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assertSecureStateDirectory(stateDir);
  return created;
}

function assertSecureStateDirectory(stateDir) {
  const metadata = lstatSync(stateDir);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Matrix crypto state path must be a real directory");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error("Matrix crypto state directory permissions must be 0700");
  }
}

function activeRuntimePath(stateDir) {
  return join(stateDir, ACTIVE_RUNTIME_FILE);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isLivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_ID) {
    throw new Error("Matrix crypto state lock has an invalid owner process ID");
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw new Error("Matrix crypto state lock owner liveness could not be determined", {
      cause: error,
    });
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeDurableFile(path, contents, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function terminalOwnershipError(message) {
  const error = new Error(message);
  Object.defineProperties(error, {
    matrixCryptoTerminalOwnershipError: { value: true },
    matrixCryptoProcessQuarantine: { value: true },
  });
  return error;
}

function lockMetadataError() {
  return terminalOwnershipError(
    "Matrix crypto state lock has invalid ownership metadata; manual recovery is required",
  );
}

function hasTerminalOwnershipError(error) {
  if (!error) return false;
  if (error.matrixCryptoTerminalOwnershipError === true) return true;
  if (
    error instanceof AggregateError
    && error.errors.some((nested) => hasTerminalOwnershipError(nested))
  ) {
    return true;
  }
  return hasTerminalOwnershipError(error.cause);
}

async function readLockOwner(directory) {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(directory, LOCK_OWNER_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw lockMetadataError();
  }
  if (
    owner?.version !== LOCK_VERSION
    || typeof owner.token !== "string"
    || !OWNERSHIP_TOKEN_PATTERN.test(owner.token)
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || owner.pid > MAX_PROCESS_ID
    || typeof owner.createdAt !== "string"
  ) {
    throw lockMetadataError();
  }
  return owner;
}

function createLockOwner() {
  return {
    version: LOCK_VERSION,
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
}

async function readLockOwnerIfPresent(directory) {
  try {
    return await readLockOwner(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (await pathExists(directory)) throw lockMetadataError();
      return null;
    }
    throw error;
  }
}

async function createLockCandidate(stateDir, owner, prefix = ".crypto-idb.lock") {
  const candidate = join(stateDir, `${prefix}.${owner.token}.candidate`);
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeDurableFile(
      join(candidate, LOCK_OWNER_FILE),
      `${JSON.stringify(owner)}\n`,
      0o600,
    );
    await syncDirectory(candidate);
    return candidate;
  } catch (error) {
    await removeLockCandidate(
      candidate,
      error,
      "Matrix crypto state lock candidate creation cleanup failed",
      { recursive: true, force: true },
    );
    throw error;
  }
}

async function removeLockCandidate(candidate, primaryError, message, options) {
  try {
    await rm(candidate, options);
  } catch (cleanupError) {
    if (cleanupError?.code === "ENOENT") return;
    if (primaryError) {
      throw new AggregateError([primaryError, cleanupError], message);
    }
    throw cleanupError;
  }
}

function lockReleaseFailure(error) {
  const retryable = !hasTerminalOwnershipError(error);
  const failure = new AggregateError(
    [error],
    error instanceof Error ? error.message : String(error),
  );
  Object.defineProperties(failure, {
    matrixCryptoLockReleaseRetryable: { value: retryable },
    matrixCryptoOwnershipRetained: { value: true },
    ...(retryable ? {} : {
      matrixCryptoProcessQuarantine: { value: true },
    }),
  });
  return failure;
}

function createRetryableRelease({ key, pendingReleases, operation }) {
  let inFlight = null;
  let complete = false;
  let terminalFailure = null;
  const release = () => {
    if (complete) return Promise.resolve();
    if (terminalFailure) return Promise.reject(terminalFailure);
    if (inFlight) return inFlight;
    const competingRelease = pendingReleases.get(key);
    if (competingRelease && competingRelease !== release) {
      terminalFailure = lockReleaseFailure(terminalOwnershipError(
        "Matrix crypto state has overlapping lock release ownership",
      ));
      return Promise.reject(terminalFailure);
    }
    const attempt = (async () => {
      try {
        await operation();
      } catch (error) {
        const failure = lockReleaseFailure(error);
        if (failure.matrixCryptoLockReleaseRetryable === false) {
          terminalFailure = failure;
        }
        throw failure;
      }
      complete = true;
      if (pendingReleases.get(key) === release) pendingReleases.delete(key);
    })();
    inFlight = attempt;
    pendingReleases.set(key, release);
    void attempt.then(
      () => {},
      () => {
        if (inFlight === attempt) inFlight = null;
        if (terminalFailure) {
          if (pendingReleases.get(key) === release) pendingReleases.delete(key);
          return;
        }
        if (
          !complete
          && (
            !pendingReleases.has(key)
            || pendingReleases.get(key) === release
          )
        ) {
          pendingReleases.set(key, release);
        }
      },
    );
    return attempt;
  };
  return release;
}

function createTransitionRelease(stateDir, transition, owner) {
  const retired = `${transition}.released.${owner.token}`;
  let renamed = false;
  let verified = false;
  let removed = false;
  return createRetryableRelease({
    key: transition,
    pendingReleases: PENDING_TRANSITION_RELEASES,
    operation: async () => {
      if (!renamed) {
        const active = await readLockOwnerIfPresent(transition);
        if (!active) {
          throw terminalOwnershipError(
            "Matrix crypto state lock transition ownership was lost before release",
          );
        }
        if (active.token !== owner.token) {
          throw terminalOwnershipError(
            "Matrix crypto state lock transition ownership changed",
          );
        }
        await rename(transition, retired);
        renamed = true;
      }
      await syncDirectory(stateDir);
      if (!verified) {
        const moved = await readLockOwnerIfPresent(retired);
        if (!moved) {
          throw terminalOwnershipError(
            "Matrix crypto state lock transition ownership was lost during release",
          );
        }
        if (moved.token !== owner.token) {
          throw terminalOwnershipError(
            "Matrix crypto state lock transition ownership changed during release",
          );
        }
        verified = true;
      }
      if (!removed) {
        await rm(retired, { recursive: true, force: true });
        removed = true;
      }
      await syncDirectory(stateDir);
    },
  });
}

async function acquireLockTransition(stateDir) {
  const transition = lockTakeoverPath(stateDir);
  const owner = createLockOwner();
  const candidate = await createLockCandidate(
    stateDir,
    owner,
    ".crypto-idb.lock.takeover",
  );
  let candidateExists = true;
  let releaseTransition = null;
  let transitionError = null;
  const deadline = Date.now() + LOCK_TRANSITION_TIMEOUT_MS;
  try {
    while (true) {
      const pendingRelease = PENDING_TRANSITION_RELEASES.get(transition);
      if (pendingRelease) {
        await pendingRelease();
        continue;
      }
      if (!(await pathExists(transition))) {
        const releaseBeforePublish = PENDING_TRANSITION_RELEASES.get(transition);
        if (releaseBeforePublish) {
          await releaseBeforePublish();
          continue;
        }
        try {
          // Publish only a fully written, synced, non-empty directory. A
          // competing valid gate is also non-empty, so rename cannot replace
          // it and instead reports contention.
          await rename(candidate, transition);
          candidateExists = false;
          releaseTransition = createTransitionRelease(stateDir, transition, owner);
          await syncDirectory(stateDir);
        } catch (error) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
            throw error;
          }
        }
      }
      if (!candidateExists) {
        return releaseTransition;
      }
      if (Date.now() >= deadline) {
        let active;
        try {
          active = await readLockOwnerIfPresent(transition);
        } catch {
          throw terminalOwnershipError(
            "Matrix crypto state lock transition has invalid ownership metadata; manual recovery is required",
          );
        }
        if (!active) continue;
        if (await isLivePid(active.pid)) {
          throw new Error(
            `Matrix crypto state lock transition is still held by process ${active.pid}; retry after it completes`,
          );
        }
        // Do not automatically reclaim this gate. It is the serialization
        // primitive that makes canonical-lock takeover race-free; removing a
        // gate after a stale read could instead remove a live successor.
        throw terminalOwnershipError(
          `Matrix crypto state lock transition owner ${active.pid} is no longer running; manual recovery is required`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } catch (error) {
    let failure = error;
    if (releaseTransition) {
      try {
        await releaseTransition();
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          "Matrix crypto state lock transition publication cleanup failed",
        );
      }
    }
    transitionError = failure;
    throw failure;
  } finally {
    if (candidateExists) {
      await removeLockCandidate(
        candidate,
        transitionError,
        "Matrix crypto state lock transition candidate cleanup failed",
        { recursive: true },
      );
    }
  }
}

async function withLockTransition(stateDir, operation) {
  const release = await acquireLockTransition(stateDir);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, releaseError],
        "Matrix crypto state lock operation and transition release both failed",
      );
    }
    throw releaseError;
  }
  if (operationError) throw operationError;
  return result;
}

function createOwnedCanonicalRemover(stateDir, canonical, token, suffix) {
  const retired = `${canonical}.${suffix}.${token}`;
  let renamed = false;
  let verified = false;
  let removed = false;
  return async () => {
    if (!renamed) {
      const current = await readLockOwnerIfPresent(canonical);
      if (!current) {
        throw terminalOwnershipError(
          "Matrix crypto state lock ownership was lost before removal",
        );
      }
      if (current.token !== token) {
        throw terminalOwnershipError(
          "Matrix crypto state lock ownership changed before removal",
        );
      }
      await rename(canonical, retired);
      renamed = true;
    }
    await syncDirectory(stateDir);
    if (!verified) {
      const owner = await readLockOwnerIfPresent(retired);
      if (!owner) {
        throw terminalOwnershipError(
          "Matrix crypto state lock ownership was lost during removal",
        );
      }
      if (owner.token !== token) {
        throw terminalOwnershipError(
          "Matrix crypto state lock ownership changed during removal",
        );
      }
      verified = true;
    }
    if (!removed) {
      await rm(retired, { recursive: true, force: true });
      removed = true;
    }
    await syncDirectory(stateDir);
  };
}

async function removeOwnedCanonical(stateDir, canonical, token, suffix) {
  await createOwnedCanonicalRemover(stateDir, canonical, token, suffix)();
}

/**
 * Acquire exclusive ownership of one account's crypto state. The returned
 * release function must run during adapter stop. Ownership is published as a
 * fully written, non-empty directory. A separate atomic transition gate
 * serializes publication, stale-owner retirement, and release.
 */
export async function acquireCryptoStateLock(stateDir) {
  const stateDirectoryCreated = ensureStateDirectory(stateDir);
  const canonical = lockPath(stateDir);
  const owner = createLockOwner();
  const candidate = await createLockCandidate(stateDir, owner);
  let candidateExists = true;
  let published = false;
  let acquisitionError = null;
  const removePublished = createOwnedCanonicalRemover(
    stateDir,
    canonical,
    owner.token,
    "released",
  );
  const release = createRetryableRelease({
    key: canonical,
    pendingReleases: PENDING_CANONICAL_RELEASES,
    operation: () => withLockTransition(stateDir, removePublished),
  });

  try {
    try {
      while (!published) {
        const pendingRelease = PENDING_CANONICAL_RELEASES.get(canonical);
        if (pendingRelease) {
          await pendingRelease();
          continue;
        }
        let releaseDiscoveredUnderTransition = null;
        await withLockTransition(stateDir, async () => {
          // A release can begin after the optimistic check above. Never wait
          // for it while holding the transition it needs to make progress.
          releaseDiscoveredUnderTransition = PENDING_CANONICAL_RELEASES.get(canonical);
          if (releaseDiscoveredUnderTransition) return;

          const existing = await readLockOwnerIfPresent(canonical);
          if (existing) {
            if (await isLivePid(existing.pid)) {
              throw new Error(`Matrix crypto state is already in use by process ${existing.pid}`);
            }
            await removeOwnedCanonical(stateDir, canonical, existing.token, "stale");
          }

          await rename(candidate, canonical);
          candidateExists = false;
          published = true;
          const installed = await readLockOwner(canonical);
          if (installed.token !== owner.token) {
            throw terminalOwnershipError(
              "Matrix crypto state lock ownership changed during acquisition",
            );
          }
          await syncDirectory(stateDir);
        });
        if (releaseDiscoveredUnderTransition) {
          await releaseDiscoveredUnderTransition();
        }
      }
    } catch (error) {
      if (published) {
        try {
          await release();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Matrix crypto state lock acquisition cleanup failed",
          );
        }
      }
      throw error;
    }
    Object.defineProperty(release, "stateDirectoryCreated", {
      value: stateDirectoryCreated,
    });
    return release;
  } catch (error) {
    acquisitionError = error;
    throw error;
  } finally {
    if (candidateExists) {
      await removeLockCandidate(
        candidate,
        acquisitionError,
        "Matrix crypto state lock candidate cleanup failed",
        { recursive: true, force: true },
      );
    }
  }
}

function validateIdentity(identity) {
  if (
    typeof identity?.homeserverUrl !== "string"
    || !identity.homeserverUrl
    || typeof identity.userId !== "string"
    || !identity.userId
    || typeof identity.deviceId !== "string"
    || !identity.deviceId
    || typeof identity.accountId !== "string"
    || !identity.accountId
  ) {
    throw new Error("Matrix crypto identity requires homeserverUrl, userId, deviceId, and accountId");
  }
  return {
    version: IDENTITY_VERSION,
    homeserverUrl: identity.homeserverUrl,
    userId: identity.userId,
    deviceId: identity.deviceId,
    accountId: identity.accountId,
  };
}

async function hasCryptoSnapshot(stateDir) {
  return await pathExists(statePath(stateDir)) || await pathExists(previousStatePath(stateDir));
}

async function readCryptoIdentity(stateDir) {
  let identity;
  try {
    identity = JSON.parse(await readFile(identityPath(stateDir), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new Error("Matrix crypto recovery required: identity metadata is malformed");
  }
  if (
    identity?.version !== IDENTITY_VERSION
    || typeof identity.homeserverUrl !== "string"
    || typeof identity.userId !== "string"
    || typeof identity.deviceId !== "string"
    || typeof identity.accountId !== "string"
  ) {
    throw new Error("Matrix crypto recovery required: identity metadata is unsupported or incomplete");
  }
  return identity;
}

async function writeCryptoIdentity(stateDir, identity) {
  const target = identityPath(stateDir);
  const token = randomUUID();
  const temporary = `${target}.${process.pid}.${token}.tmp`;
  const retired = `${target}.aborted.${token}`;
  const contents = `${JSON.stringify(identity, null, 2)}\n`;
  await writeDurableFile(temporary, contents, 0o600);
  let linked = false;
  try {
    await link(temporary, target);
    linked = true;
    await syncDirectory(stateDir);
  } catch (error) {
    if (linked) {
      try {
        const [targetMetadata, temporaryMetadata, targetContents] = await Promise.all([
          stat(target),
          stat(temporary),
          readFile(target, "utf8"),
        ]);
        if (
          targetMetadata.dev !== temporaryMetadata.dev
          || targetMetadata.ino !== temporaryMetadata.ino
          || targetContents !== contents
        ) {
          throw terminalOwnershipError(
            "Matrix crypto identity publication ownership changed during rollback",
          );
        }
        await rename(target, retired);
        await syncDirectory(stateDir);
        const [retiredMetadata, retainedTemporaryMetadata, retiredContents] = await Promise.all([
          stat(retired),
          stat(temporary),
          readFile(retired, "utf8"),
        ]);
        if (
          retiredMetadata.dev !== retainedTemporaryMetadata.dev
          || retiredMetadata.ino !== retainedTemporaryMetadata.ino
          || retiredContents !== contents
        ) {
          throw terminalOwnershipError(
            "Matrix crypto identity publication ownership changed after rollback",
          );
        }
        await rm(retired);
        await syncDirectory(stateDir);
      } catch (cleanupError) {
        const failure = new AggregateError(
          [error, cleanupError],
          "Matrix crypto identity publication cleanup failed",
        );
        Object.defineProperty(failure, "matrixCryptoProcessQuarantine", {
          value: true,
        });
        throw failure;
      }
    }
    throw error;
  } finally {
    try {
      await rm(temporary, { force: true });
    } catch {
      // The durable target is authoritative; a 0600 temporary hard link is
      // harmless and can be removed during manual state maintenance.
    }
  }
}

export async function assertCryptoStateInactive(stateDir) {
  if (await pathExists(activeRuntimePath(stateDir))) {
    throw new Error(
      "Matrix crypto recovery required: the previous encrypted runtime did not shut down cleanly",
    );
  }
}

export async function markCryptoStateActive(stateDir) {
  const target = activeRuntimePath(stateDir);
  const token = randomUUID();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const key = `${target}\u0000${token}`;
  let clear = null;
  await writeDurableFile(
    temporary,
    `${JSON.stringify({
      version: 1,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`,
    0o600,
  );
  try {
    try {
      await link(temporary, target);
      clear = createActiveMarkerClearer(stateDir, token, key);
      ACTIVE_MARKER_CLEARERS.set(key, clear);
    } finally {
      await rm(temporary, { force: true });
    }
    await syncDirectory(stateDir);
    return token;
  } catch (error) {
    if (clear) {
      try {
        await clear();
      } catch (cleanupError) {
        const failure = new AggregateError(
          [error, cleanupError],
          "Matrix crypto runtime marker publication cleanup failed",
        );
        Object.defineProperty(failure, "matrixCryptoProcessQuarantine", {
          value: true,
        });
        throw failure;
      }
    }
    throw error;
  }
}

async function readActiveMarker(path, missingMessage, malformedMessage) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw terminalOwnershipError(missingMessage);
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(contents);
  } catch {
    throw terminalOwnershipError(malformedMessage);
  }
  if (
    marker?.version !== 1
    || typeof marker.token !== "string"
    || !OWNERSHIP_TOKEN_PATTERN.test(marker.token)
    || !Number.isSafeInteger(marker.pid)
    || marker.pid <= 0
    || marker.pid > MAX_PROCESS_ID
    || typeof marker.startedAt !== "string"
    || !Number.isFinite(Date.parse(marker.startedAt))
  ) {
    throw terminalOwnershipError(malformedMessage);
  }
  return marker;
}

function createActiveMarkerClearer(stateDir, token, key) {
  const target = activeRuntimePath(stateDir);
  const retired = `${target}.released.${token}`;
  let renamed = false;
  let verified = false;
  let removed = false;
  let complete = false;
  let inFlight = null;
  const clear = () => {
    if (complete) return Promise.resolve();
    if (inFlight) return inFlight;
    const attempt = (async () => {
      if (!renamed) {
        const marker = await readActiveMarker(
          target,
          "Matrix crypto runtime marker ownership was lost before cleanup",
          "Matrix crypto runtime marker ownership metadata is malformed",
        );
        if (typeof token !== "string" || !token || marker?.token !== token) {
          throw terminalOwnershipError(
            "Matrix crypto runtime marker ownership changed before cleanup",
          );
        }
        await rename(target, retired);
        renamed = true;
      }
      await syncDirectory(stateDir);
      if (!verified) {
        const moved = await readActiveMarker(
          retired,
          "Matrix crypto runtime marker ownership was lost during cleanup",
          "Matrix crypto runtime marker ownership metadata changed during cleanup",
        );
        if (moved?.token !== token) {
          throw terminalOwnershipError(
            "Matrix crypto runtime marker ownership changed during cleanup",
          );
        }
        verified = true;
      }
      if (!removed) {
        await rm(retired, { force: true });
        removed = true;
      }
      await syncDirectory(stateDir);
      complete = true;
      if (ACTIVE_MARKER_CLEARERS.get(key) === clear) ACTIVE_MARKER_CLEARERS.delete(key);
    })();
    inFlight = attempt;
    void attempt.then(
      () => {},
      () => {
        if (inFlight === attempt) inFlight = null;
      },
    );
    return attempt;
  };
  return clear;
}

export async function clearCryptoStateActive(stateDir, token) {
  const key = `${activeRuntimePath(stateDir)}\u0000${String(token)}`;
  let clear = ACTIVE_MARKER_CLEARERS.get(key);
  if (!clear) {
    clear = createActiveMarkerClearer(stateDir, token, key);
    ACTIVE_MARKER_CLEARERS.set(key, clear);
  }
  await clear();
}

/**
 * Validate the durable homeserver/user/device/account binding before touching
 * the process-global IndexedDB state. Only an entirely fresh state directory
 * may create identity metadata and initialize without a snapshot.
 */
export async function prepareCryptoStateIdentity(
  stateDir,
  expectedIdentity,
  { allowBootstrap = false } = {},
) {
  ensureStateDirectory(stateDir);
  const expected = validateIdentity(expectedIdentity);
  const hasSnapshot = await hasCryptoSnapshot(stateDir);
  let stored;
  try {
    stored = await readCryptoIdentity(stateDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (hasSnapshot) {
      throw new Error("Matrix crypto recovery required: identity metadata is missing beside existing state");
    }
    if (!allowBootstrap) {
      throw new Error(
        "Matrix crypto recovery required: an existing empty state directory cannot be trusted for first bootstrap",
      );
    }
    try {
      await writeCryptoIdentity(stateDir, expected);
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
      stored = await readCryptoIdentity(stateDir);
    }
    if (!stored) return { fresh: true, identity: expected };
  }

  for (const field of ["homeserverUrl", "userId", "deviceId", "accountId"]) {
    if (stored[field] !== expected[field]) {
      throw new Error(`Matrix crypto recovery required: stored ${field} does not match the authenticated device`);
    }
  }
  if (!hasSnapshot) {
    throw new Error("Matrix crypto recovery required: identity metadata exists but the crypto snapshot is missing");
  }
  return { fresh: false, identity: stored };
}

async function dumpDatabase(name, version) {
  const indexedDB = cryptoIndexedDb();
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error(`Could not open ${name}`)), { once: true });
  });

  try {
    const storeNames = [...database.objectStoreNames];
    const transaction = database.transaction(storeNames, "readonly");
    const completed = transactionComplete(transaction);
    const pendingStores = storeNames.map((storeName) => {
      const store = transaction.objectStore(storeName);
      const indexes = [];
      for (const indexName of store.indexNames) {
        const index = store.index(indexName);
        indexes.push({ name: indexName, keyPath: index.keyPath, multiEntry: index.multiEntry, unique: index.unique });
      }
      const keys = requestResult(store.getAllKeys());
      const values = requestResult(store.getAll());
      return Promise.all([keys, values]).then(([resolvedKeys, resolvedValues]) => ({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
        records: resolvedKeys.map((key, index) => ({
          key,
          value: resolvedValues[index],
        })),
      }));
    });
    const [stores] = await Promise.all([
      Promise.all(pendingStores),
      completed,
    ]);
    return { name, version: database.version, stores };
  } finally {
    database.close();
  }
}

export async function persistCryptoState(
  stateDir,
  { onPublicationStep } = {},
) {
  ensureStateDirectory(stateDir);
  const indexedDB = cryptoIndexedDb();
  const databases = await indexedDB.databases();
  const snapshot = [];
  for (const { name, version } of databases) {
    if (!CRYPTO_DATABASE_NAMES.has(name) || !version) continue;
    snapshot.push(await dumpDatabase(name, version));
  }
  validateSnapshotDatabases(snapshot);
  const payload = serialize({ version: SNAPSHOT_VERSION, databases: snapshot });
  const target = statePath(stateDir);
  const previous = previousStatePath(stateDir);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const previousTemporary = `${previous}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let installed = false;
  let previousTemporaryExists = false;
  try {
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(stateDir);
    await onPublicationStep?.("new-snapshot-synced");
    // Retain the prior generation as forensic evidence without ever removing
    // the authoritative current snapshot. A hard crash before the final
    // rename therefore leaves either the old current or the new current, never
    // a gap that would tempt an unsafe ratchet rollback.
    try {
      await link(target, previousTemporary);
      previousTemporaryExists = true;
      await syncDirectory(stateDir);
      await onPublicationStep?.("previous-candidate-synced");
      await rename(previousTemporary, previous);
      previousTemporaryExists = false;
      await syncDirectory(stateDir);
      await onPublicationStep?.("previous-installed");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(temporary, target);
    installed = true;
    await onPublicationStep?.("current-installed");
    await syncDirectory(stateDir);
    await onPublicationStep?.("current-synced");
    return snapshot.length;
  } finally {
    if (!installed) await rm(temporary, { force: true });
    if (previousTemporaryExists) await rm(previousTemporary, { force: true });
  }
}

function deserializeValidatedSnapshot(bytes) {
  const payload = deserialize(bytes);
  if (payload?.version !== SNAPSHOT_VERSION || !Array.isArray(payload.databases)) {
    throw new Error("unsupported snapshot format");
  }
  validateSnapshotDatabases(payload.databases);
  return payload;
}

async function readValidatedSnapshot(path) {
  return deserializeValidatedSnapshot(await readFile(path));
}

export async function validateCurrentCryptoSnapshot(stateDir) {
  const payload = await readValidatedSnapshot(statePath(stateDir));
  return { databaseCount: payload.databases.length };
}

async function assertSecureRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Matrix crypto recovery required: ${label} is missing`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Matrix crypto recovery required: ${label} must be a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Matrix crypto recovery required: ${label} permissions must be 0600`);
  }
  return metadata;
}

/**
 * Inspect crash recovery inputs without mutating state. Recovery re-runs every
 * check while holding the account lock; this result is only an operator aid.
 */
export async function inspectCryptoStateRecovery(stateDir) {
  assertSecureStateDirectory(stateDir);
  const markerPath = activeRuntimePath(stateDir);
  const currentPath = statePath(stateDir);
  await Promise.all([
    assertSecureRegularFile(markerPath, "active runtime marker"),
    assertSecureRegularFile(identityPath(stateDir), "identity metadata"),
    assertSecureRegularFile(currentPath, "current snapshot"),
  ]);
  const [marker, identity, snapshotBytes] = await Promise.all([
    readActiveMarker(
      markerPath,
      "Matrix crypto recovery required: the active runtime marker is missing",
      "Matrix crypto recovery required: the active runtime marker is malformed",
    ),
    readCryptoIdentity(stateDir),
    readFile(currentPath),
  ]);
  let snapshot;
  try {
    snapshot = deserializeValidatedSnapshot(snapshotBytes);
  } catch (error) {
    throw new Error(
      `Matrix crypto recovery required: current snapshot is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return {
    identity,
    marker: {
      ...marker,
      processLive: await isLivePid(marker.pid),
    },
    snapshot: {
      databaseCount: snapshot.databases.length,
      sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
    },
  };
}

/**
 * Acknowledge one dead runtime marker after an operator has inspected and
 * confirmed its exact account/device binding. This never selects or promotes a
 * previous snapshot.
 */
export async function recoverCryptoStateAfterCrash({
  stateDir,
  markerToken,
  expectedIdentity,
  recoveryOptions = {},
}) {
  assertSecureStateDirectory(stateDir);
  const expected = validateIdentity(expectedIdentity);
  if (
    typeof markerToken !== "string"
    || !OWNERSHIP_TOKEN_PATTERN.test(markerToken)
  ) {
    throw new Error("Matrix crypto recovery requires the exact active marker token");
  }
  const releaseLock = await acquireCryptoStateLock(stateDir);
  let outcome;
  try {
    const inspected = await inspectCryptoStateRecovery(stateDir);
    if (inspected.marker.token !== markerToken) {
      throw new Error("Matrix crypto recovery refused: active marker token does not match");
    }
    if (inspected.marker.processLive) {
      throw new Error(
        `Matrix crypto recovery refused: marker process ${inspected.marker.pid} is still running`,
      );
    }
    for (const field of ["homeserverUrl", "userId", "deviceId", "accountId"]) {
      if (inspected.identity[field] !== expected[field]) {
        throw new Error(
          `Matrix crypto recovery refused: confirmed ${field} does not match stored identity`,
        );
      }
    }

    const activePath = activeRuntimePath(stateDir);
    const recoveredPath = `${activePath}.recovered.${markerToken}`;
    if (await pathExists(recoveredPath)) {
      throw new Error("Matrix crypto recovery refused: recovered marker evidence already exists");
    }
    // The rename is the recovery commit. Everything that can reject has
    // already run while the active marker still blocked startup. A failed
    // directory fsync after the atomic rename cannot safely be reported as a
    // failed recovery, because the active name is already gone; on restart the
    // filesystem will expose either the old active name or the recovered name.
    await rename(activePath, recoveredPath);
    let directorySynced = true;
    try {
      await (recoveryOptions.syncDirectoryAfterCommit ?? syncDirectory)(stateDir);
    } catch {
      directorySynced = false;
    }
    outcome = {
      ...inspected,
      recoveredMarkerPath: recoveredPath,
      directorySynced,
    };
  } catch (error) {
    try {
      await releaseLock();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Matrix crypto recovery validation failed and its state lock could not be released",
      );
    }
    throw error;
  }
  let lockReleased = true;
  try {
    await releaseLock();
  } catch {
    // Recovery already committed by renaming the active marker. Returning a
    // failure now would misrepresent startup as still blocked. The stale
    // recovery-command lock remains fail-closed and can be reclaimed once this
    // process exits.
    lockReleased = false;
  }
  return { ...outcome, lockReleased };
}

async function restoreDatabase(snapshot) {
  const indexedDB = cryptoIndexedDb();
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(snapshot.name, snapshot.version);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      for (const storeSnapshot of snapshot.stores) {
        const options = {};
        if (storeSnapshot.keyPath !== null) options.keyPath = storeSnapshot.keyPath;
        if (storeSnapshot.autoIncrement) options.autoIncrement = true;
        const store = db.createObjectStore(storeSnapshot.name, options);
        for (const index of storeSnapshot.indexes) {
          store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
    }, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error(`Could not restore ${snapshot.name}`)), { once: true });
  });

  try {
    for (const storeSnapshot of snapshot.stores) {
      if (!storeSnapshot.records.length) continue;
      const transaction = database.transaction(storeSnapshot.name, "readwrite");
      const store = transaction.objectStore(storeSnapshot.name);
      const completed = transactionComplete(transaction);
      for (const record of storeSnapshot.records) {
        if (storeSnapshot.keyPath === null) store.put(record.value, record.key);
        else store.put(record.value);
      }
      await completed;
    }
  } finally {
    database.close();
  }
}

export async function restoreCryptoState(stateDir) {
  let payload;
  try {
    payload = await readValidatedSnapshot(statePath(stateDir));
    for (const database of payload.databases) {
      await restoreDatabase(database);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (await pathExists(previousStatePath(stateDir))) {
        throw new Error(
          "Could not restore Matrix crypto state: the current snapshot is missing; "
          + "previous-generation rollback is forbidden and the previous snapshot is forensic evidence only",
        );
      }
      return false;
    }
    try {
      await clearInMemoryCryptoState();
    } catch (clearError) {
      throw new AggregateError(
        [error, clearError],
        "Could not clear partially restored Matrix crypto state",
      );
    }
    throw new Error(
      `Could not restore Matrix crypto state: ${error instanceof Error ? error.message : String(error)}; `
      + "previous-generation rollback is forbidden",
      { cause: error },
    );
  }
  return { generation: "current" };
}

export async function clearInMemoryCryptoState() {
  const indexedDB = cryptoIndexedDb();
  const databases = await indexedDB.databases();
  await Promise.all(databases.filter(({ name }) => CRYPTO_DATABASE_NAMES.has(name)).map(({ name }) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", resolve, { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error(`Could not clear Matrix crypto database ${name}`)),
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => reject(Object.assign(
        new Error(`Could not clear Matrix crypto database ${name}; deletion is blocked by an open connection`),
        { matrixCryptoProcessQuarantine: true },
      )),
      { once: true },
    );
  })));
}
