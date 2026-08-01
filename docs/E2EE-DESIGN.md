# E2EE design

## Decision

Adapt the minimum coherent Matrix Rust/WASM crypto runtime from OpenClaw's MIT
Matrix extension, while keeping a Letta-native channel adapter. The channel
continues to use `matrix-js-sdk`; it does not use libolm or the vulnerable
`matrix-bot-sdk` transport stack.

This is an adaptation project, not a one-line `initRustCrypto()` flag. OpenClaw
ships crypto bootstrap, fake-IndexedDB persistence, decryption handling,
verification, and restart recovery as a subsystem. Our implementation must do
the same within a smaller Letta-oriented boundary.

## Non-negotiable invariants

1. Encryption is off by default. Plaintext mode continues to reject sends to
   known encrypted rooms.
2. An encrypted adapter restores crypto state and calls `initRustCrypto()`
   before Matrix sync starts. It never falls back to plaintext if that fails.
3. The pinned Matrix SDK has process-global Rust-crypto IndexedDB names. v1
   therefore permits **one encrypted Matrix account per listener process**.
   A second encrypted account fails at startup rather than sharing state.
   Snapshot, restore, and clear operations are restricted to the pinned SDK's
   two crypto database names and validate its expected schema and Olm account.
4. The crypto state directory is exclusive to one account. A crash-safe
   PID/liveness lock prevents concurrent use, and a separate transition gate
   serializes stale-owner replacement, publication, and release. State is mode
   `0700`; snapshots and identity metadata are mode `0600`.
   The state directory must be host-local; shared or network-mounted crypto
   state is unsupported because PID liveness has only host-local meaning.
   The gate is deliberately not auto-reclaimed after its owner dies: deleting
   the serialization primitive after a stale read could delete a live
   successor's gate and reintroduce the takeover race. Live contention reports
   the owning PID and asks the caller to retry; a dead or malformed transition
   gate fails closed for operator recovery.
5. State persistence serializes binary IndexedDB records without JSON loss,
   retains a previous generation as forensic evidence only, uses
   one readonly transaction per crypto database plus atomic file replacement,
   and serializes periodic, explicit-barrier, and shutdown checkpoints.
   Publishing a new snapshot never removes the authoritative current path:
   the old current is hard-linked through a temporary previous candidate
   before the new temporary atomically replaces current.
   Previous-generation promotion is forbidden, whether automatic or manual,
   because ratchet rollback can reuse keys or outbound message indices.
6. Outbound messages are allowed only after initial sync has loaded room
   encryption state and while the SDK reports that state as current. Any
   reconnect, catch-up, stopped, or error state closes the outbound gate until
   sync is current again.
7. Undecryptable events never become fake plaintext. They get bounded handling
   and a safe operator diagnostic containing IDs/reason only.

## Device and recovery model

The first encrypted startup creates or restores the bot's Matrix device. A
first bootstrap is allowed only when the runtime itself creates the state
directory; a pre-existing empty directory is treated as suspicious. The
adapter records the homeserver, channel account ID, bot user ID, and device ID
beside its crypto state and verifies that they match before restore. The
default directory is durable `channel/state/<account>`, and configured relative
paths are resolved from `channel/`, not the listener's process directory.

Cross-signing bootstrap, recovery-key upload, and automatic trust repair are
not v1 features. If state is missing or identity metadata does not match, the
adapter fails with a specific recovery error. It must not silently create a new
device over an existing state directory.

## Port phases

### Phase 1 — persistence primitives

`channel/crypto/idb-state.mjs` is the first adapted module. It provides binary
snapshot/restore and account-state locking. It is independently tested and
used by the phase-2 runtime, but does not by itself mean E2EE is supported.

### Phase 2 — crypto runtime and adapter lifecycle

Install the fake IndexedDB runtime, enforce single encrypted-account ownership,
restore state, initialize Rust crypto before sync, and snapshot at startup,
periodically, on clean stop, and at exposed sync/key-processing barriers.

These checkpoints reduce the amount of state exposed to a process crash.
Fake-IndexedDB snapshots cannot transact across both crypto databases, so
encrypted network writes pass a serialized snapshot barrier after the SDK
advances crypto state and before the request reaches the network.
Previous-generation rollback remains forbidden.

Clean shutdown advances through a final snapshot, owned active-marker removal,
filesystem-lock release, and process-guard release. Each destructive step
records its completed phase, so a transient filesystem failure can be retried
without repeating Matrix client shutdown or touching a successor's lock. Until
the retry completes, startup stays blocked and ownership remains held.
Ownership loss, malformed metadata, and dead transition gates are not
advertised as retryable: they permanently quarantine encrypted startup in that
process and require operator recovery.

The runtime-active marker makes an unclean process exit fail closed on the next
startup. Recovery is an explicit offline operation: inspect the state, confirm
the exact marker token plus homeserver/account/user/device identity, acquire
and safely reclaim the dead owner's state lock, revalidate the secure marker,
identity, and current snapshot under that lock, verify the marker PID is dead,
then atomically move the marker to retained recovery evidence. Startup never
auto-clears the marker, and recovery never selects the previous snapshot.

If Rust initialization rejects, the mandatory first snapshot fails, an
IndexedDB delete is blocked, or Matrix client shutdown cannot be proven, the
interval timer is stopped but the marker, filesystem lock, and process guard
remain quarantined until process exit.

Phase 3 and the real-room gate are now implemented. Encrypted delivery and
sending are enabled only after guarded crypto startup; plaintext mode continues
to drop encrypted timeline events and refuse sends to encrypted rooms.

### Phase 3 — decryption and trust policy

Deliver only post-decryption `m.room.message` events through existing room,
sender, mention, and dedupe gates. Handle withheld/missing keys explicitly.
Record strict shield telemetry, derived from the pinned SDK's public encryption
and user-verification APIs, without silently imposing a verified-only policy.

### Phase 4 — real integration tests

No release advertises E2EE until a real homeserver test proves encrypted inbound
and outbound delivery, same-device restart, crash recovery, state corruption
recovery, single-owner enforcement, and no plaintext send before sync.

The Docker-backed `npm run test:e2ee` gate now proves real encrypted inbound and
outbound wire events, peer decryption, same-device clean restart, device-key
continuity, explicit recovery after SIGKILL both before the room fetch and
after Synapse accepts the event, continued bidirectional encryption without
Megolm-index reuse, corrupt-current fail-closed behavior, new-device bootstrap
on an unused state directory with old-device revocation, cross-process
state-lock enforcement, and no plaintext room-send request before or after
sync.

A missing or corrupt current snapshot is not recoverable as the same device.
The operator must revoke that device through a trusted Matrix client, obtain a
token bound to a new device ID, and bootstrap an unused state directory.
