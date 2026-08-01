import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCryptoStateRecovery,
  recoverCryptoStateAfterCrash,
} from "./idb-state.mjs";

const CHANNEL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return [
    "Usage:",
    "  npm run recover:e2ee -- inspect --state-dir <path>",
    "  npm run recover:e2ee -- recover --state-dir <path> \\",
    "    --marker-token <token> --homeserver-url <url> --account-id <id> \\",
    "    --user-id <mxid> --device-id <id>",
    "",
    "Relative state paths resolve from the channel directory.",
  ].join("\n");
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "inspect" && command !== "recover") {
    throw new Error(usage());
  }
  const allowed = command === "inspect"
    ? new Set(["state-dir"])
    : new Set([
        "state-dir",
        "marker-token",
        "homeserver-url",
        "account-id",
        "user-id",
        "device-id",
      ]);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(usage());
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(options, name)) {
      throw new Error(usage());
    }
    options[name] = value;
  }
  if (!options["state-dir"]) throw new Error(usage());
  return { command, options };
}

function required(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`Missing --${name}\n\n${usage()}`);
  return value;
}

try {
  const { command, options } = parseArguments(process.argv.slice(2));
  const stateDir = resolve(CHANNEL_DIR, required(options, "state-dir"));
  if (command === "inspect") {
    const inspection = await inspectCryptoStateRecovery(stateDir);
    console.log(JSON.stringify({ stateDir, ...inspection }, null, 2));
  } else {
    const homeserverUrl = new URL(required(options, "homeserver-url"));
    if (homeserverUrl.protocol !== "https:" || !homeserverUrl.host) {
      throw new Error("--homeserver-url must be an HTTPS URL");
    }
    const recovered = await recoverCryptoStateAfterCrash({
      stateDir,
      markerToken: required(options, "marker-token"),
      expectedIdentity: {
        homeserverUrl: homeserverUrl.href,
        accountId: required(options, "account-id"),
        userId: required(options, "user-id"),
        deviceId: required(options, "device-id"),
      },
    });
    if (!recovered.directorySynced) {
      console.warn(
        "Recovery marker was committed, but the state directory fsync failed; "
        + "a reboot may restore the active marker and require inspection again.",
      );
    }
    if (!recovered.lockReleased) {
      console.warn(
        "Recovery marker was committed, but the recovery lock could not be released; "
        + "restart this command process before starting the listener.",
      );
    }
    console.log(JSON.stringify({
      stateDir,
      recoveredMarkerPath: recovered.recoveredMarkerPath,
      directorySynced: recovered.directorySynced,
      lockReleased: recovered.lockReleased,
      identity: recovered.identity,
      marker: recovered.marker,
      snapshot: recovered.snapshot,
    }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
