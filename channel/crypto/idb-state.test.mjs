import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedDB } from "fake-indexeddb";
import {
  acquireCryptoStateLock,
  persistCryptoState,
  restoreCryptoState,
} from "./idb-state.mjs";

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

const stateDir = await mkdtemp(join(tmpdir(), "letta-matrix-idb-"));
const dbName = "matrix-crypto-test";
try {
  const release = await acquireCryptoStateLock(stateDir);
  await assert.rejects(() => acquireCryptoStateLock(stateDir), /already in use/);

  const upgrade = indexedDB.open(dbName, 1);
  await new Promise((resolve, reject) => {
    upgrade.addEventListener("upgradeneeded", () => upgrade.result.createObjectStore("records"), { once: true });
    upgrade.addEventListener("success", resolve, { once: true });
    upgrade.addEventListener("error", () => reject(upgrade.error), { once: true });
  });
  const opened = upgrade.result;
  const tx = opened.transaction("records", "readwrite");
  const writeComplete = complete(tx);
  tx.objectStore("records").put({ bytes: new Uint8Array([1, 2, 3]), buffer: new Uint8Array([4, 5]).buffer }, "crypto");
  await writeComplete;
  opened.close();

  assert.equal(await persistCryptoState(stateDir), 1);
  assert.equal(await persistCryptoState(stateDir), 1, "second snapshot preserves a prior generation");
  await deleteDatabase(dbName);
  await writeFile(join(stateDir, "crypto-idb.snapshot"), "corrupt latest snapshot");
  assert.equal(await restoreCryptoState(stateDir), true);

  const restored = await request(indexedDB.open(dbName, 1));
  const readTx = restored.transaction("records", "readonly");
  const readComplete = complete(readTx);
  const value = await request(readTx.objectStore("records").get("crypto"));
  await readComplete;
  assert.deepEqual([...value.bytes], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(value.buffer)], [4, 5]);
  restored.close();
  await release();
  console.log("crypto IDB state tests passed");
} finally {
  await deleteDatabase(dbName);
  await rm(stateDir, { recursive: true, force: true });
}
