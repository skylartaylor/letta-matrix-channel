// Adapted from the lifecycle structure in OpenClaw's Matrix extension
// (MIT, OpenClaw Foundation, 2026). See ../../THIRD_PARTY_NOTICES.md.

import { createRequire } from "node:module";
import {
  acquireCryptoStateLock,
  clearInMemoryCryptoState,
  persistCryptoState,
  restoreCryptoState,
} from "./idb-state.mjs";

const ACTIVE_ACCOUNT = Symbol.for("letta-matrix-channel.active-encrypted-account");

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

/**
 * Restore durable crypto state and initialize Matrix's Rust/WASM crypto before
 * the caller starts sync. If any step fails, no encrypted adapter may run.
 */
export async function startCryptoRuntime({ client, accountKey, stateDir }) {
  const releaseAccount = claimEncryptedAccount(accountKey);
  let releaseLock = null;
  try {
    loadIndexedDbRuntime();
    releaseLock = await acquireCryptoStateLock(stateDir);
    await clearInMemoryCryptoState();
    await restoreCryptoState(stateDir);
    await client.initRustCrypto({ useIndexedDB: true });
    await persistCryptoState(stateDir);
    let stopPromise = null;
    return {
      stop() {
        stopPromise ??= (async () => {
          try {
            await persistCryptoState(stateDir);
          } finally {
            try {
              await releaseLock?.();
            } finally {
              releaseAccount();
            }
          }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    try {
      await releaseLock?.();
    } finally {
      releaseAccount();
    }
    throw error;
  }
}
