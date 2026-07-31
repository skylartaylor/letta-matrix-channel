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
4. The crypto state directory is exclusive to one account. A crash-safe
   PID/liveness lock prevents concurrent use; state is mode `0700`, snapshots
   mode `0600`.
5. State persistence serializes binary IndexedDB records without JSON loss,
   retains a previous known-good generation, and uses atomic replacement.
6. An encrypted outbound message is allowed only after initial sync has loaded
   its room encryption state and crypto startup completed.
7. Undecryptable events never become fake plaintext. They get bounded handling
   and a safe operator diagnostic containing IDs/reason only.

## Device and recovery model

The first encrypted startup creates or restores the bot's Matrix device. The
adapter records the bot user ID and device ID beside its crypto state, verifies
that they match before restore, and logs the device ID locally for manual
verification in an existing Matrix client.

Cross-signing bootstrap, recovery-key upload, and automatic trust repair are
not v1 features. If state is missing or identity metadata does not match, the
adapter fails with a specific recovery error. It must not silently create a new
device over an existing state directory.

## Port phases

### Phase 1 — persistence primitives

`channel/crypto/idb-state.mjs` is the first adapted module. It provides binary
snapshot/restore and account-state locking. It is independently tested, but is
**not integrated into the adapter yet** and does not mean E2EE is supported.

### Phase 2 — crypto runtime and adapter lifecycle

Install the fake IndexedDB runtime, enforce single encrypted-account ownership,
restore state, initialize Rust crypto before sync, and snapshot at startup,
clean stop, and sync/key-processing barriers. A crash must not roll back a
ratchet or reuse an outbound Megolm message index.

### Phase 3 — decryption and trust policy

Deliver only post-decryption `m.room.message` events through existing room,
sender, mention, and dedupe gates. Handle withheld/missing keys explicitly.
Record `shieldState(true)` telemetry without silently imposing a verified-only
policy.

### Phase 4 — real integration tests

No release advertises E2EE until a real homeserver test proves encrypted inbound
and outbound delivery, same-device restart, crash recovery, state corruption
recovery, single-owner enforcement, and no plaintext send before sync.
