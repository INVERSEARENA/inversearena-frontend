# Contract Workspace Scripts

This directory contains automation tooling for building, verifying, documenting, and deploying the Inverse Arena Soroban smart contracts.

## Scripts Overview

### `generate-contract-docs.mjs` / `generate-contract-docs.sh` (#1646)
Unified documentation generator that extracts error codes, event topics/payloads, and public APIs directly from Rust doc comments and source code.

- **Generates:**
  - `contract/ERRORS.md`: Complete error code registry with variant names, discriminant codes, meanings from doc comments, and user-facing copy.
  - `contract/EVENTS.md`: Event reference table detailing topic symbols, emitting functions, data field types, and descriptions across all contracts.
  - `contract/CONTRACTS.md`: Detailed storage keys (`DataKey`), error variants, and exported public functions (`pub fn`).

- **Usage:**
  ```bash
  # Regenerate documentation:
  node contract/scripts/generate-contract-docs.mjs
  # Or via bash wrapper:
  ./contract/scripts/generate-contract-docs.sh

  # Verify docs match source without drift (CI check):
  node contract/scripts/generate-contract-docs.mjs --check
  # Or via bash wrapper:
  ./contract/scripts/generate-contract-docs.sh --check
  ```

- **Testing:**
  ```bash
  node --test contract/scripts/__tests__/generate-contract-docs.test.mjs
  ```

---

### `generate_abi_snapshots.sh`
Generates or verifies ABI snapshots (`<contract>/abi_snapshot.json`) for each compiled contract WASM using the Stellar CLI.

- **Usage:**
  ```bash
  ./contract/scripts/generate_abi_snapshots.sh          # Regenerate snapshots
  ./contract/scripts/generate_abi_snapshots.sh --check  # Verify snapshots in CI
  ```

---

### `optimize_and_check_wasm.sh`
Optimizes contract WASM artifacts and enforces size budgets (`baseline-wasm-sizes.json`).
