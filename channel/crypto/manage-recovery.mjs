#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cryptoStateDirectory } from "./paths.mjs";
import {
  assertRecoveryKeyExportOutsideState,
  ensureRecoveryKeyExport,
  readRecoveryKeyExport,
} from "./recovery-key-store.mjs";
import { channelPlugin } from "../plugin.mjs";

const DEFAULT_ACCOUNTS_FILE = resolve(homedir(), ".letta/channels/matrix/accounts.json");

function usage() {
  return [
    "Usage:",
    "  npm run recovery:e2ee -- status [--account-id ID] [--accounts-file PATH] [--json]",
    "  npm run recovery:e2ee -- setup --recovery-key-output PATH [--recovery-key-file PATH]",
    "      [--password-file PATH] [--account-id ID] [--accounts-file PATH] [--json]",
    "  npm run recovery:e2ee -- restore [--recovery-key-file PATH]",
    "      [--account-id ID] [--accounts-file PATH] [--json]",
    "",
    "The Letta listener must be stopped. Recovery keys and passwords are accepted only",
    "from permission-0600 files; they are never accepted in process arguments.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !["status", "setup", "restore"].includes(command)) {
    throw new Error(usage());
  }
  const options = {
    command,
    accountsFile: DEFAULT_ACCOUNTS_FILE,
    accountId: null,
    recoveryKeyFile: null,
    recoveryKeyOutput: null,
    passwordFile: null,
    json: false,
  };
  const valueOptions = new Map([
    ["--accounts-file", "accountsFile"],
    ["--account-id", "accountId"],
    ["--recovery-key-file", "recoveryKeyFile"],
    ["--recovery-key-output", "recoveryKeyOutput"],
    ["--password-file", "passwordFile"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const field = valueOptions.get(arg);
    if (!field) throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[field] = value;
    index += 1;
  }
  if (command !== "setup" && options.passwordFile) {
    throw new Error("--password-file is accepted only by setup");
  }
  if (command !== "setup" && options.recoveryKeyOutput) {
    throw new Error("--recovery-key-output is accepted only by setup");
  }
  if (command === "status" && options.recoveryKeyFile) {
    throw new Error("status does not accept recovery-key input");
  }
  if (command === "setup" && !options.recoveryKeyOutput && !options.recoveryKeyFile) {
    throw new Error(
      "setup requires --recovery-key-output outside the crypto state directory, or an existing --recovery-key-file",
    );
  }
  return options;
}

function secureFileContents(path, label) {
  const absolute = isAbsolute(path) ? path : resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 0600`);
  }
  return { absolute, contents: readFileSync(absolute, "utf8") };
}

function readAccounts(path) {
  const { absolute, contents } = secureFileContents(path, "Matrix accounts file");
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Matrix accounts file is not valid JSON: ${absolute}`, {
      cause: error instanceof SyntaxError ? new Error("JSON syntax error") : error,
    });
  }
  if (!Array.isArray(parsed?.accounts)) {
    throw new Error("Matrix accounts file must contain an accounts array");
  }
  return parsed.accounts.filter((account) => account?.channel === "matrix");
}

function selectAccount(accounts, accountId) {
  if (accountId) {
    const selected = accounts.find((account) => String(account.accountId) === accountId);
    if (!selected) throw new Error(`Matrix account ${accountId} was not found`);
    return selected;
  }
  const enabled = accounts.filter((account) => account.enabled !== false);
  if (enabled.length !== 1) {
    throw new Error("Select a Matrix account explicitly with --account-id");
  }
  return enabled[0];
}

function validateAccount(account) {
  if (account?.config?.encryption?.enabled !== true) {
    throw new Error("Matrix recovery control requires config.encryption.enabled=true");
  }
  if (typeof account?.config?.bot_token !== "string" || !account.config.bot_token.trim()) {
    throw new Error(
      "Matrix recovery control cannot resolve this bot_token outside Letta; provide an accounts file containing the resolved string token",
    );
  }
  return account;
}

function printText(command, result, accountId) {
  const status = result.status ?? result;
  console.log(`Matrix account: ${accountId}`);
  if (command === "restore") {
    console.log(`Imported room keys: ${result.imported}/${result.total}`);
  }
  console.log(`Server backup: ${safeTerminalToken(status.serverVersion)}`);
  console.log(`Active backup: ${safeTerminalToken(status.activeVersion)}`);
  console.log(`Backup usable: ${status.backupUsable ? "yes" : "no"}`);
  console.log(`Secret storage ready: ${status.secretStorageReady ? "yes" : "no"}`);
  console.log(`Cross-signing ready: ${status.crossSigningReady ? "yes" : "no"}`);
  console.log(`Device signed by owner: ${status.deviceSignedByOwner === null ? "unknown" : status.deviceSignedByOwner ? "yes" : "no"}`);
  console.log(`Recovery key stored locally: ${status.recoveryKeyStored ? "yes" : "no"}`);
}

export function safeTerminalToken(value, fallback = "none") {
  const sanitized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 160);
  return sanitized || fallback;
}

export function recoveryManagementAccount(account) {
  return {
    ...account,
    config: {
      ...account.config,
      readReceipts: false,
      typingIndicators: false,
      ackReaction: false,
    },
  };
}

function formatError(error) {
  const messages = [];
  const seen = new Set();
  const visit = (value) => {
    if (value === undefined || value === null || seen.has(value)) return;
    if (typeof value === "object") seen.add(value);
    const message = (value instanceof Error ? value.message : String(value))
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
      .replace(/\n/g, "\n  ")
      .slice(0, 2_000);
    if (message && !messages.includes(message)) messages.push(message);
    if (value instanceof AggregateError) {
      for (const nested of value.errors) visit(nested);
    }
    if (value instanceof Error && value.cause) visit(value.cause);
  };
  visit(error);
  return messages.join("\nCaused by: ") || "Unknown Matrix recovery error";
}

export async function main({
  argv = process.argv.slice(2),
  createAdapter = (account) => channelPlugin.createAdapter(account),
} = {}) {
  const options = parseArgs(argv);
  const account = validateAccount(selectAccount(readAccounts(options.accountsFile), options.accountId));
  const accountId = String(account.accountId);
  const stateDir = cryptoStateDirectory(accountId, account.config.encryption.stateDir);
  const recoveryKeyExport = options.recoveryKeyFile
    ? readRecoveryKeyExport(options.recoveryKeyFile)
    : null;
  const password = options.passwordFile
    ? secureFileContents(options.passwordFile, "Matrix password file").contents.replace(/[\r\n]+$/, "")
    : undefined;
  if (password !== undefined && !password) throw new Error("Matrix password file is empty");

  let recoveryOutput = null;
  if (options.recoveryKeyOutput) {
    recoveryOutput = isAbsolute(options.recoveryKeyOutput)
      ? options.recoveryKeyOutput
      : resolve(options.recoveryKeyOutput);
    assertRecoveryKeyExportOutsideState(stateDir, recoveryOutput);
  }

  const adapter = createAdapter(recoveryManagementAccount(account));
  let result;
  let operationError;
  try {
    await adapter.start();
    if (options.command === "status") {
      result = await adapter.getEncryptionRecoveryStatus();
    } else if (options.command === "setup") {
      result = await adapter.setupEncryptionRecovery({
        recoveryKeyExport,
        password,
        exportRecoveryKey: async (payload) => {
          if (recoveryOutput) ensureRecoveryKeyExport(recoveryOutput, payload);
        },
      });
    } else {
      result = await adapter.restoreEncryptionRecovery({
        recoveryKeyExport,
        progressCallback: options.json
          ? undefined
          : (progress) => {
              if (Number.isSafeInteger(progress?.successes) && Number.isSafeInteger(progress?.total)) {
                process.stderr.write(`\rRestoring Matrix room keys: ${progress.successes}/${progress.total}`);
              }
            },
      });
      if (!options.json) process.stderr.write("\n");
    }
  } catch (error) {
    operationError = error;
  }

  let stopError;
  try {
    await adapter.stop();
  } catch (error) {
    stopError = error;
  }
  if (operationError && stopError) {
    throw new AggregateError([operationError, stopError], "Matrix recovery operation and cleanup both failed");
  }
  if (operationError) throw operationError;
  if (stopError) throw stopError;

  const safeResult = options.command === "setup"
    ? { ...result, recoveryKeyExport: recoveryOutput ?? options.recoveryKeyFile }
    : result;
  if (options.json) console.log(JSON.stringify(safeResult, null, 2));
  else {
    printText(options.command, safeResult, accountId);
    if (options.command === "setup") {
      console.log(`Recovery key export: ${recoveryOutput ?? options.recoveryKeyFile}`);
      console.log("Store that export in an off-machine password manager before treating recovery as durable.");
    }
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}
