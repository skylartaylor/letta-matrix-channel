import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "fake-indexeddb/auto";
import { createClient } from "matrix-js-sdk";
import { startCryptoRuntime } from "./runtime.mjs";

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

const root = await mkdtemp(join(tmpdir(), "matrix-real-roundtrip-"));
const stateDir = join(root, "state");
let first;
let second;
let firstRuntime;
let secondRuntime;
let testError;
try {
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

  // Match plugin shutdown: close the Matrix client before the runtime takes
  // its final authoritative snapshot and releases persistent ownership.
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
