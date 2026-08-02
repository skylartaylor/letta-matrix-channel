import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryKeyStore } from "./recovery-key-store.mjs";
import {
  enableExistingCryptoRecovery,
  getCryptoRecoveryStatus,
  restoreCryptoRecovery,
  setupCryptoRecovery,
} from "./recovery.mjs";

const root = mkdtempSync(join(tmpdir(), "letta-matrix-recovery-control-"));
const identity = {
  homeserverUrl: "https://example.org/",
  userId: "@bot:example.org",
  deviceId: "DEVICE",
  accountId: "main",
};
const recoveryPrivateKey = new Uint8Array(32).fill(5);
const backupPrivateKey = new Uint8Array(32).fill(9);
const encodedRecoveryKey = "EsT6 L2xR Fict itio usRe cove ryKe y222 2222 2222";

function bytesEqual(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

function makeServer() {
  return {
    defaultKey: null,
    secrets: new Map(),
    crossSigningPublished: false,
    crossSigningMasterKey: "published-master-key",
    backupInfo: null,
  };
}

function makeFixture({
  label,
  currentIdentity = identity,
  server = makeServer(),
  restoreResult = { imported: 3, total: 3 },
  secretStorageReadyDelayChecks = 0,
  recoveredMasterKey = null,
  backupAppearsBeforeCreate = null,
}) {
  const stateDir = join(root, label);
  mkdirSync(stateDir, { mode: 0o700 });
  const recoveryKeyStore = createRecoveryKeyStore({ stateDir });
  recoveryKeyStore.setIdentity(currentIdentity);
  let crossSigningReady = false;
  let activeVersion = null;
  let cachedBackupKey = null;
  let deviceSignedByOwner = false;
  let backupCreates = 0;
  let crossSigningBootstraps = 0;
  let secretStorageBootstraps = 0;
  let restoreCalls = 0;
  let secretStorageReadyChecks = 0;
  let backupVersionReads = 0;

  const secretStorage = {
    async getDefaultKeyId() {
      return server.defaultKey?.keyId ?? null;
    },
    async getKey(keyId) {
      return server.defaultKey?.keyId === keyId
        ? [keyId, server.defaultKey.keyInfo]
        : null;
    },
    async checkKey(key, keyInfo) {
      return (
        keyInfo === server.defaultKey?.keyInfo
        && bytesEqual(key, server.defaultKey.privateKey)
      );
    },
    async isStored(name) {
      return server.secrets.has(name)
        ? { [server.defaultKey.keyId]: server.defaultKey.keyInfo }
        : null;
    },
    async get(name) {
      return server.secrets.get(name);
    },
    async store(name, value) {
      server.secrets.set(name, value);
    },
  };

  const crypto = {
    async createRecoveryKeyFromPassphrase() {
      return {
        privateKey: recoveryPrivateKey,
        encodedPrivateKey: encodedRecoveryKey,
        keyInfo: { name: "Letta Matrix recovery key" },
      };
    },
    async bootstrapSecretStorage(options = {}) {
      secretStorageBootstraps += 1;
      if (!server.defaultKey) {
        const generated = await options.createSecretStorageKey?.();
        assert.ok(generated, "new secret storage requires a generated key");
        server.defaultKey = {
          keyId: "SSSS",
          keyInfo: { algorithm: "m.secret_storage.v1.aes-hmac-sha2", mac: "mac", iv: "iv" },
          privateKey: new Uint8Array(generated.privateKey),
        };
        recoveryKeyStore.cryptoCallbacks.cacheSecretStorageKey(
          server.defaultKey.keyId,
          server.defaultKey.keyInfo,
          generated.privateKey,
        );
      }
      if (crossSigningReady) {
        for (const name of [
          "m.cross_signing.master",
          "m.cross_signing.self_signing",
          "m.cross_signing.user_signing",
        ]) {
          server.secrets.set(name, `${name}-private`);
        }
      }
      if (options.setupNewKeyBackup) {
        backupCreates += 1;
        server.backupInfo = {
          version: "1",
          algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
          auth_data: { public_key: "backup-public" },
          count: 3,
        };
        cachedBackupKey = new Uint8Array(backupPrivateKey);
        server.secrets.set("m.megolm_backup.v1", Buffer.from(backupPrivateKey).toString("base64"));
        activeVersion = "1";
      }
    },
    async bootstrapCrossSigning(options) {
      crossSigningBootstraps += 1;
      const recoverable = [
        "m.cross_signing.master",
        "m.cross_signing.self_signing",
        "m.cross_signing.user_signing",
      ].every((name) => server.secrets.has(name));
      if (!server.crossSigningPublished) {
        await options.authUploadDeviceSigningKeys(async () => ({ ok: true }));
        server.crossSigningPublished = true;
      } else if (!recoverable && !crossSigningReady) {
        await options.authUploadDeviceSigningKeys(async () => ({ ok: true }));
      }
      crossSigningReady = true;
      deviceSignedByOwner = true;
    },
    async userHasCrossSigningKeys() {
      return server.crossSigningPublished;
    },
    async isCrossSigningReady() {
      return crossSigningReady;
    },
    async getCrossSigningKeyId() {
      return crossSigningReady
        ? recoveredMasterKey ?? server.crossSigningMasterKey
        : null;
    },
    async getCrossSigningStatus() {
      return {
        privateKeysInSecretStorage: [
          "m.cross_signing.master",
          "m.cross_signing.self_signing",
          "m.cross_signing.user_signing",
        ].every((name) => server.secrets.has(name)),
      };
    },
    async isSecretStorageReady() {
      const ready = Boolean(
        server.defaultKey
        && crossSigningReady
        && server.secrets.has("m.cross_signing.master")
        && (!activeVersion || server.secrets.has("m.megolm_backup.v1")),
      );
      if (!ready) return false;
      secretStorageReadyChecks += 1;
      return secretStorageReadyChecks > secretStorageReadyDelayChecks;
    },
    async getActiveSessionBackupVersion() {
      return activeVersion;
    },
    async getSessionBackupPrivateKey() {
      return cachedBackupKey;
    },
    async isKeyBackupTrusted(info) {
      return {
        trusted: Boolean(server.crossSigningPublished && info === server.backupInfo),
        matchesDecryptionKey: Boolean(
          cachedBackupKey
          && info === server.backupInfo
          && bytesEqual(cachedBackupKey, backupPrivateKey),
        ),
      };
    },
    async checkKeyBackupAndEnable() {
      if (server.backupInfo && server.crossSigningPublished) {
        activeVersion = server.backupInfo.version;
        return {
          backupInfo: server.backupInfo,
          trustInfo: await crypto.isKeyBackupTrusted(server.backupInfo),
        };
      }
      activeVersion = null;
      return null;
    },
    async getBackupDecryptor(info, key) {
      if (info !== server.backupInfo || !bytesEqual(key, backupPrivateKey)) {
        throw new Error("backup key mismatch");
      }
      return { free() {} };
    },
    async storeSessionBackupPrivateKey(key, version) {
      assert.equal(version, server.backupInfo.version);
      cachedBackupKey = new Uint8Array(key);
    },
    async getDeviceVerificationStatus() {
      return {
        signedByOwner: deviceSignedByOwner,
        crossSigningVerified: deviceSignedByOwner,
        localVerified: false,
      };
    },
  };

  const client = {
    secretStorage,
    getCrypto: () => crypto,
    async downloadKeysForUsers(userIds) {
      assert.deepEqual(userIds, [currentIdentity.userId]);
      return server.crossSigningPublished
        ? {
            master_keys: {
              [currentIdentity.userId]: {
                user_id: currentIdentity.userId,
                usage: ["master"],
                keys: {
                  [`ed25519:${server.crossSigningMasterKey}`]: server.crossSigningMasterKey,
                },
              },
            },
          }
        : { master_keys: {} };
    },
    async getKeyBackupVersion() {
      backupVersionReads += 1;
      if (
        backupAppearsBeforeCreate
        && backupVersionReads >= 2
        && !server.backupInfo
      ) {
        server.backupInfo = backupAppearsBeforeCreate;
      }
      return server.backupInfo;
    },
    async restoreKeyBackupWithCache(_room, _session, info, options) {
      restoreCalls += 1;
      assert.equal(info, server.backupInfo);
      options?.progressCallback?.({
        stage: "load_keys",
        total: restoreResult.total,
        successes: restoreResult.imported,
      });
      return restoreResult;
    },
  };

  return {
    client,
    crypto,
    recoveryKeyStore,
    server,
    counts: () => ({
      backupCreates,
      crossSigningBootstraps,
      secretStorageBootstraps,
      restoreCalls,
    }),
  };
}

try {
  const empty = makeFixture({ label: "empty" });
  assert.deepEqual(
    await enableExistingCryptoRecovery({
      client: empty.client,
      recoveryKeyStore: empty.recoveryKeyStore,
      identity,
    }),
    {
      supported: true,
      serverVersion: null,
      serverAlgorithm: null,
      serverKeyCount: null,
      activeVersion: null,
      trusted: null,
      matchesDecryptionKey: null,
      decryptionKeyCached: false,
      backupUsable: false,
      secretStorageReady: false,
      crossSigningReady: false,
      crossSigningPrivateKeysInSecretStorage: false,
      deviceSignedByOwner: false,
      deviceCrossSigningVerified: false,
      deviceLocallyVerified: false,
      recoveryKeyStored: false,
      recoveryKeyPhase: null,
      recoveryKeyId: null,
    },
  );

  const autoEnableServer = makeServer();
  autoEnableServer.defaultKey = {
    keyId: "SSSS",
    keyInfo: {
      algorithm: "m.secret_storage.v1.aes-hmac-sha2",
      mac: "mac",
      iv: "iv",
    },
    privateKey: recoveryPrivateKey,
  };
  autoEnableServer.crossSigningPublished = true;
  autoEnableServer.backupInfo = {
    version: "existing",
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    auth_data: { public_key: "backup-public" },
    count: 3,
  };
  autoEnableServer.secrets.set(
    "m.megolm_backup.v1",
    Buffer.from(backupPrivateKey).toString("base64"),
  );
  const autoEnable = makeFixture({ label: "auto-enable", server: autoEnableServer });
  autoEnable.recoveryKeyStore.stageGeneratedKey({
    privateKey: recoveryPrivateKey,
    encodedPrivateKey: encodedRecoveryKey,
    keyInfo: autoEnableServer.defaultKey.keyInfo,
  });
  autoEnable.recoveryKeyStore.commitKeyId(
    autoEnableServer.defaultKey.keyId,
    autoEnableServer.defaultKey.keyInfo,
    recoveryPrivateKey,
  );
  let autoEnablePersistence = 0;
  const autoEnabledStatus = await enableExistingCryptoRecovery({
    client: autoEnable.client,
    recoveryKeyStore: autoEnable.recoveryKeyStore,
    identity,
    persist: async () => { autoEnablePersistence += 1; },
  });
  assert.equal(autoEnabledStatus.backupUsable, true);
  assert.equal(autoEnabledStatus.activeVersion, "existing");
  assert.equal(autoEnablePersistence, 1);
  assert.equal(autoEnable.counts().backupCreates, 0);

  const setup = makeFixture({ label: "setup" });
  const exports = [];
  let persistenceCount = 0;
  const setupStatus = await setupCryptoRecovery({
    client: setup.client,
    recoveryKeyStore: setup.recoveryKeyStore,
    identity,
    decodeRecoveryKey: () => recoveryPrivateKey,
    exportRecoveryKey: async (exported) => {
      assert.equal(setup.server.defaultKey, null, "recovery key exports before server mutation");
      exports.push(exported);
    },
    persist: async () => { persistenceCount += 1; },
  });
  assert.equal(setupStatus.backupUsable, true);
  assert.equal(setupStatus.secretStorageReady, true);
  assert.equal(setupStatus.crossSigningReady, true);
  assert.equal(setupStatus.deviceSignedByOwner, true);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].encodedPrivateKey, encodedRecoveryKey);
  assert.ok(persistenceCount >= 4);
  assert.deepEqual(setup.counts(), {
    backupCreates: 1,
    crossSigningBootstraps: 1,
    secretStorageBootstraps: 3,
    restoreCalls: 0,
  });

  const delayed = makeFixture({
    label: "delayed-readiness",
    secretStorageReadyDelayChecks: 2,
  });
  const delayedStatus = await setupCryptoRecovery({
    client: delayed.client,
    recoveryKeyStore: delayed.recoveryKeyStore,
    identity,
    decodeRecoveryKey: () => recoveryPrivateKey,
    exportRecoveryKey: async () => {},
  });
  assert.equal(delayedStatus.secretStorageReady, true);

  const neverReady = makeFixture({
    label: "never-ready",
    secretStorageReadyDelayChecks: Number.POSITIVE_INFINITY,
  });
  await assert.rejects(
    () => setupCryptoRecovery({
      client: neverReady.client,
      recoveryKeyStore: neverReady.recoveryKeyStore,
      identity,
      decodeRecoveryKey: () => recoveryPrivateKey,
      exportRecoveryKey: async () => {},
      setupStatusTimeoutMs: 0,
      setupStatusPollMs: 0,
    }),
    /secret storage is not ready after recovery setup/,
  );

  const concurrentBackup = makeFixture({
    label: "concurrent-backup",
    backupAppearsBeforeCreate: {
      version: "concurrent",
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      auth_data: { public_key: "concurrent-public" },
      count: 2,
    },
  });
  await assert.rejects(
    () => setupCryptoRecovery({
      client: concurrentBackup.client,
      recoveryKeyStore: concurrentBackup.recoveryKeyStore,
      identity,
      decodeRecoveryKey: () => recoveryPrivateKey,
      exportRecoveryKey: async () => {},
    }),
    /backup appeared during recovery setup; refusing to replace it/,
  );
  assert.equal(concurrentBackup.counts().backupCreates, 0);

  setup.server.secrets.delete("m.megolm_backup.v1");
  const existingStatus = await setupCryptoRecovery({
    client: setup.client,
    recoveryKeyStore: setup.recoveryKeyStore,
    identity,
    decodeRecoveryKey: () => recoveryPrivateKey,
    exportRecoveryKey: async () => {},
  });
  assert.equal(existingStatus.backupUsable, true);
  assert.equal(setup.server.secrets.has("m.megolm_backup.v1"), true);
  assert.equal(setup.counts().backupCreates, 1, "setup never replaces an existing backup");

  const strandedServer = makeServer();
  strandedServer.backupInfo = {
    version: "7",
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    auth_data: { public_key: "unknown" },
  };
  const stranded = makeFixture({ label: "stranded", server: strandedServer });
  await assert.rejects(
    () => setupCryptoRecovery({
      client: stranded.client,
      recoveryKeyStore: stranded.recoveryKeyStore,
      identity,
      exportRecoveryKey: async () => {},
    }),
    /backup already exists but its decryption key is unavailable/,
  );
  assert.deepEqual(stranded.counts(), {
    backupCreates: 0,
    crossSigningBootstraps: 0,
    secretStorageBootstraps: 0,
    restoreCalls: 0,
  });

  const unverifiableServer = makeServer();
  unverifiableServer.defaultKey = {
    keyId: "SSSS",
    keyInfo: { algorithm: "m.secret_storage.v1.aes-hmac-sha2", iv: "iv" },
    privateKey: recoveryPrivateKey,
  };
  unverifiableServer.crossSigningPublished = true;
  unverifiableServer.backupInfo = setup.server.backupInfo;
  const unverifiable = makeFixture({ label: "unverifiable", server: unverifiableServer });
  await assert.rejects(
    () => restoreCryptoRecovery({
      client: unverifiable.client,
      recoveryKeyStore: unverifiable.recoveryKeyStore,
      identity,
      recoveryKeyExport: { identity, encodedPrivateKey: encodedRecoveryKey },
      decodeRecoveryKey: () => new Uint8Array(32).fill(4),
    }),
    /lacks authenticated validation metadata/,
  );
  assert.deepEqual(
    unverifiable.recoveryKeyStore.getSummary(),
    { stored: false, phase: null, keyId: null },
  );

  const incompleteIdentity = { ...identity, deviceId: "INCOMPLETE" };
  const incomplete = makeFixture({
    label: "incomplete",
    currentIdentity: incompleteIdentity,
    server: setup.server,
    restoreResult: { imported: 0, total: 5 },
  });
  await assert.rejects(
    () => restoreCryptoRecovery({
      client: incomplete.client,
      recoveryKeyStore: incomplete.recoveryKeyStore,
      identity: incompleteIdentity,
      recoveryKeyExport: { identity, encodedPrivateKey: encodedRecoveryKey },
      decodeRecoveryKey: () => recoveryPrivateKey,
    }),
    /restore was incomplete \(0\/5 imported\)/,
  );

  const mismatchIdentity = { ...identity, deviceId: "MISMATCH" };
  const mismatch = makeFixture({
    label: "cross-signing-mismatch",
    currentIdentity: mismatchIdentity,
    server: setup.server,
    recoveredMasterKey: "different-master-key",
  });
  await assert.rejects(
    () => restoreCryptoRecovery({
      client: mismatch.client,
      recoveryKeyStore: mismatch.recoveryKeyStore,
      identity: mismatchIdentity,
      recoveryKeyExport: { identity, encodedPrivateKey: encodedRecoveryKey },
      decodeRecoveryKey: () => recoveryPrivateKey,
    }),
    /does not match the published master key/,
  );

  const replacementIdentity = { ...identity, deviceId: "REPLACEMENT" };
  const replacement = makeFixture({
    label: "replacement",
    currentIdentity: replacementIdentity,
    server: setup.server,
  });
  await assert.rejects(
    () => restoreCryptoRecovery({
      client: replacement.client,
      recoveryKeyStore: replacement.recoveryKeyStore,
      identity: replacementIdentity,
      recoveryKeyExport: {
        identity,
        encodedPrivateKey: encodedRecoveryKey,
      },
      decodeRecoveryKey: () => new Uint8Array(32).fill(4),
    }),
    /does not unlock the account's secret storage/,
  );
  assert.deepEqual(
    replacement.recoveryKeyStore.getSummary(),
    { stored: false, phase: null, keyId: null },
    "a rejected recovery file must not poison local state",
  );
  let restorePersistence = 0;
  const restored = await restoreCryptoRecovery({
    client: replacement.client,
    recoveryKeyStore: replacement.recoveryKeyStore,
    identity: replacementIdentity,
    recoveryKeyExport: {
      identity,
      encodedPrivateKey: encodedRecoveryKey,
    },
    decodeRecoveryKey: () => recoveryPrivateKey,
    persist: async () => { restorePersistence += 1; },
  });
  assert.deepEqual({ imported: restored.imported, total: restored.total }, { imported: 3, total: 3 });
  assert.equal(restored.status.backupUsable, true);
  assert.equal(restored.status.deviceSignedByOwner, true);
  assert.equal(replacement.counts().backupCreates, 0);
  assert.equal(replacement.counts().restoreCalls, 1);
  assert.ok(restorePersistence >= 2);

  const finalStatus = await getCryptoRecoveryStatus({
    client: replacement.client,
    recoveryKeyStore: replacement.recoveryKeyStore,
    identity: replacementIdentity,
  });
  assert.equal(finalStatus.serverVersion, "1");
  assert.equal(finalStatus.recoveryKeyStored, true);

  console.log("Matrix recovery control tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
