// Recovery bootstrap is a reduced adaptation of OpenClaw's Matrix recovery
// control plane (MIT, OpenClaw Foundation, 2026). See ../../THIRD_PARTY_NOTICES.md.

import { assertRecoveryKeyExportMatches } from "./recovery-key-store.mjs";

const CROSS_SIGNING_SECRETS = [
  "m.cross_signing.master",
  "m.cross_signing.self_signing",
  "m.cross_signing.user_signing",
];
const BACKUP_SECRET = "m.megolm_backup.v1";
const SECRET_STORAGE_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";
const SETUP_STATUS_TIMEOUT_MS = 10_000;
const SETUP_STATUS_POLL_MS = 100;

function requireCrypto(client) {
  const crypto = client?.getCrypto?.();
  if (!crypto) throw new Error("Matrix Rust crypto is not initialized");
  return crypto;
}

function requireIdentity(identity) {
  if (
    !identity
    || typeof identity.userId !== "string"
    || !identity.userId
    || typeof identity.deviceId !== "string"
    || !identity.deviceId
  ) {
    throw new Error("Matrix recovery control requires the authenticated user and device identity");
  }
  return identity;
}

function matrixErrorSession(error) {
  const session = error?.data?.session ?? (error?.httpStatus === 401 ? error?.session : undefined);
  return typeof session === "string" && session ? session : undefined;
}

function createUiAuthCallback({ userId, password }) {
  return async (makeRequest) => {
    let firstError;
    try {
      return await makeRequest(null);
    } catch (error) {
      firstError = error;
    }
    let secondError;
    try {
      return await makeRequest({
        type: "m.login.dummy",
        ...(matrixErrorSession(firstError) ? { session: matrixErrorSession(firstError) } : {}),
      });
    } catch (error) {
      secondError = error;
    }
    if (typeof password !== "string" || !password) {
      throw new Error(
        "Matrix cross-signing upload requires account authentication; provide the account password securely",
        { cause: secondError },
      );
    }
    const session = matrixErrorSession(secondError) ?? matrixErrorSession(firstError);
    return await makeRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password,
      ...(session ? { session } : {}),
    });
  };
}

async function defaultSecretStorageKey(client) {
  const keyId = await client.secretStorage?.getDefaultKeyId?.();
  if (!keyId) return null;
  const tuple = await client.secretStorage.getKey(keyId);
  if (!tuple || tuple[0] !== keyId || !tuple[1]) {
    throw new Error("Matrix secret storage default key metadata is unavailable");
  }
  const keyInfo = tuple[1];
  if (
    keyInfo.algorithm !== SECRET_STORAGE_ALGORITHM
    || typeof keyInfo.mac !== "string"
    || !keyInfo.mac
    || typeof keyInfo.iv !== "string"
    || !keyInfo.iv
  ) {
    throw new Error("Matrix secret storage default key lacks authenticated validation metadata");
  }
  return { keyId, keyInfo: tuple[1] };
}

async function validateStoredRecoveryKey(client, recoveryKeyStore, defaultKey) {
  if (!recoveryKeyStore.hasRecoveryKey()) {
    throw new Error(
      "Matrix secret storage already exists but its recovery key is not available locally; provide the existing recovery-key export",
    );
  }
  const privateKey = recoveryKeyStore.getPrivateKey();
  const valid = await client.secretStorage.checkKey(privateKey, defaultKey.keyInfo);
  if (!valid) {
    throw new Error("The supplied Matrix recovery key does not unlock the account's secret storage");
  }
  recoveryKeyStore.commitKeyId(defaultKey.keyId, defaultKey.keyInfo, privateKey);
}

async function secretIsStored(client, name) {
  return Boolean(await client.secretStorage?.isStored?.(name));
}

async function assertPublishedCrossSigningIsRecoverable(client, crypto, { published, ready }) {
  if (!published || ready) return;
  for (const name of CROSS_SIGNING_SECRETS) {
    const secret = await client.secretStorage.get(name);
    if (typeof secret !== "string" || !secret) {
      throw new Error(
        "Matrix cross-signing is published but its private keys are not recoverable from secret storage; refusing to replace the identity",
      );
    }
  }
}

async function publishedCrossSigningMasterKey(client, userId) {
  if (typeof client.downloadKeysForUsers !== "function") {
    throw new Error("Pinned Matrix SDK cannot query the published cross-signing identity");
  }
  const response = await client.downloadKeysForUsers([userId]);
  const master = response?.master_keys?.[userId];
  if (!master) return null;
  const entries = Object.entries(master.keys ?? {});
  if (
    master.user_id !== userId
    || !Array.isArray(master.usage)
    || !master.usage.includes("master")
    || entries.length !== 1
    || !entries[0][0].startsWith("ed25519:")
    || entries[0][0].slice("ed25519:".length) !== entries[0][1]
  ) {
    throw new Error("Matrix published cross-signing master key is malformed");
  }
  return entries[0][1];
}

async function assertCrossSigningIdentity(crypto, publishedMasterKey) {
  if (typeof crypto.getCrossSigningKeyId !== "function") {
    throw new Error("Pinned Matrix crypto backend cannot verify cross-signing identity continuity");
  }
  const recoveredMasterKey = await crypto.getCrossSigningKeyId();
  if (typeof recoveredMasterKey !== "string" || !recoveredMasterKey) {
    throw new Error("Matrix cross-signing master key is unavailable after recovery");
  }
  if (publishedMasterKey && recoveredMasterKey !== publishedMasterKey) {
    throw new Error("Matrix recovered cross-signing identity does not match the published master key");
  }
}

async function waitForSetupRecoveryStatus({
  client,
  recoveryKeyStore,
  identity,
  timeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    status = await getCryptoRecoveryStatus({ client, recoveryKeyStore, identity });
    if (
      status.crossSigningReady
      && status.secretStorageReady
      && status.backupUsable
      && status.deviceSignedByOwner !== false
    ) {
      return status;
    }
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
}

async function decodeBackupSecret(client) {
  const stored = await client.secretStorage.get(BACKUP_SECRET);
  if (typeof stored !== "string" || !stored) {
    throw new Error("Matrix secret storage does not contain the room-key backup decryption key");
  }
  const normalized = stored.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("Matrix room-key backup secret is malformed");
  }
  const privateKey = new Uint8Array(Buffer.from(normalized, "base64"));
  if (privateKey.length !== 32) {
    throw new Error("Matrix room-key backup secret has an invalid length");
  }
  return privateKey;
}

async function cacheBackupKeyFromSecretStorage(client, crypto, backupInfo) {
  if (!backupInfo?.version) throw new Error("Matrix room-key backup has no usable version");
  const privateKey = await decodeBackupSecret(client);
  await validateBackupPrivateKey(crypto, backupInfo, privateKey);
  await crypto.storeSessionBackupPrivateKey(privateKey, backupInfo.version);
}

async function validateBackupPrivateKey(crypto, backupInfo, privateKey) {
  if (typeof crypto.getBackupDecryptor !== "function") {
    throw new Error("Pinned Matrix crypto backend cannot validate a room-key backup key");
  }
  const decryptor = await crypto.getBackupDecryptor(backupInfo, privateKey);
  try {
    return true;
  } finally {
    decryptor.free?.();
  }
}

async function ownDeviceStatus(crypto, identity) {
  if (typeof crypto.getDeviceVerificationStatus !== "function") return null;
  return await crypto.getDeviceVerificationStatus(identity.userId, identity.deviceId);
}

export async function getCryptoRecoveryStatus({ client, recoveryKeyStore, identity }) {
  const crypto = requireCrypto(client);
  const currentIdentity = requireIdentity(identity);
  const backupInfo = typeof client.getKeyBackupVersion === "function"
    ? await client.getKeyBackupVersion()
    : null;
  let trustInfo = null;
  if (backupInfo && typeof crypto.isKeyBackupTrusted === "function") {
    trustInfo = await crypto.isKeyBackupTrusted(backupInfo);
  }
  const [
    activeVersion,
    backupPrivateKey,
    secretStorageReady,
    crossSigningReady,
    crossSigningStatus,
    deviceStatus,
  ] = await Promise.all([
    crypto.getActiveSessionBackupVersion?.() ?? null,
    crypto.getSessionBackupPrivateKey?.() ?? null,
    crypto.isSecretStorageReady?.() ?? false,
    crypto.isCrossSigningReady?.() ?? false,
    crypto.getCrossSigningStatus?.() ?? null,
    ownDeviceStatus(crypto, currentIdentity),
  ]);
  const recoveryKey = recoveryKeyStore.getSummary();
  const serverVersion = backupInfo?.version ?? null;
  const trusted = backupInfo ? trustInfo?.trusted === true : null;
  const matchesDecryptionKey = backupInfo ? trustInfo?.matchesDecryptionKey === true : null;
  const backupUsable = Boolean(
    serverVersion
    && activeVersion === serverVersion
    && trusted
    && matchesDecryptionKey,
  );
  return {
    serverVersion,
    serverAlgorithm: backupInfo?.algorithm ?? null,
    serverKeyCount: Number.isSafeInteger(backupInfo?.count) ? backupInfo.count : null,
    activeVersion: activeVersion ?? null,
    trusted,
    matchesDecryptionKey,
    decryptionKeyCached: backupPrivateKey instanceof Uint8Array,
    backupUsable,
    secretStorageReady: secretStorageReady === true,
    crossSigningReady: crossSigningReady === true,
    crossSigningPrivateKeysInSecretStorage: crossSigningStatus?.privateKeysInSecretStorage === true,
    deviceSignedByOwner: deviceStatus?.signedByOwner ?? null,
    deviceCrossSigningVerified: deviceStatus?.crossSigningVerified ?? null,
    deviceLocallyVerified: deviceStatus?.localVerified ?? null,
    recoveryKeyStored: recoveryKey.stored,
    recoveryKeyPhase: recoveryKey.phase,
    recoveryKeyId: recoveryKey.keyId,
  };
}

export async function enableExistingCryptoRecovery({
  client,
  recoveryKeyStore,
  identity,
  persist = async () => {},
}) {
  if (
    typeof client?.getKeyBackupVersion !== "function"
    || typeof client?.getCrypto !== "function"
  ) {
    return { supported: false, serverVersion: null, backupUsable: false };
  }
  const crypto = requireCrypto(client);
  const backupInfo = await client.getKeyBackupVersion();
  if (!backupInfo) {
    return {
      supported: true,
      ...(await getCryptoRecoveryStatus({ client, recoveryKeyStore, identity })),
    };
  }
  await crypto.checkKeyBackupAndEnable?.();
  let status = await getCryptoRecoveryStatus({ client, recoveryKeyStore, identity });
  if (!status.backupUsable && recoveryKeyStore.hasRecoveryKey()) {
    const defaultKey = await defaultSecretStorageKey(client);
    if (defaultKey) {
      await validateStoredRecoveryKey(client, recoveryKeyStore, defaultKey);
      if (await secretIsStored(client, BACKUP_SECRET)) {
        await cacheBackupKeyFromSecretStorage(client, crypto, backupInfo);
        await crypto.checkKeyBackupAndEnable?.();
        await persist();
        status = await getCryptoRecoveryStatus({ client, recoveryKeyStore, identity });
      }
    }
  }
  return { supported: true, ...status };
}

export async function setupCryptoRecovery({
  client,
  recoveryKeyStore,
  identity,
  recoveryKeyExport = null,
  exportRecoveryKey,
  password,
  decodeRecoveryKey,
  persist = async () => {},
  setupStatusTimeoutMs = SETUP_STATUS_TIMEOUT_MS,
  setupStatusPollMs = SETUP_STATUS_POLL_MS,
}) {
  const crypto = requireCrypto(client);
  const currentIdentity = requireIdentity(identity);
  if (typeof exportRecoveryKey !== "function") {
    throw new Error("Matrix recovery setup requires a secure recovery-key export destination");
  }
  let stagedCandidate = false;
  if (recoveryKeyExport) {
    assertRecoveryKeyExportMatches(recoveryKeyExport, currentIdentity);
    stagedCandidate = recoveryKeyStore.stageEncodedKey(
      recoveryKeyExport.encodedPrivateKey,
      decodeRecoveryKey,
    ).candidate;
  }

  try {
    const backupInfo = await client.getKeyBackupVersion();
    const cachedBackupKey = await crypto.getSessionBackupPrivateKey?.();
    const existingDefaultKey = await defaultSecretStorageKey(client);
    const publishedMasterKey = await publishedCrossSigningMasterKey(
      client,
      currentIdentity.userId,
    );
    await crypto.userHasCrossSigningKeys?.(currentIdentity.userId, true);
    const publishedCrossSigning = publishedMasterKey !== null;
    const crossSigningReady = await crypto.isCrossSigningReady?.() ?? false;

    if (existingDefaultKey) {
      await validateStoredRecoveryKey(client, recoveryKeyStore, existingDefaultKey);
    } else {
      if (backupInfo && !(cachedBackupKey instanceof Uint8Array)) {
        throw new Error(
          "A Matrix room-key backup already exists but its decryption key is unavailable; refusing to create unrelated recovery material",
        );
      }
      if (publishedCrossSigning && !crossSigningReady) {
        throw new Error(
          "Matrix cross-signing already exists but its private keys are unavailable; refusing to replace the identity",
        );
      }
      if (!recoveryKeyStore.hasRecoveryKey()) {
        const generated = await crypto.createRecoveryKeyFromPassphrase();
        recoveryKeyStore.stageGeneratedKey(generated);
      }
    }

    const backupSecretStored = backupInfo
      ? await secretIsStored(client, BACKUP_SECRET)
      : false;
    if (
      backupInfo
      && !backupSecretStored
      && !(cachedBackupKey instanceof Uint8Array)
    ) {
      throw new Error(
        "A Matrix room-key backup already exists but its decryption key is unavailable; refusing to mutate recovery state",
      );
    }

    await exportRecoveryKey({
      identity: currentIdentity,
      encodedPrivateKey: recoveryKeyStore.getEncodedPrivateKey(),
    });

    if (!existingDefaultKey) {
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => recoveryKeyStore.getGeneratedKey(),
      });
      await persist();
    }

    await assertPublishedCrossSigningIsRecoverable(client, crypto, {
      published: publishedCrossSigning,
      ready: crossSigningReady,
    });
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: createUiAuthCallback({
        userId: currentIdentity.userId,
        password,
      }),
    });
    await assertCrossSigningIdentity(crypto, publishedMasterKey);
    await persist();
    await crypto.bootstrapSecretStorage({});
    await persist();

    if (backupInfo) {
      if (!backupSecretStored && cachedBackupKey instanceof Uint8Array) {
        await validateBackupPrivateKey(crypto, backupInfo, cachedBackupKey);
        await client.secretStorage.store(BACKUP_SECRET, Buffer.from(cachedBackupKey).toString("base64"));
      } else if (backupSecretStored) {
        await cacheBackupKeyFromSecretStorage(client, crypto, backupInfo);
      }
      await crypto.checkKeyBackupAndEnable?.();
    } else {
      const backupBeforeCreate = await client.getKeyBackupVersion();
      if (backupBeforeCreate) {
        throw new Error(
          "A Matrix room-key backup appeared during recovery setup; refusing to replace it",
        );
      }
      await crypto.bootstrapSecretStorage({ setupNewKeyBackup: true });
      await crypto.checkKeyBackupAndEnable?.();
    }
    await persist();

    const status = await waitForSetupRecoveryStatus({
      client,
      recoveryKeyStore,
      identity: currentIdentity,
      timeoutMs: setupStatusTimeoutMs,
      pollMs: setupStatusPollMs,
    });
    if (!status.crossSigningReady) {
      throw new Error("Matrix cross-signing is not ready after recovery setup");
    }
    if (!status.secretStorageReady) {
      throw new Error("Matrix secret storage is not ready after recovery setup");
    }
    if (!status.backupUsable) {
      throw new Error("Matrix room-key backup is not trusted and usable after recovery setup");
    }
    if (status.deviceSignedByOwner === false) {
      throw new Error("Matrix device is not signed by its owner after recovery setup");
    }
    return status;
  } catch (error) {
    if (stagedCandidate) recoveryKeyStore.discardStagedKey();
    throw error;
  }
}

export async function restoreCryptoRecovery({
  client,
  recoveryKeyStore,
  identity,
  recoveryKeyExport = null,
  decodeRecoveryKey,
  persist = async () => {},
  progressCallback,
}) {
  const crypto = requireCrypto(client);
  const currentIdentity = requireIdentity(identity);
  let stagedCandidate = false;
  if (recoveryKeyExport) {
    assertRecoveryKeyExportMatches(recoveryKeyExport, currentIdentity);
    stagedCandidate = recoveryKeyStore.stageEncodedKey(
      recoveryKeyExport.encodedPrivateKey,
      decodeRecoveryKey,
    ).candidate;
  }
  try {
    const backupInfo = await client.getKeyBackupVersion();
    if (!backupInfo?.version) throw new Error("No Matrix room-key backup exists on the server");
    const defaultKey = await defaultSecretStorageKey(client);
    if (!defaultKey) throw new Error("Matrix secret storage is not configured for this account");
    await validateStoredRecoveryKey(client, recoveryKeyStore, defaultKey);

    const publishedMasterKey = await publishedCrossSigningMasterKey(
      client,
      currentIdentity.userId,
    );
    await crypto.userHasCrossSigningKeys?.(currentIdentity.userId, true);
    if (!publishedMasterKey) {
      throw new Error("Matrix cross-signing is not published; run recovery setup before restore");
    }
    await assertPublishedCrossSigningIsRecoverable(client, crypto, {
      published: true,
      ready: await crypto.isCrossSigningReady?.() ?? false,
    });
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async () => {
        throw new Error("Matrix restore refuses to create or replace cross-signing identity");
      },
    });
    await assertCrossSigningIdentity(crypto, publishedMasterKey);
    await persist();
    await cacheBackupKeyFromSecretStorage(client, crypto, backupInfo);
    await crypto.checkKeyBackupAndEnable?.();

    if (typeof client.restoreKeyBackupWithCache !== "function") {
      throw new Error("Pinned Matrix SDK cannot restore the full room-key backup");
    }
    const restored = await client.restoreKeyBackupWithCache(
      undefined,
      undefined,
      backupInfo,
      progressCallback ? { progressCallback } : undefined,
    );
    await persist();
    const imported = restored?.imported;
    const total = restored?.total;
    if (
      !Number.isSafeInteger(imported)
      || imported < 0
      || !Number.isSafeInteger(total)
      || total < 0
    ) {
      throw new Error("Matrix room-key backup restore returned invalid import counts");
    }
    if (imported !== total) {
      throw new Error(`Matrix room-key backup restore was incomplete (${imported}/${total} imported)`);
    }
    const status = await getCryptoRecoveryStatus({ client, recoveryKeyStore, identity: currentIdentity });
    if (!status.backupUsable) {
      throw new Error("Matrix room-key backup is not usable after restore");
    }
    return {
      imported,
      total,
      status,
    };
  } catch (error) {
    if (stagedCandidate) recoveryKeyStore.discardStagedKey();
    throw error;
  }
}
