import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRecoveryKeyExportMatches,
  assertRecoveryKeyExportOutsideState,
  createRecoveryKeyStore,
  ensureRecoveryKeyExport,
  readRecoveryKeyExport,
  recoveryKeyPath,
  writeRecoveryKeyExport,
} from "./recovery-key-store.mjs";

const root = mkdtempSync(join(tmpdir(), "letta-matrix-recovery-key-"));
const identity = {
  homeserverUrl: "https://example.org/",
  userId: "@bot:example.org",
  deviceId: "DEVICE",
  accountId: "main",
};
const privateKey = new Uint8Array(32).fill(7);
const otherPrivateKey = new Uint8Array(32).fill(8);
const encodedPrivateKey = "EsT6 L2xR Fict itio usRe cove ryKe y111 1111 1111";

try {
  const candidateState = join(root, "candidate-state");
  mkdirSync(candidateState, { mode: 0o700 });
  const candidateStore = createRecoveryKeyStore({ stateDir: candidateState });
  candidateStore.setIdentity(identity);
  const candidate = candidateStore.stageEncodedKey(encodedPrivateKey, () => privateKey);
  assert.equal(candidate.candidate, true);
  assert.deepEqual(candidateStore.getSummary(), { stored: false, phase: "candidate", keyId: null });
  assert.equal(existsSync(recoveryKeyPath(candidateState)), false);
  assert.deepEqual(
    await candidateStore.cryptoCallbacks.getSecretStorageKey({ keys: { SSSS: {} } }),
    ["SSSS", privateKey],
  );
  candidateStore.discardStagedKey();
  assert.deepEqual(candidateStore.getSummary(), { stored: false, phase: null, keyId: null });

  candidateStore.stageEncodedKey(encodedPrivateKey, () => privateKey);
  candidateStore.commitKeyId("SSSS", { algorithm: "test" }, privateKey);
  assert.equal(existsSync(recoveryKeyPath(candidateState)), true);
  assert.deepEqual(candidateStore.getSummary(), { stored: true, phase: "committed", keyId: "SSSS" });

  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const store = createRecoveryKeyStore({ stateDir });
  store.setIdentity(identity);
  assert.deepEqual(store.getSummary(), { stored: false, phase: null, keyId: null });

  const staged = store.stageGeneratedKey({
    privateKey,
    encodedPrivateKey,
    keyInfo: { name: "Letta Matrix recovery key" },
  });
  assert.deepEqual(staged.privateKey, privateKey);
  assert.equal(store.getEncodedPrivateKey(), encodedPrivateKey);
  assert.equal(lstatSync(recoveryKeyPath(stateDir)).mode & 0o777, 0o600);
  assert.deepEqual(store.getSummary(), { stored: true, phase: "staged", keyId: null });
  assert.deepEqual(
    await store.cryptoCallbacks.getSecretStorageKey({ keys: { SSSS: { algorithm: "test" } } }),
    ["SSSS", privateKey],
  );

  store.cryptoCallbacks.cacheSecretStorageKey("SSSS", { algorithm: "test" }, privateKey);
  assert.deepEqual(store.getSummary(), { stored: true, phase: "committed", keyId: "SSSS" });
  assert.equal(
    await store.cryptoCallbacks.getSecretStorageKey({ keys: { OTHER: { algorithm: "test" } } }),
    null,
  );

  const reloaded = createRecoveryKeyStore({ stateDir });
  reloaded.setIdentity(identity);
  assert.deepEqual(reloaded.getPrivateKey(), privateKey);
  assert.throws(
    () => reloaded.stageGeneratedKey({ privateKey: otherPrivateKey, encodedPrivateKey }),
    /Refusing to replace the stored Matrix recovery key/,
  );
  assert.throws(
    () => reloaded.setIdentity({ ...identity, deviceId: "OTHER" }),
    /identity cannot change/,
  );

  const exportDir = join(root, "exports");
  const exportPath = join(exportDir, "main-recovery.json");
  assertRecoveryKeyExportOutsideState(stateDir, exportPath);
  writeRecoveryKeyExport(exportPath, { identity, encodedPrivateKey });
  assert.equal(lstatSync(exportPath).mode & 0o777, 0o600);
  const exported = readRecoveryKeyExport(exportPath);
  assert.equal(exported.encodedPrivateKey, encodedPrivateKey);
  assertRecoveryKeyExportMatches(exported, { ...identity, deviceId: "REPLACEMENT" });
  assert.throws(
    () => assertRecoveryKeyExportMatches(exported, { ...identity, userId: "@other:example.org" }),
    /does not match this homeserver, user, and account/,
  );
  assert.throws(
    () => writeRecoveryKeyExport(exportPath, { identity, encodedPrivateKey }),
    /Refusing to overwrite/,
  );
  assert.equal(
    ensureRecoveryKeyExport(exportPath, { identity, encodedPrivateKey }),
    exportPath,
  );
  assert.throws(
    () => ensureRecoveryKeyExport(exportPath, {
      identity,
      encodedPrivateKey: "Different recovery key",
    }),
    /Refusing to overwrite a different/,
  );
  assert.throws(
    () => assertRecoveryKeyExportOutsideState(stateDir, join(stateDir, "copy.json")),
    /outside the crypto state directory/,
  );

  chmodSync(exportPath, 0o644);
  assert.throws(() => readRecoveryKeyExport(exportPath), /permissions must be 0600/);
  chmodSync(exportPath, 0o600);

  const symlinkState = join(root, "symlink-state");
  mkdirSync(symlinkState, { mode: 0o700 });
  symlinkSync(exportPath, recoveryKeyPath(symlinkState));
  const symlinkStore = createRecoveryKeyStore({ stateDir: symlinkState });
  assert.throws(() => symlinkStore.setIdentity(identity), /must be a regular file/);

  const malformedState = join(root, "malformed-state");
  mkdirSync(malformedState, { mode: 0o700 });
  writeFileSync(recoveryKeyPath(malformedState), "{}\n", { mode: 0o600 });
  const malformedStore = createRecoveryKeyStore({ stateDir: malformedState });
  assert.throws(() => malformedStore.setIdentity(identity), /malformed or unsupported/);

  const syntaxState = join(root, "syntax-state");
  mkdirSync(syntaxState, { mode: 0o700 });
  writeFileSync(
    recoveryKeyPath(syntaxState),
    '{"privateKeyBase64":secret_pri}\n',
    { mode: 0o600 },
  );
  const syntaxStore = createRecoveryKeyStore({ stateDir: syntaxState });
  assert.throws(
    () => syntaxStore.setIdentity(identity),
    (error) => (
      error.message.includes("malformed or unsupported")
      && error.cause?.message === "JSON syntax error"
      && !String(error.cause).includes("secret_pri")
    ),
  );

  console.log("Matrix recovery key store tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
