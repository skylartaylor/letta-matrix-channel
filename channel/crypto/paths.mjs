import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHANNEL_DIR = dirname(fileURLToPath(new URL("../plugin.mjs", import.meta.url)));

export function stateAccountComponent(accountId) {
  const value = String(accountId ?? "");
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..") {
    return value;
  }
  return `~${Buffer.from(value).toString("base64url") || "empty"}`;
}

export function cryptoStateDirectory(accountId, configuredStateDir) {
  const normalizedStateDir = typeof configuredStateDir === "string"
    ? configuredStateDir.trim()
    : "";
  return normalizedStateDir
    ? resolve(CHANNEL_DIR, normalizedStateDir)
    : resolve(CHANNEL_DIR, "state", stateAccountComponent(accountId));
}
