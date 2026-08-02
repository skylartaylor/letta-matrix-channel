# letta-matrix-channel

A Matrix custom channel for Letta Code, with plaintext delivery and guarded
end-to-end encryption through `matrix-js-sdk` and Matrix's official Rust/WASM
crypto implementation.

## Status

Matrix E2EE is implemented and covered by a Docker-backed real-homeserver gate.
Encryption remains off by default, and plaintext mode refuses outbound messages
to encrypted rooms.

The current encrypted runtime has deliberate boundaries:

- one encrypted Matrix account per Letta listener process;
- private rooms selected by explicit room and sender allowlists;
- host-local crypto state only, never a shared or network-mounted directory;
- no automatic recovery from a missing or corrupt current crypto snapshot;
- room-key backup is an explicit operator action; and
- no backup-reset command.

See [E2EE-DESIGN.md](docs/E2EE-DESIGN.md) for the security model and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for OpenClaw attribution.

## Prerequisites

- A current Letta Code installation with custom-channel support.
- A dedicated Matrix bot account and access token. In encrypted mode,
  `/_matrix/client/account/whoami` must return a stable `device_id` for that
  token.
- A private Matrix room containing the bot and the users allowed to reach the
  agent.
- The room ID and full Matrix user IDs, not display names or aliases.

Create and enable encryption for the room in a trusted Matrix client before
using it for sensitive messages. Matrix room encryption cannot be turned off
again for that room.

## Install

Letta discovers user channels under `~/.letta/channels/<channel-id>/`. From a
clean checkout:

```bash
CHANNEL_HOME="$HOME/.letta/channels/matrix"
mkdir -p "$CHANNEL_HOME"
cp -R channel/. "$CHANNEL_HOME/"
cp "$CHANNEL_HOME/accounts.example.json" "$CHANNEL_HOME/accounts.json"
chmod 600 "$CHANNEL_HOME/accounts.json"

letta channels install matrix
```

`letta channels install matrix` installs the exact runtime dependencies pinned
in `channel/channel.json` beneath the installed channel directory. Stop the
listener before replacing plugin files or changing encrypted state.

## Configure

Edit `~/.letta/channels/matrix/accounts.json`. A minimal encrypted local-agent
account looks like this:

```json
{
  "accounts": [
    {
      "channel": "matrix",
      "accountId": "main",
      "displayName": "Matrix",
      "enabled": true,
      "agentId": "agent-local-REPLACE_WITH_AGENT_ID",
      "dmPolicy": "allowlist",
      "groupPolicy": "allowlist",
      "allowedUsers": ["@you:example.org"],
      "config": {
        "homeserverUrl": "https://matrix.example.org",
        "bot_token": "PASTE_DEDICATED_BOT_ACCESS_TOKEN_HERE",
        "allowedRooms": ["!replace-with-room-id:example.org"],
        "allowedUsers": ["@you:example.org"],
        "requireMention": true,
        "mentionAliases": ["matrix"],
        "encryption": {
          "enabled": true,
          "stateDir": "state/main"
        }
      }
    }
  ]
}
```

Keep `accounts.json` mode `0600` and never commit it. `bot_token` is the
credential field Letta recognizes for redaction and credential-store handling;
the older `accessToken` name is rejected.

`stateDir` is optional. Relative values resolve from the installed channel
directory, not the listener's working directory. The default for account
`main` is also `state/main`.

The account allowlist controls channel-level access. The matching values under
`config` are independently enforced inside this plugin, so keep both layers
aligned.

### Route the room

Custom channels use Letta's normal routing table. Bind the Matrix room to the
target agent and conversation:

```bash
letta channels route add \
  --channel matrix \
  --account-id main \
  --chat-id '!replace-with-room-id:example.org' \
  --agent agent-local-REPLACE_WITH_AGENT_ID \
  --conversation default
```

Inspect the result without exposing the token:

```bash
letta channels status
letta channels route list --channel matrix
```

Routing-file changes take effect when the listener starts; restart an already
running listener after changing a route.

Start a CLI-hosted listener with:

```bash
letta server --backend local --channels matrix --install-channel-runtimes
```

Letta Desktop starts configured channels with its local backend. Fully quit and
reopen the app after installing or updating this custom plugin. The built-in
Channels page may not enumerate user-provided channels; listener status and a
Matrix round trip are the authoritative checks.

## Runtime behavior

- Encrypted startup resolves the authenticated Matrix user and device, restores
  durable crypto state, initializes Rust crypto, and publishes a snapshot
  before sync begins.
- Outbound messages stay closed until initial sync has loaded the room's
  encryption state. Reconnect, catch-up, stopped, and error states close the
  gate again until state is current.
- Crypto state is checkpointed periodically, before encrypted network writes,
  before acknowledging the next incremental sync, and during clean shutdown.
- A failed or unproven shutdown quarantines the encrypted runtime instead of
  pretending it can safely restart.
- Undecryptable events remain encrypted and produce content-free diagnostics;
  they never enter Letta as placeholder plaintext.

These safeguards reduce crash exposure but do not make snapshot rollback safe.
The previous snapshot generation is retained as evidence only and is never
promoted.

## Development

```bash
npm test
npm run check
```

The slower gate requires Docker and starts an isolated Synapse plus a separate
Matrix peer:

```bash
npm run test:e2ee
```

That gate proves encrypted inbound and outbound wire events, peer decryption,
same-device restart, crash boundaries around encrypted writes and incremental
sync, fail-closed corrupt-state handling, cross-process ownership, plaintext
refusal, room-key backup creation, wrong-key rejection, and historical
decryption on a replacement device after a full backup restore.

## Room-key backup

Room-key backup setup does not require replacing or restoring a working device.
Restore is reserved for a planned replacement device with a new Matrix device
ID and an unused state directory.

The listener must be stopped for every recovery command. Run the installed
script with the same JavaScript runtime that owns the crypto state; snapshots
are not portable across arbitrary Node or Electron/V8 versions.

For an npm-installed Letta CLI started by the current `node`:

```bash
CHANNEL_HOME="$HOME/.letta/channels/matrix"
node "$CHANNEL_HOME/crypto/manage-recovery.mjs" status --account-id main
```

For Letta Desktop on macOS:

```bash
CHANNEL_HOME="$HOME/.letta/channels/matrix"
ELECTRON_RUN_AS_NODE=1 /Applications/Letta.app/Contents/MacOS/Letta \
  "$CHANNEL_HOME/crypto/manage-recovery.mjs" status --account-id main
```

Use the same invocation form for `setup` and `restore`.

### First-time backup setup

Prepare an export directory outside the crypto state directory. The directory
must be mode `0700`, and the output file must not already exist:

```bash
mkdir -p /secure/off-machine-copy
chmod 700 /secure/off-machine-copy

node "$CHANNEL_HOME/crypto/manage-recovery.mjs" setup \
  --account-id main \
  --recovery-key-output /secure/off-machine-copy/matrix-recovery.json
```

If the homeserver requires password UI authentication, place the account
password in a separate mode-`0600` file and add:

```text
--password-file /secure/matrix-password
```

The command never accepts the password or recovery key directly in process
arguments. It also cannot resolve a keyring placeholder outside Letta; supply a
mode-`0600` accounts file containing the resolved bot token with
`--accounts-file` when necessary.

The generated recovery export is mode `0600` and contains the secret-storage
recovery key. Store it in an off-machine password manager before treating the
backup as durable. Setup refuses to replace an existing backup or published
cross-signing identity that it cannot recover. If setup fails after writing the
export, rerun it with the same file; a different file is never overwritten.

### Replacement-device restore

After revoking the lost device from a trusted Matrix client, obtain a token with
a new device ID and configure an unused crypto state directory:

```bash
node "$CHANNEL_HOME/crypto/manage-recovery.mjs" restore \
  --account-id main \
  --recovery-key-file /secure/off-machine-copy/matrix-recovery.json
```

Restore imports all backed-up Megolm room sessions, recovers the published
cross-signing identity, and signs the new device. It does not recreate the old
device or make its missing/corrupt snapshot safe to reuse. Partial imports fail
the operation.

## Unclean-shutdown recovery

An unclean encrypted-runtime exit blocks normal startup. With the listener
stopped, inspect the retained marker and current snapshot using the owning
JavaScript runtime:

```bash
node "$CHANNEL_HOME/crypto/recover-state.mjs" inspect \
  --state-dir "$CHANNEL_HOME/state/main"
```

Then acknowledge that exact marker and identity:

```bash
node "$CHANNEL_HOME/crypto/recover-state.mjs" recover \
  --state-dir "$CHANNEL_HOME/state/main" \
  --marker-token MARKER_TOKEN \
  --homeserver-url https://matrix.example.org \
  --account-id main \
  --user-id @bot:example.org \
  --device-id DEVICE_ID
```

Recovery requires a dead marker process, exclusive account ownership, secure
file modes, matching identity metadata, and a valid current snapshot. It
retains the acknowledged marker as evidence and never selects
`crypto-idb.snapshot.previous`.

If the current snapshot is missing or corrupt, do not promote the previous
snapshot or reuse that Matrix device. Revoke it, create a replacement Matrix
device with an unused state directory, and restore the room-key backup.
