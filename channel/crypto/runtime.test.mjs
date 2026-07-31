import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import "fake-indexeddb/auto";
import { startCryptoRuntime } from "./runtime.mjs";

function request(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function writeProbe(value) {
  const open = globalThis.indexedDB.open("crypto-runtime-probe", 1);
  await new Promise((resolve, reject) => {
    open.addEventListener("upgradeneeded", () => open.result.createObjectStore("records"), { once: true });
    open.addEventListener("success", resolve, { once: true });
    open.addEventListener("error", () => reject(open.error), { once: true });
  });
  const db = open.result;
  const tx = db.transaction("records", "readwrite");
  tx.objectStore("records").put(value, "value");
  await new Promise((resolve, reject) => {
    tx.addEventListener("complete", resolve, { once: true });
    tx.addEventListener("error", () => reject(tx.error), { once: true });
  });
  db.close();
}

async function readProbe() {
  const db = await request(globalThis.indexedDB.open("crypto-runtime-probe", 1));
  if (!db.objectStoreNames.contains("records")) {
    db.close();
    return undefined;
  }
  const value = await request(db.transaction("records", "readonly").objectStore("records").get("value"));
  db.close();
  return value;
}

const stateA = await mkdtemp(join(tmpdir(), "letta-matrix-crypto-a-"));
const stateB = await mkdtemp(join(tmpdir(), "letta-matrix-crypto-b-"));
try {
  const calls = [];
  const first = await startCryptoRuntime({
    accountKey: "one",
    stateDir: stateA,
    client: { initRustCrypto: async (args) => { calls.push(args); await writeProbe("persisted"); } },
  });
  assert.deepEqual(calls, [{ useIndexedDB: true }]);
  await assert.rejects(
    () => startCryptoRuntime({ accountKey: "two", stateDir: stateB, client: { initRustCrypto: async () => {} } }),
    /Encrypted Matrix account one is already running/,
  );
  await first.stop();
  const second = await startCryptoRuntime({
    accountKey: "two",
    stateDir: stateB,
    client: { initRustCrypto: async () => { assert.equal(await readProbe(), undefined); } },
  });
  await second.stop();
  const restored = await startCryptoRuntime({
    accountKey: "one",
    stateDir: stateA,
    client: { initRustCrypto: async () => { assert.equal(await readProbe(), "persisted"); } },
  });
  await restored.stop();
  console.log("crypto runtime tests passed");
} finally {
  await rm(stateA, { recursive: true, force: true });
  await rm(stateB, { recursive: true, force: true });
}
