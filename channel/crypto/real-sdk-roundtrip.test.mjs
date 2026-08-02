import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "fake-indexeddb/auto";
import { createClient } from "matrix-js-sdk";
import { SyncApi } from "matrix-js-sdk/lib/sync.js";
import {
  drainMatrixClientCryptoWork,
  installMatrixSyncLoopTracking,
} from "../plugin.mjs";
import { startCryptoRuntime } from "./runtime.mjs";

installMatrixSyncLoopTracking(SyncApi);

const USER_ID = "@bot:example.org";
const DEVICE_ID = "DEVICE";
const IDENTITY = {
  homeserverUrl: "https://example.invalid/",
  userId: USER_ID,
  deviceId: DEVICE_ID,
  accountId: "real-sdk-roundtrip",
};
const fetchFn = async () => new Response(
  JSON.stringify({ errcode: "M_NOT_FOUND", error: "No current key backup" }),
  { status: 404, headers: { "content-type": "application/json" } },
);

function makeClient() {
  // Match the plugin lifecycle: /whoami supplies identity after createClient.
  const client = createClient({
    baseUrl: "https://example.invalid",
    accessToken: "test-token",
    fetchFn,
  });
  client.deviceId = DEVICE_ID;
  (client.credentials ??= {}).userId = USER_ID;
  client.credentials.deviceId = DEVICE_ID;
  return client;
}

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const root = await mkdtemp(join(tmpdir(), "matrix-real-roundtrip-"));
const stateDir = join(root, "state");
let first;
let second;
let syncProbe;
let firstRuntime;
let secondRuntime;
let testError;
try {
  syncProbe = createClient({
    baseUrl: "http://127.0.0.1:1",
    accessToken: "test-token",
    userId: USER_ID,
    deviceId: DEVICE_ID,
    localTimeoutMs: 100,
  });
  await syncProbe.startClient({ initialSyncLimit: 0 });
  await waitUntil(
    () => ["ERROR", "RECONNECTING"].includes(String(syncProbe.syncApi?.getSyncState?.())),
    "real Matrix SyncApi recovery state",
  );
  assert.equal(syncProbe.syncApi?.running, true);
  await drainMatrixClientCryptoWork(syncProbe, { timeoutMs: 5_000 });
  assert.equal(syncProbe.syncApi?.running, false);
  await syncProbe.stopClient();
  syncProbe = null;

  first = makeClient();
  firstRuntime = await startCryptoRuntime({
    client: first,
    accountKey: IDENTITY.accountId,
    stateDir,
    identity: IDENTITY,
  });
  const firstKeys = await first.getCrypto().getOwnDeviceKeys();
  assert.equal(typeof firstKeys.ed25519, "string");
  assert.ok(firstKeys.ed25519);
  assert.equal(typeof firstKeys.curve25519, "string");
  assert.ok(firstKeys.curve25519);

  first.clientRunning = true;
  first.syncApi = new SyncApi(first, { initialSyncLimit: 0 }, {});
  first.syncApi.syncState = "ERROR";
  assert.equal(typeof first.syncApi?.getSyncState, "function");
  assert.equal(typeof first.syncApi?.stop, "function");
  assert.equal(typeof first.syncApi?.retryImmediately, "function");
  assert.equal(typeof first.syncApi?.running, "boolean");
  assert.equal(typeof first.syncApi?.catchingUp, "boolean");
  assert.equal("currentSyncRequest" in first.syncApi, true);
  const firstCrypto = first.getCrypto();
  const firstOutgoing = firstCrypto.outgoingRequestsManager;
  const firstBackup = firstCrypto.backupManager;
  const firstBackupDownloader = firstCrypto.perSessionBackupDownloader;
  const firstKeyClaim = firstCrypto.keyClaimManager;
  assert.equal(typeof first.http?.abort, "function");
  assert.equal(typeof firstBackup?.stop, "function");
  assert.equal(typeof firstBackup?.stopped, "boolean");
  assert.equal(typeof firstBackup?.backupKeysLoopRunning, "boolean");
  assert.equal(firstBackup?.keyBackupCheckInProgress, null);
  assert.equal(typeof firstBackupDownloader?.stop, "function");
  assert.equal(typeof firstBackupDownloader?.stopped, "boolean");
  assert.equal(typeof firstBackupDownloader?.downloadLoopRunning, "boolean");
  assert.equal(firstBackupDownloader?.currentBackupVersionCheck, null);
  assert.equal(typeof firstKeyClaim?.stop, "function");
  assert.equal(typeof firstKeyClaim?.stopped, "boolean");
  assert.equal(typeof firstKeyClaim?.currentClaimPromise?.then, "function");
  assert.equal(typeof firstOutgoing?.doProcessOutgoingRequests, "function");
  assert.equal(typeof firstOutgoing?.stop, "function");
  assert.equal(typeof firstOutgoing?.stopped, "boolean");
  assert.equal(typeof firstOutgoing?.outgoingRequestLoopRunning, "boolean");
  // Match plugin shutdown: quiesce SDK crypto work, close the Matrix client,
  // then take the final authoritative snapshot and release ownership.
  await drainMatrixClientCryptoWork(first);
  await first.stopClient();
  await firstRuntime.stop();
  first = null;
  firstRuntime = null;
  assert.equal(existsSync(join(stateDir, "crypto-runtime.active")), false);
  assert.equal(existsSync(join(stateDir, "crypto-idb.lock")), false);

  second = makeClient();
  secondRuntime = await startCryptoRuntime({
    client: second,
    accountKey: IDENTITY.accountId,
    stateDir,
    identity: IDENTITY,
  });
  const secondKeys = await second.getCrypto().getOwnDeviceKeys();
  assert.equal(secondKeys.ed25519, firstKeys.ed25519);
  assert.equal(secondKeys.curve25519, firstKeys.curve25519);
  await drainMatrixClientCryptoWork(second);
  await second.stopClient();
  await secondRuntime.stop();
  second = null;
  secondRuntime = null;
  assert.equal(existsSync(join(stateDir, "crypto-runtime.active")), false);
  assert.equal(existsSync(join(stateDir, "crypto-idb.lock")), false);
  console.log("real Matrix Rust crypto lifecycle round-trip passed");
} catch (error) {
  testError = error;
}

const cleanupErrors = [];
try {
  await syncProbe?.stopClient();
} catch (error) {
  cleanupErrors.push(error);
}
for (const [client, runtime] of [[second, secondRuntime], [first, firstRuntime]]) {
  try {
    await client?.stopClient();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await runtime?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
}
try {
  await rm(root, { recursive: true, force: true });
} catch (error) {
  cleanupErrors.push(error);
}
if (testError) cleanupErrors.unshift(testError);
if (cleanupErrors.length === 1) throw cleanupErrors[0];
if (cleanupErrors.length > 1) {
  throw new AggregateError(cleanupErrors, "real Matrix crypto round-trip and cleanup failed");
}
