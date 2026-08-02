import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  main,
  recoveryManagementAccount,
  safeTerminalToken,
} from "./manage-recovery.mjs";

const root = mkdtempSync(join(tmpdir(), "letta-matrix-recovery-cli-"));
const command = fileURLToPath(new URL("./manage-recovery.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [command, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function writeAccounts(path, config, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify({
    accounts: [{
      channel: "matrix",
      accountId: "main",
      enabled: true,
      config,
    }],
  })}\n`, { mode });
  chmodSync(path, mode);
}

try {
  let result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:\n {2}/);
  assert.equal(safeTerminalToken("1\u001b[2Kforged\r\nline\u009b"), "1 [2Kforged  line");
  const managementAccount = recoveryManagementAccount({
    accountId: "main",
    config: { readReceipts: true, typingIndicators: true, ackReaction: true },
  });
  assert.deepEqual(
    {
      readReceipts: managementAccount.config.readReceipts,
      typingIndicators: managementAccount.config.typingIndicators,
      ackReaction: managementAccount.config.ackReaction,
    },
    { readReceipts: false, typingIndicators: false, ackReaction: false },
  );

  result = run(["setup"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /setup requires --recovery-key-output/);

  result = run(["setup", "--password", "must-not-be-an-argument"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --password/);

  const insecureAccounts = join(root, "insecure-accounts.json");
  writeAccounts(insecureAccounts, {}, 0o644);
  result = run(["status", "--accounts-file", insecureAccounts]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /permissions must be 0600/);

  const malformedAccounts = join(root, "malformed-accounts.json");
  writeFileSync(malformedAccounts, '{"bot_token":syt_secret}\n', { mode: 0o600 });
  chmodSync(malformedAccounts, 0o600);
  result = run(["status", "--accounts-file", malformedAccounts]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
  assert.match(result.stderr, /Caused by: JSON syntax error/);
  assert.doesNotMatch(result.stderr, /syt_secret/);

  const disabledAccounts = join(root, "disabled-accounts.json");
  writeAccounts(disabledAccounts, {
    homeserverUrl: "https://example.org",
    bot_token: "secret-token",
    encryption: { enabled: false },
  });
  result = run(["status", "--accounts-file", disabledAccounts]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /encryption\.enabled=true/);

  const encryptedAccounts = join(root, "encrypted-accounts.json");
  writeAccounts(encryptedAccounts, {
    homeserverUrl: "https://example.org",
    bot_token: "secret-token",
    allowedRooms: ["!room:example.org"],
    allowedUsers: ["@user:example.org"],
    encryption: { enabled: true, stateDir: join(root, "state") },
  });
  let capturedManagementAccount;
  let managementStartCount = 0;
  let managementStopCount = 0;
  const originalLog = console.log;
  try {
    console.log = () => {};
    await main({
      argv: ["status", "--accounts-file", encryptedAccounts, "--json"],
      createAdapter: (account) => {
        capturedManagementAccount = account;
        return {
          start: async () => { managementStartCount += 1; },
          getEncryptionRecoveryStatus: async () => ({
            serverVersion: null,
            activeVersion: null,
            backupUsable: false,
            secretStorageReady: false,
            crossSigningReady: false,
            deviceSignedByOwner: null,
            recoveryKeyStored: false,
          }),
          stop: async () => { managementStopCount += 1; },
        };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(managementStartCount, 1);
  assert.equal(managementStopCount, 1);
  assert.deepEqual(
    {
      readReceipts: capturedManagementAccount.config.readReceipts,
      typingIndicators: capturedManagementAccount.config.typingIndicators,
      ackReaction: capturedManagementAccount.config.ackReaction,
    },
    { readReceipts: false, typingIndicators: false, ackReaction: false },
  );

  result = run([
    "status",
    "--accounts-file", encryptedAccounts,
    "--account-id", "\u001b[2Jx\rforged",
  ]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /\u001b|\r/);
  assert.match(result.stderr, /Matrix account +\[2Jx forged was not found/);

  const trimmedState = join(root, "trimmed-state");
  const trimmedStateAccounts = join(root, "trimmed-state-accounts.json");
  writeAccounts(trimmedStateAccounts, {
    homeserverUrl: "https://example.org",
    bot_token: "secret-token",
    allowedRooms: ["!room:example.org"],
    allowedUsers: ["@user:example.org"],
    encryption: { enabled: true, stateDir: `  ${trimmedState}  ` },
  });
  result = run([
    "setup",
    "--accounts-file", trimmedStateAccounts,
    "--recovery-key-output", join(trimmedState, "recovery.json"),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the crypto state directory/);

  const passwordFile = join(root, "password");
  writeFileSync(passwordFile, "secret-password\n", { mode: 0o644 });
  chmodSync(passwordFile, 0o644);
  const exportDirectory = join(root, "exports");
  mkdirSync(exportDirectory, { mode: 0o700 });
  result = run([
    "setup",
    "--accounts-file", encryptedAccounts,
    "--recovery-key-output", join(exportDirectory, "recovery.json"),
    "--password-file", passwordFile,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /password file permissions must be 0600/);

  const malformedRecovery = join(root, "malformed-recovery.json");
  writeFileSync(
    malformedRecovery,
    '{"recoveryKey":secret_rec}\n',
    { mode: 0o600 },
  );
  chmodSync(malformedRecovery, 0o600);
  result = run([
    "restore",
    "--accounts-file", encryptedAccounts,
    "--recovery-key-file", malformedRecovery,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Matrix recovery key export is malformed/);
  assert.match(result.stderr, /Caused by: JSON syntax error/);
  assert.doesNotMatch(result.stderr, /secret_rec/);

  console.log("Matrix recovery management CLI tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
