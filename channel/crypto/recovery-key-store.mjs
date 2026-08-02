// Recovery-key handling follows the guarded storage model in OpenClaw's
// Matrix extension (MIT, OpenClaw Foundation, 2026). See ../../THIRD_PARTY_NOTICES.md.

import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const RECOVERY_KEY_FILE = "recovery-key.json";
const STORE_FORMAT = "letta-matrix-recovery-key-store";
const EXPORT_FORMAT = "letta-matrix-recovery-key";
const FORMAT_VERSION = 1;
const PRIVATE_KEY_BYTES = 32;

function normalizeIdentity(identity) {
  if (
    !identity
    || typeof identity.homeserverUrl !== "string"
    || !identity.homeserverUrl
    || typeof identity.userId !== "string"
    || !identity.userId
    || typeof identity.deviceId !== "string"
    || !identity.deviceId
    || typeof identity.accountId !== "string"
    || !identity.accountId
  ) {
    throw new Error("Matrix recovery key identity requires homeserverUrl, userId, deviceId, and accountId");
  }
  return {
    homeserverUrl: identity.homeserverUrl,
    userId: identity.userId,
    deviceId: identity.deviceId,
    accountId: identity.accountId,
  };
}

function identitiesEqual(left, right) {
  return ["homeserverUrl", "userId", "deviceId", "accountId"].every(
    (field) => left[field] === right[field],
  );
}

function exportIdentityMatches(origin, current) {
  return ["homeserverUrl", "userId", "accountId"].every(
    (field) => origin[field] === current[field],
  );
}

function assertSecureDirectory(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${label} permissions must be 0700`);
  }
}

function assertSecureFile(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 0600`);
  }
}

function decodeStoredPrivateKey(value) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || value.length % 4 !== 0
  ) {
    throw new Error("Matrix recovery key state contains invalid private-key encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== PRIVATE_KEY_BYTES || decoded.toString("base64") !== value) {
    throw new Error("Matrix recovery key state contains an invalid private key");
  }
  return new Uint8Array(decoded);
}

function normalizeEncodedRecoveryKey(value) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 1024
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Matrix recovery key state contains an invalid encoded recovery key");
  }
  return value.trim();
}

function normalizeKeyInfo(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Matrix recovery key state contains invalid key metadata");
  }
  return structuredClone(value);
}

function validateStorePayload(payload) {
  if (
    payload?.format !== STORE_FORMAT
    || payload?.version !== FORMAT_VERSION
    || (payload.phase !== "staged" && payload.phase !== "committed")
    || (payload.keyId !== null && (typeof payload.keyId !== "string" || !payload.keyId))
    || typeof payload.createdAt !== "string"
    || typeof payload.updatedAt !== "string"
  ) {
    throw new Error("Matrix recovery key state is malformed or unsupported");
  }
  const identity = normalizeIdentity(payload.identity);
  const privateKey = decodeStoredPrivateKey(payload.privateKeyBase64);
  const encodedPrivateKey = normalizeEncodedRecoveryKey(payload.encodedPrivateKey);
  const keyInfo = normalizeKeyInfo(payload.keyInfo);
  if (payload.phase === "committed" && !payload.keyId) {
    throw new Error("Matrix recovery key state is committed without a key ID");
  }
  if (payload.phase === "staged" && payload.keyId !== null) {
    throw new Error("Matrix recovery key state is staged with a key ID");
  }
  return {
    ...payload,
    identity,
    privateKey,
    encodedPrivateKey,
    keyInfo,
  };
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function durableReplace(path, contents) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(directory);
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function durablePublishNew(path, contents) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(directory);
    linkSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function makeStorePayload({ identity, generated, existing, keyId = null, keyInfo = null }) {
  const now = new Date().toISOString();
  return {
    format: STORE_FORMAT,
    version: FORMAT_VERSION,
    phase: keyId ? "committed" : "staged",
    identity,
    keyId,
    keyInfo,
    privateKeyBase64: Buffer.from(generated.privateKey).toString("base64"),
    encodedPrivateKey: normalizeEncodedRecoveryKey(generated.encodedPrivateKey),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function keysEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function recoveryKeyPath(stateDir) {
  return join(stateDir, RECOVERY_KEY_FILE);
}

export function createRecoveryKeyStore({ stateDir }) {
  const path = recoveryKeyPath(stateDir);
  let identity = null;
  let stagedCandidate = null;

  const read = ({ optional = false } = {}) => {
    if (!existsSync(path)) {
      if (optional) return null;
      throw new Error("Matrix recovery key is not stored for this encrypted account");
    }
    assertSecureDirectory(stateDir, "Matrix crypto state directory");
    assertSecureFile(path, "Matrix recovery key file");
    let payload;
    try {
      payload = validateStorePayload(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Matrix recovery key state is malformed or unsupported", {
          cause: new Error("JSON syntax error"),
        });
      }
      throw error;
    }
    if (identity && !identitiesEqual(payload.identity, identity)) {
      throw new Error("Matrix recovery key identity does not match the authenticated encrypted account");
    }
    return payload;
  };

  const write = (payload) => {
    assertSecureDirectory(stateDir, "Matrix crypto state directory");
    const existing = read({ optional: true });
    if (existing && !keysEqual(existing.privateKey, decodeStoredPrivateKey(payload.privateKeyBase64))) {
      throw new Error("Refusing to replace the stored Matrix recovery key");
    }
    durableReplace(path, `${JSON.stringify(payload, null, 2)}\n`);
  };

  const stageGeneratedKey = (generated) => {
    if (!identity) throw new Error("Matrix recovery key identity is not initialized");
    if (!(generated?.privateKey instanceof Uint8Array) || generated.privateKey.length !== PRIVATE_KEY_BYTES) {
      throw new Error("Matrix SDK generated an invalid secret-storage private key");
    }
    const normalized = {
      privateKey: new Uint8Array(generated.privateKey),
      encodedPrivateKey: normalizeEncodedRecoveryKey(generated.encodedPrivateKey),
      keyInfo: normalizeKeyInfo(generated.keyInfo),
    };
    const existing = read({ optional: true });
    if (existing) {
      if (!keysEqual(existing.privateKey, normalized.privateKey)) {
        throw new Error("Refusing to replace the stored Matrix recovery key");
      }
      return {
        privateKey: existing.privateKey,
        encodedPrivateKey: existing.encodedPrivateKey,
        ...(existing.keyInfo ? { keyInfo: existing.keyInfo } : {}),
      };
    }
    if (stagedCandidate && !keysEqual(stagedCandidate.privateKey, normalized.privateKey)) {
      throw new Error("Refusing to replace the staged Matrix recovery key");
    }
    write(makeStorePayload({ identity, generated: normalized }));
    stagedCandidate = null;
    return normalized;
  };

  const currentKey = () => {
    const stored = read({ optional: true });
    if (stored) return stored;
    if (stagedCandidate) return stagedCandidate;
    throw new Error("Matrix recovery key is not stored for this encrypted account");
  };

  const store = {
    path,
    setIdentity(nextIdentity) {
      const normalized = normalizeIdentity(nextIdentity);
      if (identity && !identitiesEqual(identity, normalized)) {
        throw new Error("Matrix recovery key store identity cannot change during a client lifecycle");
      }
      identity = normalized;
      read({ optional: true });
    },
    hasRecoveryKey() {
      return read({ optional: true }) !== null || stagedCandidate !== null;
    },
    stageGeneratedKey,
    stageEncodedKey(encodedPrivateKey, decodeRecoveryKey) {
      if (typeof decodeRecoveryKey !== "function") {
        throw new Error("Matrix recovery key decoder is unavailable");
      }
      const encoded = normalizeEncodedRecoveryKey(encodedPrivateKey);
      let privateKey;
      try {
        privateKey = decodeRecoveryKey(encoded);
      } catch (error) {
        throw new Error("Matrix recovery key is invalid", { cause: error });
      }
      if (!(privateKey instanceof Uint8Array) || privateKey.length !== PRIVATE_KEY_BYTES) {
        throw new Error("Matrix recovery key is invalid");
      }
      const normalized = {
        privateKey: new Uint8Array(privateKey),
        encodedPrivateKey: encoded,
        keyInfo: null,
      };
      const existing = read({ optional: true });
      if (existing) {
        if (!keysEqual(existing.privateKey, normalized.privateKey)) {
          throw new Error("Refusing to replace the stored Matrix recovery key");
        }
        return {
          privateKey: existing.privateKey,
          encodedPrivateKey: existing.encodedPrivateKey,
          ...(existing.keyInfo ? { keyInfo: existing.keyInfo } : {}),
          candidate: false,
        };
      }
      if (stagedCandidate && !keysEqual(stagedCandidate.privateKey, normalized.privateKey)) {
        throw new Error("Refusing to replace the staged Matrix recovery key");
      }
      stagedCandidate = normalized;
      return { ...normalized, candidate: true };
    },
    commitKeyId(keyId, keyInfo, privateKey) {
      if (typeof keyId !== "string" || !keyId) {
        throw new Error("Matrix secret storage returned an invalid key ID");
      }
      const existing = read({ optional: true });
      const current = existing ?? stagedCandidate;
      if (!current) {
        throw new Error("Matrix recovery key is not available to commit");
      }
      if (privateKey && !keysEqual(current.privateKey, privateKey)) {
        throw new Error("Matrix secret storage cached an unexpected recovery key");
      }
      write(makeStorePayload({
        identity,
        existing,
        generated: current,
        keyId,
        keyInfo: normalizeKeyInfo(keyInfo) ?? current.keyInfo,
      }));
      stagedCandidate = null;
    },
    discardStagedKey() {
      stagedCandidate?.privateKey.fill(0);
      stagedCandidate = null;
    },
    getPrivateKey() {
      return currentKey().privateKey;
    },
    getEncodedPrivateKey() {
      return currentKey().encodedPrivateKey;
    },
    getGeneratedKey() {
      const stored = currentKey();
      return {
        privateKey: stored.privateKey,
        encodedPrivateKey: stored.encodedPrivateKey,
        ...(stored.keyInfo ? { keyInfo: stored.keyInfo } : {}),
      };
    },
    getSummary() {
      const stored = read({ optional: true });
      return stored
        ? { stored: true, phase: stored.phase, keyId: stored.keyId }
        : stagedCandidate
          ? { stored: false, phase: "candidate", keyId: null }
        : { stored: false, phase: null, keyId: null };
    },
    cryptoCallbacks: {
      async getSecretStorageKey({ keys }) {
        const stored = read({ optional: true }) ?? stagedCandidate;
        if (!stored) return null;
        const requested = Object.keys(keys ?? {});
        const keyId = stored.keyId && requested.includes(stored.keyId)
          ? stored.keyId
          : stored.keyId
            ? null
            : requested[0];
        return keyId ? [keyId, stored.privateKey] : null;
      },
      cacheSecretStorageKey(keyId, keyInfo, privateKey) {
        store.commitKeyId(keyId, keyInfo, privateKey);
      },
    },
  };
  return store;
}

export function writeRecoveryKeyExport(path, { identity, encodedPrivateKey }) {
  const normalizedIdentity = normalizeIdentity(identity);
  const normalizedKey = normalizeEncodedRecoveryKey(encodedPrivateKey);
  const absolute = isAbsolute(path) ? path : resolve(path);
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSecureDirectory(directory, "Matrix recovery key export directory");
  if (existsSync(absolute)) {
    throw new Error("Refusing to overwrite an existing Matrix recovery key export");
  }
  const payload = {
    format: EXPORT_FORMAT,
    version: FORMAT_VERSION,
    identity: normalizedIdentity,
    recoveryKey: normalizedKey,
    createdAt: new Date().toISOString(),
  };
  durablePublishNew(absolute, `${JSON.stringify(payload, null, 2)}\n`);
  return absolute;
}

export function readRecoveryKeyExport(path) {
  const absolute = isAbsolute(path) ? path : resolve(path);
  assertSecureFile(absolute, "Matrix recovery key export");
  let payload;
  try {
    payload = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error("Matrix recovery key export is malformed", {
      cause: error instanceof SyntaxError ? new Error("JSON syntax error") : error,
    });
  }
  if (
    payload?.format !== EXPORT_FORMAT
    || payload?.version !== FORMAT_VERSION
    || typeof payload.createdAt !== "string"
  ) {
    throw new Error("Matrix recovery key export is malformed or unsupported");
  }
  return {
    identity: normalizeIdentity(payload.identity),
    encodedPrivateKey: normalizeEncodedRecoveryKey(payload.recoveryKey),
  };
}

export function ensureRecoveryKeyExport(path, payload) {
  const absolute = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(absolute)) return writeRecoveryKeyExport(absolute, payload);
  const existing = readRecoveryKeyExport(absolute);
  const expectedIdentity = normalizeIdentity(payload?.identity);
  const expectedKey = normalizeEncodedRecoveryKey(payload?.encodedPrivateKey);
  if (
    identitiesEqual(existing.identity, expectedIdentity)
    && existing.encodedPrivateKey === expectedKey
  ) {
    return absolute;
  }
  throw new Error("Refusing to overwrite a different Matrix recovery key export");
}

export function assertRecoveryKeyExportMatches(exported, currentIdentity) {
  const current = normalizeIdentity(currentIdentity);
  if (!exportIdentityMatches(normalizeIdentity(exported?.identity), current)) {
    throw new Error("Matrix recovery key export does not match this homeserver, user, and account");
  }
}

export function assertRecoveryKeyExportOutsideState(stateDir, exportPath) {
  const state = resolve(stateDir);
  const target = resolve(exportPath);
  const relation = relative(state, target);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("Matrix recovery key export must be stored outside the crypto state directory");
  }
}
