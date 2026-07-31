// Adapted from the persistence approach in OpenClaw's Matrix extension
// (MIT, OpenClaw Foundation, 2026). See ../../THIRD_PARTY_NOTICES.md.
//
// Node has no persistent IndexedDB. The Matrix Rust/WASM crypto adapter uses
// IndexedDB, so this module snapshots its fake-indexeddb databases to a
// per-account state directory. Snapshot values use v8 serialization rather
// than JSON so Uint8Array and ArrayBuffer crypto records round-trip intact.

import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { indexedDB } from "fake-indexeddb";

const SNAPSHOT_FILE = "crypto-idb.snapshot";
const LOCK_FILE = "crypto-idb.lock";
const SNAPSHOT_VERSION = 1;

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

function statePath(stateDir) {
  return join(stateDir, SNAPSHOT_FILE);
}

function lockPath(stateDir) {
  return join(stateDir, LOCK_FILE);
}

function ensureStateDirectory(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

async function isLivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Acquire exclusive ownership of one account's crypto state. The returned
 * release function must run during adapter stop. A dead process's lock is
 * reclaimed only after confirming its PID no longer exists.
 */
export async function acquireCryptoStateLock(stateDir) {
  ensureStateDirectory(stateDir);
  const path = lockPath(stateDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing = null;
      try {
        existing = JSON.parse(await readFile(path, "utf8"));
      } catch {
        // A malformed lock is not proof that a process owns state. Remove it
        // once, then retry acquisition; a live process will still retain its
        // own file descriptor only if it created a valid lock.
      }
      if (await isLivePid(existing?.pid)) {
        throw new Error(`Matrix crypto state is already in use by process ${existing.pid}`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire Matrix crypto state lock");
}

async function dumpDatabase(name, version) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error(`Could not open ${name}`)), { once: true });
  });

  try {
    const stores = [];
    for (const storeName of database.objectStoreNames) {
      const transaction = database.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const completed = transactionComplete(transaction);
      const indexes = [];
      for (const indexName of store.indexNames) {
        const index = store.index(indexName);
        indexes.push({ name: indexName, keyPath: index.keyPath, multiEntry: index.multiEntry, unique: index.unique });
      }
      const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
      await completed;
      stores.push({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
        records: keys.map((key, index) => ({ key, value: values[index] })),
      });
    }
    return { name, version: database.version, stores };
  } finally {
    database.close();
  }
}

export async function persistCryptoState(stateDir) {
  ensureStateDirectory(stateDir);
  const databases = await indexedDB.databases();
  const snapshot = [];
  for (const { name, version } of databases) {
    if (!name || !version) continue;
    snapshot.push(await dumpDatabase(name, version));
  }
  const payload = serialize({ version: SNAPSHOT_VERSION, databases: snapshot });
  const target = statePath(stateDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, payload, { mode: 0o600 });
  await rename(temporary, target);
  return snapshot.length;
}

async function restoreDatabase(snapshot) {
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
  const target = statePath(stateDir);
  let payload;
  try {
    payload = deserialize(await readFile(target));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`Could not restore Matrix crypto state: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (payload?.version !== SNAPSHOT_VERSION || !Array.isArray(payload.databases)) {
    throw new Error("Matrix crypto state snapshot has an unsupported format");
  }
  for (const database of payload.databases) await restoreDatabase(database);
  return true;
}
