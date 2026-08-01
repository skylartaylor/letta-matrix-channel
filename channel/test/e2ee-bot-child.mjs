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
  && MATRIX_CRASH_MODE !== "after-incremental-sync-accept"
) {
  throw new Error(`Unknown Matrix bot crash mode ${MATRIX_CRASH_MODE}`);
}

console.debug = () => {};
console.info = () => {};

function isEncryptedRoomSend(url) {
  return /\/rooms\/[^/]+\/send\/m\.room\.encrypted\//.test(url.pathname);
}

function isIncrementalSync(url) {
  return url.pathname.endsWith("/sync") && url.searchParams.has("since");
}

let crashArmed = false;
let crashTriggered = false;
let cryptoSyncToAcknowledge = null;
let expectedSeedEventId = null;
let resolveSyncHeld;
const syncHeld = new Promise((resolve) => {
  resolveSyncHeld = resolve;
});
let releaseHeldSync;
const heldSyncReleased = new Promise((resolve) => {
  releaseHeldSync = resolve;
});
function makeTransport() {
  const httpOrigin = new URL(MATRIX_HTTP_BASE_URL);
  return async (input, init) => {
    const sourceUrl = typeof input === "string" || input instanceof URL
      ? new URL(String(input))
      : new URL(input.url);
    sourceUrl.protocol = httpOrigin.protocol;
    sourceUrl.hostname = httpOrigin.hostname;
    sourceUrl.port = httpOrigin.port;
    const shouldCrashRoomSend = (
      crashArmed
      && !crashTriggered
      && isEncryptedRoomSend(sourceUrl)
    );
    const incrementalSync = isIncrementalSync(sourceUrl);
    const requestedBatch = sourceUrl.searchParams.get("since");
    if (
      MATRIX_CRASH_MODE === "after-incremental-sync-accept"
      && incrementalSync
    ) {
      sourceUrl.searchParams.set("timeout", "1000");
    }
    const shouldHoldIncrementalSync = (
      crashArmed
      && !crashTriggered
      && MATRIX_CRASH_MODE === "after-incremental-sync-accept"
      && incrementalSync
      && cryptoSyncToAcknowledge === null
    );
    if (shouldHoldIncrementalSync) {
      resolveSyncHeld();
      await heldSyncReleased;
      sourceUrl.searchParams.set("timeout", "0");
    }
    const shouldCrashIncrementalSync = (
      crashArmed
      && !crashTriggered
      && MATRIX_CRASH_MODE === "after-incremental-sync-accept"
      && incrementalSync
      && requestedBatch === cryptoSyncToAcknowledge?.nextBatch
    );
    if (shouldCrashIncrementalSync) sourceUrl.searchParams.set("timeout", "0");
    const request = typeof input === "object" && input !== null && "url" in input
      ? new Request(new Request(sourceUrl, input), init)
      : new Request(sourceUrl, init);
    if (shouldCrashRoomSend && MATRIX_CRASH_MODE === "before-room-fetch") {
      crashTriggered = true;
      const content = await request.clone().json();
      const pathUrl = new URL(sourceUrl);
      pathUrl.searchParams.delete("access_token");
      process.send?.({
        type: "crash-boundary",
        mode: MATRIX_CRASH_MODE,
        heldRequest: {
          path: `${pathUrl.pathname}${pathUrl.search}`,
          content,
        },
      });
      return await new Promise(() => {});
    }
    const response = await fetch(request);
    if (shouldCrashRoomSend && MATRIX_CRASH_MODE === "after-room-accept") {
      crashTriggered = true;
      const payload = await response.clone().json();
      process.send?.({
        type: "crash-boundary",
        mode: MATRIX_CRASH_MODE,
        eventId: payload.event_id,
      });
      return await new Promise(() => {});
    }
    if (shouldCrashIncrementalSync) {
      crashTriggered = true;
      process.send?.({
        type: "crash-boundary",
        mode: MATRIX_CRASH_MODE,
        acknowledgedBatch: requestedBatch,
        toDeviceEventCount: cryptoSyncToAcknowledge.eventCount,
        seedEventId: cryptoSyncToAcknowledge.seedEventId,
      });
      return await new Promise(() => {});
    }
    if (shouldHoldIncrementalSync) {
      const payload = await response.clone().json();
      const cryptoEvents = (payload.to_device?.events ?? []).filter((event) => (
        event?.type === "m.room.encrypted"
        && event?.sender === MATRIX_ALLOWED_USER_ID
      ));
      const timelineEvents = (
        payload.rooms?.join?.[MATRIX_ROOM_ID]?.timeline?.events ?? []
      );
      if (!timelineEvents.some((event) => event?.event_id === expectedSeedEventId)) {
        throw new Error("Held Matrix sync did not contain the expected seed event");
      }
      if (!cryptoEvents.length) {
        throw new Error("Held Matrix sync did not contain peer encryption key material");
      }
      if (typeof payload.next_batch !== "string") {
        throw new Error("Held Matrix sync did not contain next_batch");
      }
      cryptoSyncToAcknowledge = {
        nextBatch: payload.next_batch,
        eventCount: cryptoEvents.length,
        seedEventId: expectedSeedEventId,
      };
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
      crashArmed = (
        MATRIX_CRASH_MODE === "before-room-fetch"
        || MATRIX_CRASH_MODE === "after-room-accept"
      );
      return await adapter.sendMessage({
        chatId: MATRIX_ROOM_ID,
        text: command.text,
      });
    case "armSyncCrash":
      if (MATRIX_CRASH_MODE !== "after-incremental-sync-accept") {
        throw new Error("Matrix bot sync crash mode is not configured");
      }
      if (crashArmed) throw new Error("Matrix bot sync crash is already armed");
      crashArmed = true;
      await syncHeld;
      return {};
    case "releaseSyncCrash":
      if (
        MATRIX_CRASH_MODE !== "after-incremental-sync-accept"
        || !crashArmed
        || cryptoSyncToAcknowledge !== null
      ) {
        throw new Error("Matrix bot sync crash is not waiting for release");
      }
      if (typeof command.eventId !== "string" || !command.eventId) {
        throw new Error("Matrix bot sync crash release requires an event ID");
      }
      expectedSeedEventId = command.eventId;
      releaseHeldSync();
      return {};
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
