# letta-matrix-channel

A Matrix custom channel for Letta Code.

> Work in progress. The local prototype is the baseline; this repository
> will become a generic, documented, independently tested implementation.

## Current scope

- Private-room allowlists and Letta route integration
- Plaintext Matrix delivery
- A deliberate E2EE implementation using Matrix's maintained Rust crypto layer
- No credentials, private room IDs

Encryption is off by default. Set `config.encryption.enabled` to `true` for one
account only; the default durable state path is `channel/state/<accountId>`.
An optional `config.encryption.stateDir` resolves relative to `channel/`.

## Development

```bash
npm test
npm run check
```

The slower encrypted-room gate requires Docker and starts an isolated local
Synapse plus a separate peer process:

```bash
npm run test:e2ee
```

That gate proves encrypted inbound/outbound wire events, peer decryption,
same-device clean restart, SIGKILL recovery on both sides of the encrypted
network write and after an acknowledged incremental sync, real-peer decryption
of held and post-recovery ciphertext, corrupt-current fail-closed behavior,
room-key backup creation, bad-recovery-key rejection, historical decryption on
a replacement device after a full backup restore, old-device revocation,
cross-process state ownership, and plaintext refusal both before sync and after
encrypted room state loads.

## Encrypted recovery

Room-key backup is an explicit operator action. Stop the Letta Matrix listener
and run the recovery command with the same JavaScript runtime and channel
installation that owns the crypto state. The command refuses concurrent state
use; it never accepts an access token, account password, or recovery key as a
process argument. The selected Letta `accounts.json` must retain its normal
mode `0600` permissions.

Inspect the current account first:

```bash
npm run recovery:e2ee -- status --account-id main
```

For first-time setup, prepare an empty `0700` export directory and, if the
homeserver requires password UI authentication, a `0600` password file. The
output file must not already exist:

```bash
npm run recovery:e2ee -- setup \
  --account-id main \
  --recovery-key-output /secure/off-machine-copy/matrix-recovery.json \
  --password-file /secure/matrix-password
```

The generated export is mode `0600` and contains the secret-storage recovery
key. Move or copy it into an off-machine password manager before relying on the
backup. Setup refuses to replace an existing server backup or published
cross-signing identity that it cannot recover. If setup fails after writing the
export, rerun the same command: an identical existing export is accepted, while
a different file at that path is never overwritten.

After revoking a lost device and creating a replacement Matrix device with an
unused crypto state directory, restore all backed-up room sessions with:

```bash
npm run recovery:e2ee -- restore \
  --account-id main \
  --recovery-key-file /secure/off-machine-copy/matrix-recovery.json
```

Recovery restores backed-up Megolm room sessions and the account's
cross-signing identity onto the new device. It does not recreate the old device
or make a missing/corrupt local snapshot safe to reuse. An incomplete room-key
import exits as a failure. This slice deliberately has no backup-reset command;
destructive reset remains out of scope.

An unclean encrypted-runtime exit deliberately blocks normal startup. With the
listener stopped, inspect the retained marker and current snapshot:

```bash
npm run recover:e2ee -- inspect --state-dir state/main
```

Then acknowledge that exact marker and account/device binding using the values
from the inspection:

```bash
npm run recover:e2ee -- recover \
  --state-dir state/main \
  --marker-token MARKER_TOKEN \
  --homeserver-url https://matrix.example.org \
  --account-id main \
  --user-id @bot:example.org \
  --device-id DEVICE_ID
```

Relative state paths resolve from `channel/`. Recovery requires a dead marker
process, the exclusive account lock, secure file modes, matching identity
metadata, and a valid current snapshot. It retains the acknowledged marker as
evidence and never selects `crypto-idb.snapshot.previous`.

If the current snapshot is missing or corrupt, do not promote the previous
snapshot or reuse that Matrix device. Revoke the old device from a trusted
Matrix client, obtain a token with a new device ID, and bootstrap an unused
state directory. If room-key backup was configured before the loss, restore it
onto that replacement device using the exported recovery key.
