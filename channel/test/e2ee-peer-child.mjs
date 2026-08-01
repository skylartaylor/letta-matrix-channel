import { createClient } from "matrix-js-sdk";

console.debug = () => {};
console.info = () => {};

const {
  MATRIX_BASE_URL,
  MATRIX_ACCESS_TOKEN,
  MATRIX_USER_ID,
  MATRIX_DEVICE_ID,
} = process.env;

if (!MATRIX_BASE_URL || !MATRIX_ACCESS_TOKEN || !MATRIX_USER_ID || !MATRIX_DEVICE_ID) {
  throw new Error("Matrix peer child is missing login configuration");
}

const client = createClient({
  baseUrl: MATRIX_BASE_URL,
  accessToken: MATRIX_ACCESS_TOKEN,
  userId: MATRIX_USER_ID,
  deviceId: MATRIX_DEVICE_ID,
});
const messages = [];
const seenEventIds = new Set();

function recordMessage(event) {
  if (
    event?.isDecryptionFailure?.()
    || event?.getType?.() !== "m.room.message"
    || event?.getWireType?.() !== "m.room.encrypted"
  ) {
    return;
  }
  const eventId = event.getId?.();
  if (!eventId || seenEventIds.has(eventId)) return;
  const content = event.getContent?.();
  if (content?.msgtype !== "m.text" || typeof content.body !== "string") return;
  seenEventIds.add(eventId);
  messages.push({
    eventId,
    roomId: event.getRoomId?.(),
    sender: event.getSender?.(),
    text: content.body,
  });
}

client.on("Room.timeline", (event, _room, toStartOfTimeline, removed, data) => {
  if (!toStartOfTimeline && !removed && data?.liveEvent) recordMessage(event);
});
client.on("Event.decrypted", (event, error) => {
  if (!error) recordMessage(event);
});

await client.initRustCrypto({ useIndexedDB: false });
const prepared = new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Matrix peer initial sync timed out")),
    30_000,
  );
  client.on("sync", (state) => {
    if (String(state).toUpperCase() !== "PREPARED") return;
    clearTimeout(timeout);
    resolve();
  });
});
await client.startClient({ initialSyncLimit: 20 });
await prepared;

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function handleCommand(command) {
  switch (command.action) {
    case "createEncryptedRoom": {
      const response = await client.createRoom({
        name: "Letta Matrix E2EE integration",
        preset: "private_chat",
        invite: [command.botUserId],
        initial_state: [{
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        }],
      });
      await waitUntil(
        () => client.getRoom(response.room_id)?.hasEncryptionStateEvent?.(),
        "peer encrypted room state",
      );
      return { roomId: response.room_id };
    }
    case "waitForMember": {
      await waitUntil(
        () => client.getRoom(command.roomId)?.getMember(command.userId)?.membership === "join",
        `joined member ${command.userId}`,
      );
      return {};
    }
    case "waitForDevice": {
      await waitUntil(async () => {
        const devices = await client.getCrypto().getUserDeviceInfo([command.userId], true);
        return devices.get(command.userId)?.has(command.deviceId);
      }, `device ${command.userId} ${command.deviceId}`);
      return {};
    }
    case "sendMessage": {
      const response = await client.sendEvent(
        command.roomId,
        "m.room.message",
        { msgtype: "m.text", body: command.text },
      );
      return { eventId: response.event_id };
    }
    case "forceDiscardSession":
      await client.getCrypto().forceDiscardSession(command.roomId);
      return {};
    case "waitForMessage": {
      const message = await waitUntil(
        () => messages.find((candidate) => (
          candidate.roomId === command.roomId
          && candidate.sender === command.sender
          && candidate.text === command.text
        )),
        `decrypted message from ${command.sender}`,
      );
      return message;
    }
    case "stop":
      await client.stopClient();
      return {};
    default:
      throw new Error(`Unknown peer command ${command.action}`);
  }
}

let commandTail = Promise.resolve();
process.on("message", (command) => {
  commandTail = commandTail.then(async () => {
    try {
      const result = await handleCommand(command);
      const response = { id: command.id, ok: true, result };
      if (command.action === "stop") {
        if (process.send) process.send(response, () => process.exit(0));
        else process.exit(0);
      } else {
        process.send?.(response);
      }
    } catch (error) {
      process.send?.({
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  });
});

process.send?.({ type: "ready" });
