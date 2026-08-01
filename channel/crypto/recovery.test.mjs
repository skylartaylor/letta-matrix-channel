import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { indexedDB } from "fake-indexeddb";
import { installTestCryptoDatabase } from "./crypto-db-test-fixture.mjs";
import {
  clearCryptoStateActive,
  clearInMemoryCryptoState,
  inspectCryptoStateRecovery,
  markCryptoStateActive,
  persistCryptoState,
  prepareCryptoStateIdentity,
  recoverCryptoStateAfterCrash,
  restoreCryptoState,
  validateCurrentCryptoSnapshot,
} from "./idb-state.mjs";
import { startCryptoRuntime } from "./runtime.mjs";

globalThis.indexedDB = indexedDB;
const execFileAsync = promisify(execFile);

const identity = {
  homeserverUrl: "https://example.org/",
  userId: "@recovery:example.org",
  deviceId: "RECOVERY",
  accountId: "recovery",
};
const roots = [];

async function makeState(label) {
  const stateDir = await mkdtemp(join(tmpdir(), `letta-matrix-recovery-${label}-`));
  roots.push(stateDir);
  await prepareCryptoStateIdentity(stateDir, identity, { allowBootstrap: true });
  await installTestCryptoDatabase();
  await persistCryptoState(stateDir);
  await persistCryptoState(stateDir);
  return stateDir;
}

function deadMarker(token) {
  return `${JSON.stringify({
    version: 1,
    token,
    pid: 2_147_483_647,
    startedAt: new Date(0).toISOString(),
  })}\n`;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function request(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

try {
  const liveState = await makeState("live");
  const liveToken = await markCryptoStateActive(liveState);
  const liveInspection = await inspectCryptoStateRecovery(liveState);
  assert.equal(liveInspection.marker.token, liveToken);
  assert.equal(liveInspection.marker.processLive, true);
  await assert.rejects(
    () => recoverCryptoStateAfterCrash({
      stateDir: liveState,
      markerToken: liveToken,
      expectedIdentity: identity,
    }),
    /marker process .* is still running/,
  );
  assert.equal(existsSync(join(liveState, "crypto-runtime.active")), true);
  await clearCryptoStateActive(liveState, liveToken);

  const recoveryState = await makeState("success");
  const markerPath = join(recoveryState, "crypto-runtime.active");
  const markerToken = "dead-runtime-token";
  await writeFile(markerPath, deadMarker(markerToken), { mode: 0o600 });
  const currentPath = join(recoveryState, "crypto-idb.snapshot");
  const previousPath = join(recoveryState, "crypto-idb.snapshot.previous");
  const identityPath = join(recoveryState, "crypto-identity.json");
  const orphanTemporary = join(
    recoveryState,
    "crypto-idb.snapshot.99999999.orphan.tmp",
  );
  await writeFile(orphanTemporary, "must never be selected", { mode: 0o600 });
  const before = {
    marker: await readFile(markerPath),
    current: await readFile(currentPath),
    previous: await readFile(previousPath),
    identity: await readFile(identityPath),
  };
  const inspection = await inspectCryptoStateRecovery(recoveryState);
  assert.deepEqual(inspection.identity, { version: 1, ...identity });
  assert.equal(inspection.marker.token, markerToken);
  assert.equal(inspection.marker.processLive, false);
  assert.equal(inspection.snapshot.databaseCount, 1);
  assert.equal(inspection.snapshot.sha256, digest(before.current));

  for (const attempt of [
    {
      markerToken: "wrong-token",
      expectedIdentity: identity,
      error: /active marker token does not match/,
    },
    {
      markerToken,
      expectedIdentity: { ...identity, deviceId: "OTHER" },
      error: /confirmed deviceId does not match/,
    },
  ]) {
    await assert.rejects(
      () => recoverCryptoStateAfterCrash({
        stateDir: recoveryState,
        markerToken: attempt.markerToken,
        expectedIdentity: attempt.expectedIdentity,
      }),
      attempt.error,
    );
    assert.deepEqual(await readFile(markerPath), before.marker);
    assert.deepEqual(await readFile(currentPath), before.current);
    assert.deepEqual(await readFile(previousPath), before.previous);
    assert.deepEqual(await readFile(identityPath), before.identity);
  }

  const recovered = await recoverCryptoStateAfterCrash({
    stateDir: recoveryState,
    markerToken,
    expectedIdentity: identity,
  });
  assert.equal(existsSync(markerPath), false);
  assert.equal(existsSync(recovered.recoveredMarkerPath), true);
  assert.equal((await stat(recovered.recoveredMarkerPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(recovered.recoveredMarkerPath), before.marker);
  assert.deepEqual(await readFile(currentPath), before.current);
  assert.deepEqual(await readFile(previousPath), before.previous);
  assert.deepEqual(await readFile(identityPath), before.identity);
  assert.equal(
    (await readFile(orphanTemporary, "utf8")),
    "must never be selected",
  );
  assert.equal(existsSync(join(recoveryState, "crypto-idb.lock")), false);
  await assert.rejects(
    () => recoverCryptoStateAfterCrash({
      stateDir: recoveryState,
      markerToken,
      expectedIdentity: identity,
    }),
    /active runtime marker is missing/,
  );
  await clearInMemoryCryptoState();
  assert.equal((await restoreCryptoState(recoveryState)).generation, "current");

  const corruptState = await makeState("corrupt");
  const corruptMarker = join(corruptState, "crypto-runtime.active");
  await writeFile(corruptMarker, deadMarker("corrupt-token"), { mode: 0o600 });
  await writeFile(join(corruptState, "crypto-idb.snapshot"), "corrupt");
  const corruptBefore = await readFile(corruptMarker);
  await assert.rejects(
    () => recoverCryptoStateAfterCrash({
      stateDir: corruptState,
      markerToken: "corrupt-token",
      expectedIdentity: identity,
    }),
    /current snapshot is invalid/,
  );
  assert.deepEqual(await readFile(corruptMarker), corruptBefore);
  assert.equal(existsSync(join(corruptState, "crypto-idb.snapshot.previous")), true);

  const missingCurrentState = await makeState("missing-current");
  const missingCurrentMarker = join(missingCurrentState, "crypto-runtime.active");
  await writeFile(
    missingCurrentMarker,
    deadMarker("missing-current-token"),
    { mode: 0o600 },
  );
  await rm(join(missingCurrentState, "crypto-idb.snapshot"));
  await assert.rejects(
    () => recoverCryptoStateAfterCrash({
      stateDir: missingCurrentState,
      markerToken: "missing-current-token",
      expectedIdentity: identity,
    }),
    /current snapshot is missing/,
  );
  assert.equal(existsSync(missingCurrentMarker), true);
  assert.equal(
    existsSync(join(missingCurrentState, "crypto-idb.snapshot.previous")),
    true,
  );

  const malformedMarkerState = await makeState("malformed-marker");
  const malformedMarker = join(malformedMarkerState, "crypto-runtime.active");
  await writeFile(malformedMarker, "{}\n", { mode: 0o600 });
  await assert.rejects(
    () => inspectCryptoStateRecovery(malformedMarkerState),
    /active runtime marker is malformed/,
  );
  assert.equal((await readFile(malformedMarker, "utf8")), "{}\n");

  const permissionState = await makeState("permissions");
  const permissionMarker = join(permissionState, "crypto-runtime.active");
  await writeFile(permissionMarker, deadMarker("permission-token"), { mode: 0o600 });
  await chmod(permissionMarker, 0o644);
  await assert.rejects(
    () => inspectCryptoStateRecovery(permissionState),
    /active runtime marker permissions must be 0600/,
  );
  await chmod(permissionMarker, 0o600);
  await chmod(permissionState, 0o755);
  await assert.rejects(
    () => inspectCryptoStateRecovery(permissionState),
    /state directory permissions must be 0700/,
  );
  await chmod(permissionState, 0o700);

  const symlinkState = await makeState("symlink");
  const symlinkMarker = join(symlinkState, "crypto-runtime.active");
  const realMarker = join(symlinkState, "test-marker-target");
  await writeFile(realMarker, deadMarker("symlink-token"), { mode: 0o600 });
  await symlink(realMarker, symlinkMarker);
  await assert.rejects(
    () => inspectCryptoStateRecovery(symlinkState),
    /active runtime marker must be a regular file/,
  );

  const concurrentState = await makeState("concurrent");
  await writeFile(
    join(concurrentState, "crypto-runtime.active"),
    deadMarker("concurrent-token"),
    { mode: 0o600 },
  );
  const contenders = await Promise.allSettled([
    recoverCryptoStateAfterCrash({
      stateDir: concurrentState,
      markerToken: "concurrent-token",
      expectedIdentity: identity,
    }),
    recoverCryptoStateAfterCrash({
      stateDir: concurrentState,
      markerToken: "concurrent-token",
      expectedIdentity: identity,
    }),
  ]);
  assert.equal(
    contenders.filter(({ status }) => status === "fulfilled").length,
    1,
    "exactly one concurrent recovery succeeds",
  );
  assert.equal(
    contenders.filter(({ status }) => status === "rejected").length,
    1,
  );

  const committedWarningState = await makeState("commit-warning");
  await writeFile(
    join(committedWarningState, "crypto-runtime.active"),
    deadMarker("commit-warning-token"),
    { mode: 0o600 },
  );
  const committedWithWarning = await recoverCryptoStateAfterCrash({
    stateDir: committedWarningState,
    markerToken: "commit-warning-token",
    expectedIdentity: identity,
    recoveryOptions: {
      syncDirectoryAfterCommit: async () => {
        throw new Error("simulated post-commit directory sync failure");
      },
    },
  });
  assert.equal(committedWithWarning.directorySynced, false);
  assert.equal(committedWithWarning.lockReleased, true);
  assert.equal(
    existsSync(join(committedWarningState, "crypto-runtime.active")),
    false,
    "a committed recovery never reports failure after moving the active marker",
  );
  assert.equal(existsSync(committedWithWarning.recoveredMarkerPath), true);

  const publicationCrashState = await makeState("publication-crash");
  const snapshotCrashChild = fileURLToPath(
    new URL("./snapshot-crash-child.mjs", import.meta.url),
  );
  for (const crashPoint of [
    "new-snapshot-synced",
    "previous-candidate-synced",
    "previous-installed",
    "current-installed",
    "current-synced",
  ]) {
    const child = spawn(
      process.execPath,
      [snapshotCrashChild, publicationCrashState, crashPoint],
      { stdio: "inherit" },
    );
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");
    assert.deepEqual(
      await validateCurrentCryptoSnapshot(publicationCrashState),
      { databaseCount: 1 },
      `SIGKILL at ${crashPoint} leaves a valid current snapshot`,
    );
  }

  const cliState = await makeState("cli");
  await writeFile(
    join(cliState, "crypto-runtime.active"),
    deadMarker("cli-token"),
    { mode: 0o600 },
  );
  const recoveryCli = fileURLToPath(new URL("./recover-state.mjs", import.meta.url));
  const inspectedByCli = JSON.parse((await execFileAsync(
    process.execPath,
    [recoveryCli, "inspect", "--state-dir", cliState],
  )).stdout);
  assert.equal(inspectedByCli.marker.token, "cli-token");
  assert.equal(inspectedByCli.marker.processLive, false);
  const recoveredByCli = JSON.parse((await execFileAsync(
    process.execPath,
    [
      recoveryCli,
      "recover",
      "--state-dir", cliState,
      "--marker-token", "cli-token",
      "--homeserver-url", identity.homeserverUrl,
      "--account-id", identity.accountId,
      "--user-id", identity.userId,
      "--device-id", identity.deviceId,
    ],
  )).stdout);
  assert.equal(existsSync(recoveredByCli.recoveredMarkerPath), true);
  assert.equal(existsSync(join(cliState, "crypto-runtime.active")), false);

  const crashRoot = await mkdtemp(join(tmpdir(), "letta-matrix-recovery-process-"));
  roots.push(crashRoot);
  const crashState = join(crashRoot, "state");
  const crashChild = fork(
    fileURLToPath(new URL("./runtime-crash-child.mjs", import.meta.url)),
    [crashState, JSON.stringify(identity)],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const crashExited = once(crashChild, "exit");
  await new Promise((resolve, reject) => {
    crashChild.once("message", (message) => {
      if (message?.type === "ready") resolve();
      else reject(new Error("runtime crash child returned an unexpected message"));
    });
    crashChild.once("error", reject);
    crashChild.once("exit", (code, signal) => {
      reject(new Error(`runtime crash child exited early code=${code} signal=${signal}`));
    });
  });
  crashChild.kill("SIGKILL");
  const [crashExitCode, crashSignal] = await crashExited;
  assert.equal(crashExitCode, null);
  assert.equal(crashSignal, "SIGKILL");

  let restartedBeforeRecovery = false;
  await assert.rejects(
    () => startCryptoRuntime({
      accountKey: "hard-crash",
      stateDir: crashState,
      identity,
      client: {
        initRustCrypto: async () => {
          restartedBeforeRecovery = true;
        },
        stopClient: async () => {},
      },
    }),
    /previous encrypted runtime did not shut down cleanly/,
  );
  assert.equal(restartedBeforeRecovery, false);
  const crashInspection = await inspectCryptoStateRecovery(crashState);
  assert.equal(crashInspection.marker.processLive, false);
  await recoverCryptoStateAfterCrash({
    stateDir: crashState,
    markerToken: crashInspection.marker.token,
    expectedIdentity: identity,
  });
  const restoredRuntime = await startCryptoRuntime({
    accountKey: "hard-crash",
    stateDir: crashState,
    identity,
    client: {
      initRustCrypto: async () => {
        const database = await request(
          globalThis.indexedDB.open("matrix-js-sdk::matrix-sdk-crypto", 12),
        );
        try {
          const value = await request(
            database
              .transaction("core", "readonly")
              .objectStore("core")
              .get("crash-probe"),
          );
          assert.equal(value, "hard-crash");
        } finally {
          database.close();
        }
      },
      stopClient: async () => {},
    },
  });
  await restoredRuntime.stop();

  console.log("crypto crash recovery tests passed");
} finally {
  await clearInMemoryCryptoState().catch(() => {});
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
