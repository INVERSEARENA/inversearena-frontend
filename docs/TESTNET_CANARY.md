# Testnet post-deploy canary (#1533)

Operator-triggered canary that exercises the supported arena lifecycle on **testnet only** and writes machine-readable evidence.

## Commands

```bash
# CI / local orchestration (no network)
npx tsx scripts/testnet-canary.ts --fixture --run-id ci-smoke

# Live testnet (manual; requires env guard)
CANARY_ALLOW_TESTNET=1 \
  SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
  FACTORY_CONTRACT_ID=C... \
  npx tsx scripts/testnet-canary.ts --run-id staging-2026-03-26
```

Evidence is written to `.canary-evidence/<run-id>.json` (gitignored). Artifacts must not contain secrets or signed envelopes.

## Scenarios

1. Minimum-size arena happy path through terminal settlement.
2. Recoverable non-reveal / refund path without stranded funds.

Preflight checks validate network (never mainnet), manifests, contract IDs, and destructive-scope guardrails before any mutation.
