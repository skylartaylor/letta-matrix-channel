const {
  MATRIX_CONFIGURED_BASE_URL,
  MATRIX_HTTP_BASE_URL,
  MATRIX_ACCESS_TOKEN,
  MATRIX_ROOM_ID,
  MATRIX_STATE_DIR,
  MATRIX_ALLOWED_USER_ID,
  MATRIX_CRASH_MODE = "",
} = process.env;

if (
  !MATRIX_CONFIGURED_BASE_URL
  || !MATRIX_HTTP_BASE_URL
  || !MATRIX_ACCESS_TOKEN
  || !MATRIX_ROOM_ID
  || !MATRIX_STATE_DIR
  || !MATRIX_ALLOWED_USER_ID
) {
  throw new Error("Matrix bot child is missing configuration");
}
if (
  MATRIX_CRASH_MODE
  && MATRIX_CRASH_MODE !== "before-room-fetch"
  && MATRIX_CRASH_MODE !== "after-room-accept"
) {
  throw new Error(`Unknown Matrix bot crash mode ${MATRIX_CRASH_MODE}`);
}

console.debug = () => {};
console.info = () => {};

function isEncryptedRoomSend(url) {
  return /\/rooms\/[^/]+\/send\/m\.room\.encrypted\//.test(url.pathname);
}

let crashArmed = false;
let crashTriggered = false;
function makeTransport() {
  const httpOrigin = new URL(MATRIX_HTTP_BASE_URL);
  return async (input, init) => {
    const sourceUrl = typeof input === "string" || input instanceof URL
      ? new URL(String(input))
      : new URL(input.url);
    sourceUrl.protocol = httpOrigin.protocol;
    sourceUrl.hostname = httpOrigin.hostname;
    sourceUrl.port = httpOrigin.port;
    const shouldCrash = (
      crashArmed
      && !crashTriggered
      && isEncryptedRoomSend(sourceUrl)
    );
    if (shouldCrash && MATRIX_CRASH_MODE === "before-room-fetch") {
      crashTriggered = true;
      process.send?.({
        type: "crash-boundary",
        mode: MATRIX_CRASH_MODE,
      });
      return await new Promise(() => {});
    }
    const response = typeof input === "object" && input !== null && "url" in input
      ? await fetch(new Request(sourceUrl, input), init)
      : await fetch(sourceUrl, init);
    if (shouldCrash && MATRIX_CRASH_MODE === "after-room-accept") {
      crashTriggered = true;
      const payload = await response.clone().json();
      process.send?.({
        type: "crash-boundary",
        mode: MATRIX_CRASH_MODE,
        eventId: payload.event_id,
      });
      return await new Promise(() => {});
    }
    return response;
  };
}

const { channelPlugin } = await import("../plugin.mjs");
const adapter = channelPlugin.createAdapter({
  accountId: "e2ee-integration",
  config: {
    homeserverUrl: MATRIX_CONFIGURED_BASE_URL,
    bot_token: MATRIX_ACCESS_TOKEN,
    allowedRooms: [MATRIX_ROOM_ID],
    allowedUsers: [MATRIX_ALLOWED_USER_ID],
    mentionAliases: ["matrix"],
    encryption: {
      enabled: true,
      stateDir: MATRIX_STATE_DIR,
    },
  },
});
adapter.networkFetch = makeTransport();
const messages = [];
adapter.onMessage = async (message) => messages.push(message);

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
    case "sendMessage":
      crashArmed = Boolean(MATRIX_CRASH_MODE);
      return await adapter.sendMessage({
        chatId: MATRIX_ROOM_ID,
        text: command.text,
      });
    case "waitForMessage":
      return await waitUntil(
        () => messages.find(({ messageId, text }) => (
          messageId === command.eventId
          && (command.text === undefined || text === command.text)
        )),
        `bot message ${command.eventId}`,
      );
    case "stop":
      await adapter.stop();
      return {};
    default:
      throw new Error(`Unknown bot command ${command.action}`);
  }
}

try {
  await adapter.start();
  await waitUntil(
    () => adapter.initialSyncComplete && adapter.outboundRoomStateFresh,
    "bot adapter initial sync",
  );
  process.send?.({ type: "ready" });
} catch (error) {
  process.send?.({
    type: "startup-error",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }, () => process.exit(1));
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
