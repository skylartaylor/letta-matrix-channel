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
network write, corrupt-current fail-closed behavior, replacement-device
bootstrap with old-device revocation, cross-process state ownership, and
plaintext refusal both before sync and after encrypted room state loads.

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
state directory.
