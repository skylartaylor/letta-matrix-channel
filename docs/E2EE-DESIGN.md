# E2EE design

## Decision

Adapt the minimum coherent Matrix Rust/WASM crypto runtime from OpenClaw's MIT
Matrix extension while keeping a Letta-native channel adapter. The channel
continues to use `matrix-js-sdk`; it does not use libolm or `matrix-bot-sdk`.

Matrix crypto is a lifecycle subsystem, not a one-line `initRustCrypto()` flag.
The adapter owns bootstrap, host-local persistence, encrypted event delivery,
shutdown, and explicit recovery as one fail-closed boundary. OpenClaw-derived
files and their attribution are listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Non-negotiable invariants

1. Encryption is off by default. Plaintext mode continues to reject sends to
   known encrypted rooms.
2. An encrypted adapter resolves a stable Matrix device, restores crypto state,
   and calls `initRustCrypto()` before sync starts. It never falls back to
   plaintext if any of those steps fail.
3. The pinned Matrix SDK uses process-global Rust-crypto IndexedDB names. Only
   one encrypted Matrix account may run in a listener process. A second account
   fails at startup rather than sharing state.
4. One host-local state directory belongs to one homeserver, channel account,
   Matrix user, and Matrix device. Identity mismatches and suspicious missing
   metadata fail closed.
5. The state directory has one live owner. Locks, stale-owner takeover, active
   markers, and snapshot publication must not delete or release a successor's
   ownership.
6. The current snapshot is authoritative. A previous generation is retained as
   forensic evidence only and is never promoted, because rollback could reuse
   ratchet state or outbound message indices.
7. Outbound messages remain closed until initial sync has loaded current room
   encryption state. Reconnect, catch-up, stopped, and error states close the
   gate again.
8. Undecryptable events never become placeholder plaintext. Diagnostics contain
   identifiers and reasons, not message content.
9. An encrypted client is not reused after `stopClient()`. A clean restart
   creates a new SDK client; an unproven shutdown quarantines the runtime.

## State and ownership

The default crypto state directory is durable
`channel/state/<accountId>`. A configured relative `stateDir` also resolves
from the channel directory, never from the listener's working directory.
Shared or network-mounted state is unsupported because PID liveness is only
meaningful on the local host.

State directories are mode `0700`; snapshots, identity metadata, recovery-key
material, and active markers are mode `0600`. Identity metadata binds the
snapshot to:

- canonical homeserver URL;
- Letta channel account ID;
- Matrix user ID; and
- Matrix device ID.

The first encrypted startup may bootstrap only when it creates the state
directory itself. A pre-existing empty directory is suspicious and fails
closed. Later startups require both matching identity metadata and a valid
current snapshot.

The account lock carries an ownership token. Dead-owner takeover is serialized
through an atomic transition gate and rename so concurrent reclaimers cannot
delete each other's locks. The transition gate is deliberately not reclaimed
automatically after its own owner dies: removing that serialization primitive
after a stale read could remove a live successor's gate. A dead or malformed
gate therefore requires operator inspection.

## Startup and lifecycle

Encrypted startup proceeds in this order:

1. authenticate with `/whoami` and require both `user_id` and `device_id`;
2. set the SDK client's user and device credentials;
3. acquire process and state-directory ownership;
4. validate identity metadata and restore the current snapshot, or perform a
   permitted first bootstrap;
5. write the active-runtime marker;
6. initialize Rust crypto;
7. publish the mandatory first snapshot;
8. inspect and enable an existing usable room-key backup; and
9. attach event listeners and start sync.

`stop()` invalidates the startup epoch immediately. If it arrives while an
asynchronous startup step is in flight, startup performs the same guarded
cleanup and never starts sync afterward. Concurrent `start()` and `stop()` calls
share one reconciliation loop; startup cannot report success while cleanup is
still pending.

Clean shutdown drains work in this order:

1. registered encrypted room sends;
2. the Matrix sync loop;
3. backup upload, backup download, key claim, and outgoing-request workers;
4. the Matrix client and its Rust-crypto backend via `stopClient()`;
5. the final serialized snapshot;
6. the owned active marker, state lock, and process guard.

The pinned SDK does not expose all of these lifecycle promises publicly, so the
adapter validates the expected internal shapes before relying on them. A
timeout or unknown shape makes shutdown unprovable. In that case it retains
ownership and quarantines encrypted startup for the rest of the process rather
than pretending the crypto backend can restart safely.

Filesystem cleanup after a proven client stop is retryable. Completed marker,
lock, and process-release phases are remembered so a retry does not stop the
client twice or touch a successor's lock. A concurrent `start()` is rejected
until that cleanup finishes.

## Persistence barriers

The SDK's browser-oriented crypto store runs in one `fake-indexeddb` instance.
Snapshots serialize its binary values without JSON conversion and are intended
to be restored by the same JavaScript runtime family that created them.

Timer, explicit-barrier, and shutdown snapshots share one serialized queue.
Periodic checkpoints reduce the amount of state exposed to a process crash,
but do not by themselves provide crash consistency. The adapter also places
correctness barriers at the points where local crypto advancement could
otherwise outrun durable state:

- after Rust-crypto initialization and before sync starts;
- before encrypted Matrix writes reach the network;
- before sending the next incremental `/sync` token, after processing the
  preceding response;
- before delivering a newly decrypted message into Letta; and
- during clean shutdown.

The two crypto databases cannot be snapshotted in one IndexedDB transaction.
The implementation therefore reads each database consistently, validates both,
and atomically replaces the snapshot file. It hard-links the old current
snapshot to a temporary previous-generation candidate before replacing current,
so publication never removes the authoritative path.

Byte-identical state is validated but does not rotate generations. The state
directory is still synced before the barrier succeeds. The complete databases
are compared at every incremental-sync barrier; this favors an auditable
correctness boundary over an activity heuristic that might acknowledge
unpersisted key state.

If a decrypted-event checkpoint fails, delivery is retried after the next
successful incremental-sync barrier. That queue is process-local, not a durable
host-delivery queue. Teardown drops pending entries with a content-free warning
so the loss remains observable.

## Encrypted event policy

Only post-decryption `m.room.message` events pass through the existing room,
sender, mention, message-type, and deduplication gates. Wire-encryption and room
encryption state must agree. Missing or withheld keys stay on the encrypted
path and produce bounded diagnostics.

Outbound sends require an allowed room, a running encrypted runtime, current
sync state, and a room known to be encrypted. Plaintext mode checks the same
room state and refuses to send when encryption is enabled there.

The adapter records Matrix shield telemetry using the pinned SDK's encryption
and user-verification APIs. This is diagnostic only; v1 does not silently impose
a verified-senders-only policy.

## Device and recovery model

The host-local snapshot preserves the current device's Olm and Megolm state.
Server-side room-key backup preserves eligible historical Megolm sessions for a
replacement device. Neither mechanism substitutes for the other:

- backup cannot recreate the old Matrix device or its Olm state; and
- a previous local snapshot cannot safely roll back the current device.

Cross-signing, secret storage, and room-key backup are managed by an explicit
offline command while the listener is stopped. Normal startup checks and
enables an existing usable backup, but never creates, replaces, or resets one.
Setup exports the secret-storage recovery key before mutating server recovery
state. It refuses to replace cross-signing or backup state it cannot recover.

The exported recovery key is identity-bound, stored outside the crypto-state
directory, and mode `0600`. A supplied key remains an in-memory candidate until
the server validates it, so a wrong file cannot poison durable local state.

Replacement-device restore requires a new Matrix device ID and an unused state
directory. It imports the complete room-key backup without changing the backup
version, recovers the published cross-signing identity, verifies that the
master-key ID is unchanged, and signs the replacement device. Partial key
imports fail. Backup reset is intentionally absent.

An unclean exit leaves the active marker in place and blocks startup. Offline
recovery requires the operator to inspect the current snapshot, acknowledge the
exact marker token and account/device identity, prove the marker PID is dead,
and acquire the state lock. The command then revalidates all inputs under that
lock and atomically retains the marker as recovery evidence. It never selects
the previous snapshot.

If the current snapshot is missing or corrupt, the old device cannot be safely
recovered from local state. Revoke it in a trusted Matrix client, obtain a token
for a new device ID, use an unused state directory, and restore the room-key
backup if one was configured before the loss.

## Validation

Fast tests cover configuration, lifecycle cancellation and restart, identity
binding, timer cleanup, checkpoint serialization, lock takeover, recovery
controls, SDK compatibility, and plaintext refusal.

The Docker-backed `npm run test:e2ee` gate uses an isolated Synapse and a
separate Matrix peer to prove:

- encrypted inbound and outbound wire events and peer decryption;
- same-device clean restart and device-key continuity;
- explicit recovery after crashes around encrypted writes and acknowledged
  incremental sync;
- peer decryption of both held and post-recovery ciphertext, guarding against
  outbound Megolm-index reuse;
- corrupt-current fail-closed behavior and replacement-device bootstrap;
- cross-process state ownership;
- no plaintext room-send request before or after sync;
- room-key backup creation and upload of new session material;
- rejection of a valid but wrong recovery key without durable poisoning; and
- full historical decryption on a fresh device after backup restore.

These tests establish the current integration boundary. They do not make
snapshot rollback safe, turn the local delivery retry queue into durable
delivery, or establish a verified-senders-only trust policy.
