import assert from "node:assert/strict";
import fs, { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  acquireCryptoStateLock,
  requiresCryptoProcessQuarantine,
} from "./idb-state.mjs";

const stateDir = await mkdtemp(join(tmpdir(), "letta-matrix-lock-interleaving-"));
const canonical = join(stateDir, "crypto-idb.lock");
const originalOpen = fs.promises.open;
const originalRm = fs.promises.rm;
let releaseBlockedCandidate;
let reportBlockedCandidate;
const blockedCandidate = new Promise((resolve) => {
  reportBlockedCandidate = resolve;
});
const allowBlockedCandidate = new Promise((resolve) => {
  releaseBlockedCandidate = resolve;
});
let shouldBlockTransitionCandidate = true;
let failedCanonicalRetirementSync = false;

try {
  const releaseA = await acquireCryptoStateLock(stateDir);
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const openedPath = String(args[0]);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (
        shouldBlockTransitionCandidate
        && basename(openedPath).startsWith(".crypto-idb.lock.takeover.")
        && basename(openedPath).endsWith(".candidate")
      ) {
        shouldBlockTransitionCandidate = false;
        reportBlockedCandidate();
        await allowBlockedCandidate;
      }
      if (
        !failedCanonicalRetirementSync
        && openedPath === stateDir
        && !existsSync(canonical)
        && readdirSync(stateDir).some((name) => name.startsWith("crypto-idb.lock.released."))
      ) {
        failedCanonicalRetirementSync = true;
        const error = new Error("injected canonical retirement sync failure");
        error.code = "EIO";
        throw error;
      }
      return await originalSync();
    };
    return handle;
  };
  syncBuiltinESMExports();

  // B passes its optimistic pending-release check, then pauses while preparing
  // its transition candidate. A starts releasing, retires its canonical lock,
  // and fails after that destructive phase.
  const acquiringB = acquireCryptoStateLock(stateDir);
  await blockedCandidate;
  await assert.rejects(
    () => releaseA(),
    (error) => {
      assert.match(String(error), /injected canonical retirement sync failure/);
      assert.equal(error.matrixCryptoLockReleaseRetryable, true);
      return true;
    },
  );
  assert.equal(existsSync(canonical), false);
  assert.equal(
    readdirSync(stateDir).some((name) => name.startsWith("crypto-idb.lock.released.")),
    true,
  );

  releaseBlockedCandidate();
  const releaseB = await acquiringB;
  const installed = JSON.parse(await readFile(join(canonical, "owner.json"), "utf8"));
  assert.equal(installed.pid, process.pid);
  assert.equal(
    readdirSync(stateDir).some((name) => name.startsWith("crypto-idb.lock.released.")),
    false,
    "B drains A's pending destructive release before publishing",
  );
  await releaseB();
  assert.equal(existsSync(canonical), false);

  const malformedState = join(stateDir, "malformed-state");
  await mkdir(join(malformedState, "crypto-idb.lock"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(malformedState, "crypto-idb.lock", "owner.json"),
    "{}\n",
    { mode: 0o600 },
  );
  let injectedCandidateCleanupFailure = false;
  fs.promises.rm = async (path, options) => {
    if (
      !injectedCandidateCleanupFailure
      && basename(String(path)).startsWith(".crypto-idb.lock.")
      && basename(String(path)).endsWith(".candidate")
    ) {
      injectedCandidateCleanupFailure = true;
      const error = new Error("injected candidate cleanup failure");
      error.code = "EIO";
      throw error;
    }
    return await originalRm(path, options);
  };
  syncBuiltinESMExports();
  await assert.rejects(
    () => acquireCryptoStateLock(malformedState),
    (error) => {
      assert.match(String(error), /candidate cleanup failed/);
      const nestedMessages = error.errors.map((nested) => String(nested)).join("\n");
      assert.match(nestedMessages, /invalid ownership metadata/);
      assert.match(nestedMessages, /injected candidate cleanup failure/);
      assert.equal(requiresCryptoProcessQuarantine(error), true);
      return true;
    },
  );
} finally {
  releaseBlockedCandidate?.();
  fs.promises.open = originalOpen;
  fs.promises.rm = originalRm;
  syncBuiltinESMExports();
  await rm(stateDir, { recursive: true, force: true });
}
