# Contract Deployment Manifest Generation and Validation Design

## 1. Ownership & Architecture

The contract deployment manifest is the authoritative machine-readable record binding compiled Soroban smart contracts, target Stellar network parameters, and backend/frontend runtime environments.

### Components & Roles
- **Contract Build & Deploy (`contract/scripts/deploy.sh`)**: Deploys bytecode, extracts WASM hashes, and invokes manifest generation.
- **Manifest Engine (`scripts/contract-manifest.ts`)**: Strongly typed schema defining manifest format, hash verification, network passphrase validation, and method signature cross-referencing.
- **Environment Setup (`scripts/setup-testnet.ts`)**: Reads and verifies the manifest before emitting environment files for frontend and backend consumers.

## 2. State Semantics & Validation Rules

A manifest is considered valid if and only if:
1. **Network Passphrase Matches**:
   - `testnet`: `"Test SDF Network ; September 2015"`
   - `mainnet`: `"Public Global Stellar Network ; September 2015"`
   - `standalone`: `"Standalone Network ; February 2017"`
2. **Contract IDs Format**: Every deployed contract (`arena`, `factory`, `payout`, `staking`) must be a valid 56-character strkey starting with `C` (`^C[A-Z2-7]{55}$`).
3. **WASM Hashes Format**: Every contract must have an associated 32-byte SHA-256 hash formatted as a 64-character lowercase hex string (`^[0-9a-f]{64}$`).
4. **ABI Versions**: Each contract entry must specify a semver-compatible ABI version and expected interface methods.

## 3. Failure Behavior and Recovery

- **Network Passphrase Mismatch**: Halts execution immediately to prevent deploying testnet configurations against mainnet RPC endpoints or vice-versa.
- **Incomplete Contracts**: If any required core contract (`arena`, `factory`, `payout`, `staking`) is missing, validation returns a descriptive error list with remediation instructions.
- **Corrupted or Tampered Hashes**: Rejection occurs at startup, guarding the backend poller and frontend RPC clients from communicating with unauthorized or mismatched contract instances.
