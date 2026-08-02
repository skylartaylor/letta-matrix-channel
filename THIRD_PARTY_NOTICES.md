# Third-party notices

`channel/crypto/idb-state.mjs` adapts OpenClaw's Matrix IndexedDB persistence
approach from `extensions/matrix/src/matrix/sdk/idb-persistence.ts` (OpenClaw
revision `b08569f6fdc130810ad73fcec34ebcee72fbe25f`). The file retains a source
notice and this project keeps the required MIT attribution.

`channel/crypto/runtime.mjs` adapts the lifecycle boundary from OpenClaw's
`extensions/matrix/src/matrix/sdk/client-base.ts` at the same source revision.

`channel/crypto/recovery-key-store.mjs` and `channel/crypto/recovery.mjs` adapt
the guarded recovery-key storage model and recovery control flow from:

- `extensions/matrix/src/matrix/sdk/recovery-key-store.ts`
- `extensions/matrix/src/matrix/sdk/client-verification.ts`
- `extensions/matrix/src/matrix/sdk.ts`
- `extensions/matrix/src/cli-verification-backup.ts`

Those adaptations use the same OpenClaw revision identified above and retain
source notices in the files.

OpenClaw is licensed under the MIT License:

> Copyright (c) 2026 OpenClaw Foundation

The full MIT license text is available in this repository's [LICENSE](LICENSE).
