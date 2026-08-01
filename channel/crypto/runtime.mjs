// Adapted from the lifecycle structure in OpenClaw's Matrix extension
// (MIT, OpenClaw Foundation, 2026). See ../../THIRD_PARTY_NOTICES.md.

import { createRequire } from "node:module";
import {
  acquireCryptoStateLock,
  assertCryptoStateInactive,
  clearCryptoStateActive,
  clearInMemoryCryptoState,
  markCryptoStateActive,
  persistCryptoState,
  prepareCryptoStateIdentity,
  requiresCryptoProcessQuarantine,
  restoreCryptoState,
} from "./idb-state.mjs";

const ACTIVE_ACCOUNT = Symbol.for("letta-matrix-channel.active-encrypted-account");
const PERSISTENCE_INTERVAL_MS = 60_000;

function loadIndexedDbRuntime() {
  // Custom-channel dependencies live in channel/runtime/node_modules. This
  // cannot use a static import because runtime is a child of this module.
  const require = createRequire(new URL("../runtime/package.json", import.meta.url));
  require("fake-indexeddb/auto");
}

function claimEncryptedAccount(accountKey) {
  const active = globalThis[ACTIVE_ACCOUNT];
  if (active) {
    throw new Error(`Encrypted Matrix account ${active.accountKey} is already running in this listener process`);
  }
  const claim = { accountKey };
  globalThis[ACTIVE_ACCOUNT] = claim;
  return () => {
    if (globalThis[ACTIVE_ACCOUNT] === claim) delete globalThis[ACTIVE_ACCOUNT];
  };
}

function reportPersistenceError(error) {
  console.error("[matrix] periodic crypto state persistence failed:", error);
}

function runtimeStopFailure(error) {
  const retryable = !requiresCryptoProcessQuarantine(error);
  const failure = new AggregateError(
    [error],
    error instanceof Error ? error.message : String(error),
  );
  Object.defineProperties(failure, {
    matrixCryptoRuntimeStopRetryable: { value: retryable },
    matrixCryptoOwnershipRetained: { value: true },
    ...(retryable ? {} : {
      matrixCryptoProcessQuarantined: { value: true },
    }),
  });
  return failure;
}

/**
 * Serialize timer, barrier, and final snapshots. Explicit barriers always get
 * a new pass after work already in flight; interval ticks coalesce while one
 * interval checkpoint is queued.
 */
export function createCryptoPersistenceController({
  stateDir,
  persistState = persistCryptoState,
  intervalMs = PERSISTENCE_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = reportPersistenceError,
}) {
  let tail = Promise.resolve();
  let accepting = true;
  let intervalQueued = false;
  let barrierSlot = null;
  let stopPromise = null;
  let timerCleared = false;

  const enqueue = (onStart) => {
    const pending = tail.catch(() => undefined).then(() => {
      onStart?.();
      return persistState(stateDir);
    });
    tail = pending;
    return pending;
  };

  const intervalTick = () => {
    if (!accepting || intervalQueued) return;
    intervalQueued = true;
    void enqueue()
      .catch((error) => {
        try {
          onError(error);
        } catch {
          // Persistence errors are already represented by the rejected pass.
        }
      })
      .finally(() => {
        intervalQueued = false;
      });
  };

  const timer = setIntervalFn(intervalTick, intervalMs);
  timer?.unref?.();

  return {
    persist() {
      if (!accepting) {
        return Promise.reject(new Error("Matrix crypto persistence is stopping"));
      }
      if (barrierSlot && !barrierSlot.started) return barrierSlot.promise;
      const slot = { started: false, promise: null };
      const pending = enqueue(() => {
        slot.started = true;
      });
      slot.promise = pending.finally(() => {
        if (barrierSlot === slot) barrierSlot = null;
      });
      barrierSlot = slot;
      return slot.promise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      const attempt = (async () => {
        accepting = false;
        if (!timerCleared) {
          clearIntervalFn(timer);
          timerCleared = true;
        }
        return await enqueue();
      })();
      stopPromise = attempt;
      void attempt.catch(() => {
        if (stopPromise === attempt) stopPromise = null;
      });
      return attempt;
    },
  };
}

/**
 * Restore durable crypto state and initialize Matrix's Rust/WASM crypto before
 * the caller starts sync. If any step fails, no encrypted adapter may run.
 */
export async function startCryptoRuntime({
  client,
  accountKey,
  stateDir,
  identity,
  persistenceIntervalMs = PERSISTENCE_INTERVAL_MS,
  persistenceOptions = {},
}) {
  const releaseAccount = claimEncryptedAccount(accountKey);
  let releaseLock = null;
  let persistence = null;
  let activeMarkerToken = null;
  let cryptoTouched = false;
  try {
    loadIndexedDbRuntime();
    releaseLock = await acquireCryptoStateLock(stateDir);
    await assertCryptoStateInactive(stateDir);
    const state = await prepareCryptoStateIdentity(stateDir, identity, {
      allowBootstrap: releaseLock.stateDirectoryCreated,
    });
    await clearInMemoryCryptoState();
    if (!state.fresh) {
      const restoredGeneration = await restoreCryptoState(stateDir);
      if (!restoredGeneration) {
        throw new Error("Matrix crypto recovery required: the crypto snapshot could not be restored");
      }
      if (restoredGeneration.generation === "previous") {
        if (restoredGeneration.rejectedSnapshotPath) {
          console.error(
            "[matrix] current crypto snapshot was rejected; restored the previous generation and retained the rejected file for recovery",
          );
        } else {
          console.error(
            "[matrix] current crypto snapshot was missing; restored the previous generation",
          );
        }
      }
    }
    activeMarkerToken = await markCryptoStateActive(stateDir);
    cryptoTouched = true;
    await client.initRustCrypto({ useIndexedDB: true });
    await persistCryptoState(stateDir);
    persistence = createCryptoPersistenceController({
      stateDir,
      intervalMs: persistenceIntervalMs,
      ...persistenceOptions,
    });
    let stopPromise = null;
    let quarantinePromise = null;
    let quarantined = false;
    let persistenceStopped = false;
    let markerCleared = false;
    let lockReleased = false;
    let accountReleased = false;
    return {
      persist() {
        return persistence.persist();
      },
      quarantine() {
        quarantined = true;
        if (quarantinePromise) return quarantinePromise;
        const attempt = persistence.stop();
        quarantinePromise = attempt;
        void attempt.catch(() => {
          if (quarantinePromise === attempt) quarantinePromise = null;
        });
        return attempt;
      },
      stop() {
        if (quarantined) {
          return Promise.reject(
            new Error("Matrix crypto runtime is quarantined after unproven client shutdown"),
          );
        }
        if (stopPromise) return stopPromise;
        const attempt = (async () => {
          try {
            if (!persistenceStopped) {
              await persistence.stop();
              persistenceStopped = true;
            }
            if (!markerCleared) {
              await clearCryptoStateActive(stateDir, activeMarkerToken);
              markerCleared = true;
            }
            if (!lockReleased) {
              await releaseLock?.();
              lockReleased = true;
            }
            if (!accountReleased) {
              releaseAccount();
              accountReleased = true;
            }
          } catch (error) {
            throw runtimeStopFailure(error);
          }
        })();
        stopPromise = attempt;
        void attempt.catch(() => {
          if (stopPromise === attempt) stopPromise = null;
        });
        return attempt;
      },
    };
  } catch (error) {
    const cleanupErrors = [];
    let quarantineProcess = requiresCryptoProcessQuarantine(error);
    if (cryptoTouched) quarantineProcess = true;
    if (cryptoTouched) {
      try {
        await client.stopClient();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        quarantineProcess = true;
      }
    }
    try {
      await persistence?.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!quarantineProcess) {
      try {
        await releaseLock?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        quarantineProcess = true;
      }
      if (!quarantineProcess) {
        releaseAccount();
      }
    }
    let failure = error;
    if (cleanupErrors.length) {
      failure = new AggregateError(
        [error, ...cleanupErrors],
        `${error instanceof Error ? error.message : String(error)}; Matrix crypto startup cleanup failed`,
      );
    }
    if ((cryptoTouched || quarantineProcess) && !cleanupErrors.length) {
      failure = new AggregateError(
        [error],
        error instanceof Error ? error.message : String(error),
      );
    }
    if (cryptoTouched && failure && typeof failure === "object") {
      Object.defineProperty(failure, "matrixCryptoClientStopHandled", {
        value: true,
      });
    }
    if (quarantineProcess && failure && typeof failure === "object") {
      Object.defineProperty(failure, "matrixCryptoProcessQuarantined", {
        value: true,
      });
    }
    throw failure;
  }
}
