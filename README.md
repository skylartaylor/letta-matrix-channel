# letta-matrix-channel

A Matrix custom channel for Letta Code.

> Work in progress. The local prototype is the baseline; this repository
> will become a generic, documented, independently tested implementation.

## Current scope

- Private-room allowlists and Letta route integration
- Plaintext Matrix delivery
- A deliberate E2EE implementation using Matrix's maintained Rust crypto layer
- No credentials, private room IDs

## Development

```bash
npm test
npm run check
```
