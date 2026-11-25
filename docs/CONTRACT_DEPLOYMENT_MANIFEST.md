# Contract Deployment Manifest Guide

This repository uses local contract deployment manifests (`contract/deployment-manifest.json`) to validate contract addresses, network passphrases, WASM hashes, and ABI versions across frontend and backend boundaries.

## Manifest Schema

```json
{
  "schemaVersion": 1,
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "deployedAt": "2026-10-16T12:00:00.000Z",
  "gitCommit": "d18461f1",
  "contracts": {
    "arena": {
      "id": "CA...",
      "wasmHash": "...",
      "abiVersion": "1.0.0",
      "methods": ["init", "join", "commit", "reveal", "close", "resolve", "settle"]
    },
    "factory": { ... },
    "payout": { ... },
    "staking": { ... }
  }
}
```

## Validation Tool

You can validate any deployment manifest file using:

```bash
npx tsx scripts/contract-manifest.ts validate contract/deployment-manifest.json
```

Validation ensures:
- Network passphrase matches the specified network (testnet / mainnet / standalone).
- Contract IDs conform to Stellar StrKey format (`C...`).
- WASM hashes match 64-character SHA-256 hex format.
- All core contracts (`arena`, `factory`, `payout`, `staking`) are present and typed.
