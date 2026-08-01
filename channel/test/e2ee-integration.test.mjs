import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCryptoStateRecovery,
  recoverCryptoStateAfterCrash,
} from "../crypto/idb-state.mjs";

const SYNAPSE_IMAGE = process.env.MATRIX_SYNAPSE_IMAGE
  ?? "matrixdotorg/synapse@sha256:6345789f58048687f3024a99d3d59b5444fc9cc1de61d2947000cbac89573fcb";
const PASSWORD = "local-e2ee-integration-password";
const BOT_DEVICE_ID = "LETTAE2EE";
const REPLACEMENT_BOT_DEVICE_ID = "LETTAE2EENEW";
const PEER_DEVICE_ID = "PEERE2EE";
const BOT_USER_ID = "@bot:localhost";
const PEER_USER_ID = "@peer:localhost";
const originalConsoleDebug = console.debug;
const originalConsoleInfo = console.info;
console.debug = () => {};
console.info = () => {};
const containerName = `letta-matrix-e2ee-${process.pid}-${Date.now()}`;
const cacheRoot = join(homedir(), ".cache");
mkdirSync(cacheRoot, { recursive: true });
const testRoot = mkdtempSync(join(cacheRoot, "letta-matrix-e2ee-"));
const synapseState = join(testRoot, "synapse");
const botState = join(testRoot, "bot-crypto");
const replacementBotState = join(testRoot, "bot-crypto-replacement");
mkdirSync(synapseState, { mode: 0o700 });

let encryptedAdapter = null;
let replacementAdapter = null;
let plaintextAdapter = null;
let peer = null;
let peerRequest = null;
let bot = null;
let containerStarted = false;

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  }).trim();
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function matrixRequest(baseUrl, path, {
  method = "GET",
  token,
  body,
} = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Matrix ${method} ${path} failed (${response.status}): ${text}`);
  }
  return payload;
}

async function login(baseUrl, localpart, deviceId) {
  return await matrixRequest(baseUrl, "/_matrix/client/v3/login", {
    method: "POST",
    body: {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: localpart },
      password: PASSWORD,
      device_id: deviceId,
      initial_device_display_name: "Letta Matrix E2EE integration",
    },
  });
}

async function deleteDevice(baseUrl, token, userId, deviceId) {
  const path = `/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`;
  const challengeResponse = await fetch(new URL(path, baseUrl), {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const challenge = await challengeResponse.json();
  assert.equal(challengeResponse.status, 401);
  assert.equal(typeof challenge.session, "string");
  assert.equal(
    challenge.flows?.some(({ stages }) => stages?.includes("m.login.password")),
    true,
  );
  await matrixRequest(baseUrl, path, {
    method: "DELETE",
    token,
    body: {
      auth: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password: PASSWORD,
        session: challenge.session,
      },
    },
  });
}

function makeTransport(httpBaseUrl, onRequest = () => {}) {
  const httpOrigin = new URL(httpBaseUrl);
  return async (input, init) => {
    const sourceUrl = typeof input === "string" || input instanceof URL
      ? new URL(String(input))
      : new URL(input.url);
    sourceUrl.protocol = httpOrigin.protocol;
    sourceUrl.hostname = httpOrigin.hostname;
    sourceUrl.port = httpOrigin.port;
    onRequest(sourceUrl, init);
    if (typeof input === "object" && input !== null && "url" in input) {
      return await fetch(new Request(sourceUrl, input), init);
    }
    return await fetch(sourceUrl, init);
  };
}

async function startPeer(loginResponse, baseUrl) {
  const child = fork(
    fileURLToPath(new URL("./e2ee-peer-child.mjs", import.meta.url)),
    [],
    {
      env: {
        ...process.env,
        MATRIX_BASE_URL: baseUrl,
        MATRIX_ACCESS_TOKEN: loginResponse.access_token,
        MATRIX_USER_ID: loginResponse.user_id,
        MATRIX_DEVICE_ID: loginResponse.device_id,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Matrix peer child startup timed out")),
      30_000,
    );
    child.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timeout);
        resolve();
        return;
      }
      const slot = pending.get(message?.id);
      if (!slot) return;
      pending.delete(message.id);
      clearTimeout(slot.timeout);
      if (message.ok) slot.resolve(message.result);
      else slot.reject(new Error(message.error));
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) return;
      reject(new Error(`Matrix peer child exited early code=${code} signal=${signal}`));
    });
  });
  try {
    await ready;
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitUntil(
      () => child.exitCode !== null || child.signalCode !== null,
      "failed Matrix peer child exit",
      5_000,
    );
    throw error;
  }
  return {
    child,
    request(action, payload = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Matrix peer command ${action} timed out`));
        }, 30_000);
        pending.set(id, { resolve, reject, timeout });
        child.send({ id, action, ...payload });
      });
    },
  };
}

async function startBot({
  botLogin,
  configuredBaseUrl,
  httpBaseUrl,
  roomId,
  crashMode = "",
}) {
  const child = fork(
    fileURLToPath(new URL("./e2ee-bot-child.mjs", import.meta.url)),
    [],
    {
      env: {
        ...process.env,
        MATRIX_CONFIGURED_BASE_URL: configuredBaseUrl,
        MATRIX_HTTP_BASE_URL: httpBaseUrl,
        MATRIX_ACCESS_TOKEN: botLogin.access_token,
        MATRIX_ROOM_ID: roomId,
        MATRIX_STATE_DIR: botState,
        MATRIX_ALLOWED_USER_ID: PEER_USER_ID,
        MATRIX_CRASH_MODE: crashMode,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const pending = new Map();
  const queuedBoundaries = [];
  const boundaryWaiters = [];
  let nextId = 1;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Matrix bot child startup timed out")),
      30_000,
    );
    const fail = (error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timeout);
      reject(error);
    };
    child.on("message", (message) => {
      if (message?.type === "ready") {
        if (readySettled) return;
        readySettled = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (message?.type === "startup-error") {
        fail(new Error(message.error));
        return;
      }
      if (message?.type === "crash-boundary") {
        const waiter = boundaryWaiters.shift();
        if (waiter) {
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        } else {
          queuedBoundaries.push(message);
        }
        return;
      }
      const slot = pending.get(message?.id);
      if (!slot) return;
      pending.delete(message.id);
      clearTimeout(slot.timeout);
      if (message.ok) slot.resolve(message.result);
      else slot.reject(new Error(message.error));
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      const error = new Error(`Matrix bot child exited code=${code} signal=${signal}`);
      fail(error);
      for (const slot of pending.values()) {
        clearTimeout(slot.timeout);
        slot.reject(error);
      }
      pending.clear();
      for (const waiter of boundaryWaiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    });
  });
  try {
    await ready;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitUntil(
      () => child.exitCode !== null || child.signalCode !== null,
      "failed Matrix bot child exit",
      5_000,
    ).catch(() => {});
    throw error;
  }
  return {
    child,
    request(action, payload = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Matrix bot command ${action} timed out`));
        }, 30_000);
        pending.set(id, { resolve, reject, timeout });
        child.send({ id, action, ...payload }, (error) => {
          if (!error) return;
          const slot = pending.get(id);
          if (!slot) return;
          pending.delete(id);
          clearTimeout(slot.timeout);
          reject(error);
        });
      });
    },
    waitForCrashBoundary() {
      const queued = queuedBoundaries.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = boundaryWaiters.findIndex((slot) => slot.resolve === resolve);
          if (index >= 0) boundaryWaiters.splice(index, 1);
          reject(new Error("Matrix bot crash boundary timed out"));
        }, 30_000);
        boundaryWaiters.push({ resolve, reject, timeout });
      });
    },
  };
}

async function findRawEvent(baseUrl, token, roomId, eventId) {
  return await waitUntil(async () => {
    const response = await matrixRequest(
      baseUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`,
      { token },
    );
    return response.chunk?.find((event) => event.event_id === eventId);
  }, `raw Matrix event ${eventId}`);
}

async function queryDeviceKeys(baseUrl, token, userId, deviceId) {
  return await waitUntil(async () => {
    const response = await matrixRequest(baseUrl, "/_matrix/client/v3/keys/query", {
      method: "POST",
      token,
      body: { device_keys: { [userId]: [deviceId] } },
    });
    return response.device_keys?.[userId]?.[deviceId]?.keys;
  }, `Matrix device keys for ${userId} ${deviceId}`);
}

async function waitForDeviceAbsent(baseUrl, token, userId, deviceId) {
  await waitUntil(async () => {
    const response = await matrixRequest(baseUrl, "/_matrix/client/v3/keys/query", {
      method: "POST",
      token,
      body: { device_keys: { [userId]: [deviceId] } },
    });
    return response.device_keys?.[userId]?.[deviceId] === undefined;
  }, `deleted Matrix device ${userId} ${deviceId}`);
}

async function countRawBotEncryptedEvents(baseUrl, token, roomId) {
  const response = await matrixRequest(
    baseUrl,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`,
    { token },
  );
  return response.chunk?.filter((event) => (
    event.sender === BOT_USER_ID
    && event.type === "m.room.encrypted"
  )).length ?? 0;
}

async function recoverCrashedBot(configuredBaseUrl) {
  const inspection = await inspectCryptoStateRecovery(botState);
  assert.equal(inspection.marker.processLive, false);
  const recovered = await recoverCryptoStateAfterCrash({
    stateDir: botState,
    markerToken: inspection.marker.token,
    expectedIdentity: {
      homeserverUrl: new URL(configuredBaseUrl).href,
      userId: BOT_USER_ID,
      deviceId: BOT_DEVICE_ID,
      accountId: "e2ee-integration",
    },
  });
  assert.equal(existsSync(recovered.recoveredMarkerPath), true);
  return recovered;
}

async function runCrashScenario({
  mode,
  botLogin,
  peerLogin,
  configuredBaseUrl,
  httpBaseUrl,
  roomId,
  keysBeforeCrash,
}) {
  const rawCountBefore = await countRawBotEncryptedEvents(
    httpBaseUrl,
    botLogin.access_token,
    roomId,
  );
  bot = await startBot({
    botLogin,
    configuredBaseUrl,
    httpBaseUrl,
    roomId,
    crashMode: mode,
  });
  const crashText = `${mode} encrypted event`;
  const send = bot.request("sendMessage", { text: crashText });
  const boundary = await bot.waitForCrashBoundary();
  assert.equal(boundary.mode, mode);
  const exited = once(bot.child, "exit");
  bot.child.kill("SIGKILL");
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, null);
  assert.equal(signal, "SIGKILL");
  await assert.rejects(send, /Matrix bot child exited/);
  bot = null;

  if (mode === "before-room-fetch") {
    assert.equal(boundary.eventId, undefined);
    assert.equal(
      await countRawBotEncryptedEvents(
        httpBaseUrl,
        botLogin.access_token,
        roomId,
      ),
      rawCountBefore,
      "pre-network crash does not publish the encrypted room event",
    );
  } else {
    assert.equal(typeof boundary.eventId, "string");
    const rawAccepted = await findRawEvent(
      httpBaseUrl,
      botLogin.access_token,
      roomId,
      boundary.eventId,
    );
    assert.equal(rawAccepted.type, "m.room.encrypted");
    const acceptedByPeer = await peerRequest("waitForMessage", {
      roomId,
      sender: BOT_USER_ID,
      text: crashText,
    });
    assert.equal(acceptedByPeer.eventId, boundary.eventId);
    assert.equal(
      await countRawBotEncryptedEvents(
        httpBaseUrl,
        botLogin.access_token,
        roomId,
      ),
      rawCountBefore + 1,
      "post-accept crash publishes exactly one encrypted room event",
    );
  }

  await assert.rejects(
    () => startBot({
      botLogin,
      configuredBaseUrl,
      httpBaseUrl,
      roomId,
    }),
    /previous encrypted runtime did not shut down cleanly/,
  );
  await recoverCrashedBot(configuredBaseUrl);

  bot = await startBot({
    botLogin,
    configuredBaseUrl,
    httpBaseUrl,
    roomId,
  });
  const resumedText = `${mode} encrypted event after recovery`;
  const resumed = await bot.request("sendMessage", { text: resumedText });
  const rawResumed = await findRawEvent(
    httpBaseUrl,
    botLogin.access_token,
    roomId,
    resumed.messageId,
  );
  assert.equal(rawResumed.type, "m.room.encrypted");
  const resumedByPeer = await peerRequest("waitForMessage", {
    roomId,
    sender: BOT_USER_ID,
    text: resumedText,
  });
  assert.equal(resumedByPeer.eventId, resumed.messageId);
  const keysAfterRecovery = await queryDeviceKeys(
    httpBaseUrl,
    peerLogin.access_token,
    BOT_USER_ID,
    BOT_DEVICE_ID,
  );
  assert.deepEqual(
    keysAfterRecovery,
    keysBeforeCrash,
    `${mode} recovery preserves the Matrix device identity`,
  );

  const inboundText = `matrix inbound after ${mode}`;
  const inbound = await peerRequest("sendMessage", {
    roomId,
    text: inboundText,
  });
  const delivered = await bot.request("waitForMessage", {
    eventId: inbound.eventId,
    text: inboundText,
  });
  assert.equal(delivered.messageId, inbound.eventId);
  await bot.request("stop");
  await waitUntil(() => bot.child.exitCode !== null, "Matrix bot child exit", 5_000);
  bot = null;
}

try {
  try {
    docker(["image", "inspect", SYNAPSE_IMAGE], { quiet: true });
  } catch {
    docker(["pull", SYNAPSE_IMAGE]);
  }
  docker([
    "run",
    "--rm",
    "-e", "SYNAPSE_SERVER_NAME=localhost",
    "-e", "SYNAPSE_REPORT_STATS=no",
    "-v", `${synapseState}:/data`,
    SYNAPSE_IMAGE,
    "generate",
  ]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name", containerName,
    "-p", "127.0.0.1::8008",
    "-v", `${synapseState}:/data`,
    SYNAPSE_IMAGE,
  ]);
  containerStarted = true;
  const portLine = docker(["port", containerName, "8008/tcp"], { quiet: true });
  const port = Number(portLine.match(/:(\d+)$/)?.[1]);
  assert.equal(Number.isSafeInteger(port), true, `Could not parse Synapse port: ${portLine}`);
  const httpBaseUrl = `http://127.0.0.1:${port}`;
  const configuredBaseUrl = `https://127.0.0.1:${port}`;
  await waitUntil(
    async () => {
      try {
        const response = await fetch(`${httpBaseUrl}/_matrix/client/versions`);
        return response.ok;
      } catch {
        return false;
      }
    },
    "local Synapse startup",
  );

  for (const user of ["bot", "peer"]) {
    docker([
      "exec",
      containerName,
      "register_new_matrix_user",
      "-c", "/data/homeserver.yaml",
      "http://localhost:8008",
      "-u", user,
      "-p", PASSWORD,
      "--no-admin",
    ]);
  }

  const botLogin = await login(httpBaseUrl, "bot", BOT_DEVICE_ID);
  const peerLogin = await login(httpBaseUrl, "peer", PEER_DEVICE_ID);
  assert.equal(botLogin.user_id, BOT_USER_ID);
  assert.equal(botLogin.device_id, BOT_DEVICE_ID);
  assert.equal(peerLogin.user_id, PEER_USER_ID);
  assert.equal(peerLogin.device_id, PEER_DEVICE_ID);

  peer = await startPeer(peerLogin, httpBaseUrl);
  peerRequest = peer.request;
  const { roomId } = await peerRequest("createEncryptedRoom", {
    botUserId: BOT_USER_ID,
  });
  await matrixRequest(
    httpBaseUrl,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { method: "POST", token: botLogin.access_token, body: {} },
  );
  await peerRequest("waitForMember", { roomId, userId: BOT_USER_ID });

  const runtimeStub = fileURLToPath(new URL("../runtime/", import.meta.url));
  const stubSdk = join(runtimeStub, "node_modules", "matrix-js-sdk", "index.js");
  if (existsSync(stubSdk) && readFileSync(stubSdk, "utf8").includes("__matrixCreateClient")) {
    rmSync(runtimeStub, { recursive: true, force: true });
  }
  const { channelPlugin } = await import("../plugin.mjs");
  const account = {
    accountId: "e2ee-integration",
    config: {
      homeserverUrl: configuredBaseUrl,
      bot_token: botLogin.access_token,
      allowedRooms: [roomId],
      allowedUsers: [PEER_USER_ID],
      mentionAliases: ["matrix"],
      encryption: { enabled: true, stateDir: botState },
    },
  };
  const inbound = [];
  encryptedAdapter = channelPlugin.createAdapter(account);
  encryptedAdapter.networkFetch = makeTransport(httpBaseUrl);
  encryptedAdapter.onMessage = async (message) => inbound.push(message);
  await encryptedAdapter.start();
  await waitUntil(
    () => encryptedAdapter.initialSyncComplete && encryptedAdapter.outboundRoomStateFresh,
    "encrypted adapter initial sync",
  );
  await peerRequest("waitForDevice", {
    userId: BOT_USER_ID,
    deviceId: BOT_DEVICE_ID,
  });
  await assert.rejects(
    () => startBot({
      botLogin,
      configuredBaseUrl,
      httpBaseUrl,
      roomId,
    }),
    /crypto state is already in use by process/,
  );

  const inboundText = "matrix real encrypted inbound";
  const peerSent = await peerRequest("sendMessage", { roomId, text: inboundText });
  await waitUntil(() => inbound.some(({ messageId }) => messageId === peerSent.eventId), "adapter decrypted inbound");
  assert.equal(inbound.filter(({ messageId }) => messageId === peerSent.eventId).length, 1);
  assert.equal(inbound.find(({ messageId }) => messageId === peerSent.eventId).text, inboundText);
  const rawInbound = await findRawEvent(httpBaseUrl, botLogin.access_token, roomId, peerSent.eventId);
  assert.equal(rawInbound.type, "m.room.encrypted");
  assert.equal(rawInbound.content.algorithm, "m.megolm.v1.aes-sha2");
  assert.equal("body" in rawInbound.content, false);

  const outboundText = "real encrypted outbound";
  const adapterSent = await encryptedAdapter.sendMessage({ chatId: roomId, text: outboundText });
  const rawOutbound = await findRawEvent(
    httpBaseUrl,
    botLogin.access_token,
    roomId,
    adapterSent.messageId,
  );
  assert.equal(rawOutbound.type, "m.room.encrypted");
  assert.equal(rawOutbound.content.algorithm, "m.megolm.v1.aes-sha2");
  assert.equal("body" in rawOutbound.content, false);
  const peerReceived = await peerRequest("waitForMessage", {
    roomId,
    sender: BOT_USER_ID,
    text: outboundText,
  });
  assert.equal(peerReceived.eventId, adapterSent.messageId);

  const keysBeforeRestart = await queryDeviceKeys(
    httpBaseUrl,
    peerLogin.access_token,
    BOT_USER_ID,
    BOT_DEVICE_ID,
  );
  await encryptedAdapter.stop();
  await encryptedAdapter.start();
  await waitUntil(
    () => encryptedAdapter.initialSyncComplete && encryptedAdapter.outboundRoomStateFresh,
    "encrypted adapter restart sync",
  );
  const keysAfterRestart = await queryDeviceKeys(
    httpBaseUrl,
    peerLogin.access_token,
    BOT_USER_ID,
    BOT_DEVICE_ID,
  );
  assert.deepEqual(keysAfterRestart, keysBeforeRestart, "clean restart preserves the Matrix device identity");

  const restartedOutboundText = "encrypted outbound after restart";
  const restartedAdapterSent = await encryptedAdapter.sendMessage({
    chatId: roomId,
    text: restartedOutboundText,
  });
  const rawRestartedOutbound = await findRawEvent(
    httpBaseUrl,
    botLogin.access_token,
    roomId,
    restartedAdapterSent.messageId,
  );
  assert.equal(rawRestartedOutbound.type, "m.room.encrypted");
  const peerReceivedAfterRestart = await peerRequest("waitForMessage", {
    roomId,
    sender: BOT_USER_ID,
    text: restartedOutboundText,
  });
  assert.equal(peerReceivedAfterRestart.eventId, restartedAdapterSent.messageId);
  const keysAfterRestartTraffic = await queryDeviceKeys(
    httpBaseUrl,
    peerLogin.access_token,
    BOT_USER_ID,
    BOT_DEVICE_ID,
  );
  assert.deepEqual(
    keysAfterRestartTraffic,
    keysBeforeRestart,
    "device identity remains stable after post-restart crypto requests drain",
  );

  const restartedInboundText = "matrix encrypted after restart";
  const restartedPeerSent = await peerRequest("sendMessage", {
    roomId,
    text: restartedInboundText,
  });
  await waitUntil(
    () => inbound.some(({ messageId }) => messageId === restartedPeerSent.eventId),
    "adapter decrypted inbound after restart",
  );
  assert.equal(
    inbound.filter(({ messageId }) => messageId === restartedPeerSent.eventId).length,
    1,
  );
  await encryptedAdapter.stop();

  await runCrashScenario({
    mode: "before-room-fetch",
    botLogin,
    peerLogin,
    configuredBaseUrl,
    httpBaseUrl,
    roomId,
    keysBeforeCrash: keysBeforeRestart,
  });
  await runCrashScenario({
    mode: "after-room-accept",
    botLogin,
    peerLogin,
    configuredBaseUrl,
    httpBaseUrl,
    roomId,
    keysBeforeCrash: keysBeforeRestart,
  });

  let plaintextRoomSendRequests = 0;
  plaintextAdapter = channelPlugin.createAdapter({
    ...account,
    accountId: "plaintext-integration",
    config: {
      ...account.config,
      encryption: { enabled: false },
    },
  });
  plaintextAdapter.networkFetch = makeTransport(httpBaseUrl, (url) => {
    if (/\/rooms\/[^/]+\/send\//.test(url.pathname)) plaintextRoomSendRequests += 1;
  });
  const plaintextStarting = plaintextAdapter.start();
  await assert.rejects(
    () => plaintextAdapter.sendMessage({
      chatId: roomId,
      text: "must not leave before sync",
    }),
    /refusing Matrix outbound before initial sync completes/,
  );
  await plaintextStarting;
  await waitUntil(
    () => plaintextAdapter.initialSyncComplete && plaintextAdapter.outboundRoomStateFresh,
    "plaintext adapter initial sync",
  );
  await assert.rejects(
    () => plaintextAdapter.sendMessage({ chatId: roomId, text: "must not leave plaintext" }),
    /refusing to send plaintext into encrypted Matrix room/,
  );
  assert.equal(plaintextRoomSendRequests, 0);
  await plaintextAdapter.stop();
  plaintextAdapter = null;

  const currentSnapshot = join(botState, "crypto-idb.snapshot");
  const previousSnapshot = join(botState, "crypto-idb.snapshot.previous");
  assert.equal(existsSync(previousSnapshot), true);
  writeFileSync(currentSnapshot, "corrupt real-room crypto snapshot");
  let cryptoWriteRequestsAfterCorruption = 0;
  encryptedAdapter.networkFetch = makeTransport(httpBaseUrl, (url) => {
    if (
      /\/keys\/upload$/.test(url.pathname)
      || /\/sendToDevice\/m\.room\.encrypted\//.test(url.pathname)
      || /\/rooms\/[^/]+\/send\/m\.room\.encrypted\//.test(url.pathname)
    ) {
      cryptoWriteRequestsAfterCorruption += 1;
    }
  });
  await assert.rejects(
    () => encryptedAdapter.start(),
    /previous-generation rollback is forbidden/,
  );
  assert.equal(cryptoWriteRequestsAfterCorruption, 0);
  assert.equal(readFileSync(currentSnapshot, "utf8"), "corrupt real-room crypto snapshot");
  assert.equal(existsSync(previousSnapshot), true);
  await encryptedAdapter.stop();
  encryptedAdapter = null;

  const replacementLogin = await login(
    httpBaseUrl,
    "bot",
    REPLACEMENT_BOT_DEVICE_ID,
  );
  assert.equal(replacementLogin.user_id, BOT_USER_ID);
  assert.equal(replacementLogin.device_id, REPLACEMENT_BOT_DEVICE_ID);
  let replacementWritesAgainstOldState = 0;
  replacementAdapter = channelPlugin.createAdapter({
    ...account,
    config: {
      ...account.config,
      bot_token: replacementLogin.access_token,
    },
  });
  replacementAdapter.networkFetch = makeTransport(httpBaseUrl, (url) => {
    if (
      /\/keys\/upload$/.test(url.pathname)
      || /\/sendToDevice\/m\.room\.encrypted\//.test(url.pathname)
      || /\/rooms\/[^/]+\/send\/m\.room\.encrypted\//.test(url.pathname)
    ) {
      replacementWritesAgainstOldState += 1;
    }
  });
  await assert.rejects(
    () => replacementAdapter.start(),
    /stored deviceId does not match the authenticated device/,
  );
  assert.equal(replacementWritesAgainstOldState, 0);
  await replacementAdapter.stop();

  const replacementInbound = [];
  replacementAdapter = channelPlugin.createAdapter({
    ...account,
    config: {
      ...account.config,
      bot_token: replacementLogin.access_token,
      encryption: {
        enabled: true,
        stateDir: replacementBotState,
      },
    },
  });
  replacementAdapter.networkFetch = makeTransport(httpBaseUrl);
  replacementAdapter.onMessage = async (message) => replacementInbound.push(message);
  await replacementAdapter.start();
  await waitUntil(
    () => replacementAdapter.initialSyncComplete && replacementAdapter.outboundRoomStateFresh,
    "replacement encrypted adapter initial sync",
  );
  await peerRequest("waitForDevice", {
    userId: BOT_USER_ID,
    deviceId: REPLACEMENT_BOT_DEVICE_ID,
  });
  const replacementKeys = await queryDeviceKeys(
    httpBaseUrl,
    peerLogin.access_token,
    BOT_USER_ID,
    REPLACEMENT_BOT_DEVICE_ID,
  );
  for (const algorithm of ["curve25519", "ed25519"]) {
    const oldKey = keysBeforeRestart[`${algorithm}:${BOT_DEVICE_ID}`];
    const replacementKey = (
      replacementKeys[`${algorithm}:${REPLACEMENT_BOT_DEVICE_ID}`]
    );
    assert.equal(typeof oldKey, "string");
    assert.equal(typeof replacementKey, "string");
    assert.notEqual(
      replacementKey,
      oldKey,
      `replacement device must use new ${algorithm} key material`,
    );
  }
  await deleteDevice(
    httpBaseUrl,
    replacementLogin.access_token,
    BOT_USER_ID,
    BOT_DEVICE_ID,
  );
  await waitForDeviceAbsent(
    httpBaseUrl,
    peerLogin.access_token,
    BOT_USER_ID,
    BOT_DEVICE_ID,
  );
  const oldTokenResponse = await fetch(
    new URL("/_matrix/client/v3/account/whoami", httpBaseUrl),
    { headers: { authorization: `Bearer ${botLogin.access_token}` } },
  );
  assert.equal(oldTokenResponse.status, 401, "revoking the old device invalidates its token");
  const replacementOutboundText = "encrypted outbound from replacement device";
  const replacementSent = await replacementAdapter.sendMessage({
    chatId: roomId,
    text: replacementOutboundText,
  });
  const rawReplacement = await findRawEvent(
    httpBaseUrl,
    replacementLogin.access_token,
    roomId,
    replacementSent.messageId,
  );
  assert.equal(rawReplacement.type, "m.room.encrypted");
  const replacementReceived = await peerRequest("waitForMessage", {
    roomId,
    sender: BOT_USER_ID,
    text: replacementOutboundText,
  });
  assert.equal(replacementReceived.eventId, replacementSent.messageId);
  const replacementInboundText = "matrix encrypted inbound to replacement device";
  const replacementPeerSent = await peerRequest("sendMessage", {
    roomId,
    text: replacementInboundText,
  });
  await waitUntil(
    () => replacementInbound.some(
      ({ messageId }) => messageId === replacementPeerSent.eventId,
    ),
    "replacement adapter decrypted inbound",
  );
  await replacementAdapter.stop();
  replacementAdapter = null;

  await peerRequest("stop");
  await waitUntil(() => peer.child.exitCode !== null, "Matrix peer child exit", 5_000);
  peerRequest = null;
  console.log("real Matrix encrypted-room integration passed");
} finally {
  await plaintextAdapter?.stop().catch(() => {});
  await encryptedAdapter?.stop().catch(() => {});
  await replacementAdapter?.stop().catch(() => {});
  if (peerRequest) await peerRequest("stop").catch(() => {});
  if (bot?.child.exitCode === null && bot?.child.signalCode === null) {
    bot.child.kill("SIGTERM");
    await waitUntil(
      () => bot.child.exitCode !== null || bot.child.signalCode !== null,
      "Matrix bot cleanup exit",
      5_000,
    ).catch(() => {});
  }
  if (peer?.child.exitCode === null && peer?.child.signalCode === null) {
    peer.child.kill("SIGTERM");
    await waitUntil(
      () => peer.child.exitCode !== null || peer.child.signalCode !== null,
      "Matrix peer cleanup exit",
      5_000,
    )
      .catch(() => {});
  }
  if (containerStarted) {
    try {
      docker(["stop", "--timeout", "5", containerName], { quiet: true });
    } catch {
      // The --rm container may already be gone after a startup failure.
    }
  }
  rmSync(testRoot, { recursive: true, force: true });
  console.debug = originalConsoleDebug;
  console.info = originalConsoleInfo;
}

// Rust crypto owns background timers after MatrixClient.stopClient(); this is a
// standalone integration-test process, so exit explicitly after full cleanup.
process.exit(0);
