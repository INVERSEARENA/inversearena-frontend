# Backend Payout Execution

This folder contains the Soroban payout execution layer for winner distributions and the round state machine for game logic.

## Features

### 🎮 Round State Machine
Deterministic, auditable round resolution with:
- State transitions: OPEN → CLOSED → RESOLVED → SETTLED
- Transactional integrity with automatic rollback
- Prometheus metrics for monitoring
- Admin-only resolution endpoint

See [QUICKSTART_ROUNDS.md](./QUICKSTART_ROUNDS.md) for usage.

### 💰 Payout Execution
Soroban-based winner distribution system.

### 📊 Metrics & Monitoring
Prometheus-compatible metrics at `/metrics`:
- HTTP request rates and latencies
- Worker job queue lengths
- Transaction confirmation rates
- Round resolution metrics

See [docs/METRICS.md](./docs/METRICS.md) for details.

## Quick Start

### Setup
```bash
npm install
npm run migrate:dev
npm run dev
```

### Run Tests
```bash
npx tsx tests/round.integration.test.ts
npx tsx tests/payment.integration.test.ts
npx tsx tests/metrics.test.ts
```

### View Metrics
```bash
curl http://localhost:3001/metrics
```

### Start Monitoring
```bash
docker-compose -f docker-compose.monitoring.yml up -d
```
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin/admin)

## Feature flags and env

Set these values in deployment secrets (never commit private keys):

### Round System
- `DATABASE_URL`: PostgreSQL connection string for Prisma

### Payout System
- `PAYOUTS_LIVE_EXECUTION` (`true`/`false`): submit transactions to Soroban when `true`.
- `PAYOUTS_SIGN_WITH_HOT_KEY` (`true`/`false`): enable hot-key signing in service.
- `PAYOUT_HOT_SIGNER_SECRET`: optional hot signer secret (only for controlled environments).
- `PAYOUTS_MAX_GAS_STROOPS`: max accepted prepared transaction fee.
- `PAYOUTS_MAX_ATTEMPTS`: max worker submit retries before marking failed.
- `PAYOUTS_CONFIRM_POLL_MS`: confirmation polling interval.
- `PAYOUTS_CONFIRM_MAX_POLLS`: max confirmation polls.
- `PAYOUT_CONTRACT_ID`: Soroban payout contract.
- `PAYOUT_METHOD_NAME`: contract method (default `distribute_winnings`).
- `PAYOUT_SOURCE_ACCOUNT`: payout source account.
- `STELLAR_NETWORK_PASSPHRASE`: network passphrase.
- `SOROBAN_RPC_URL`: Soroban RPC endpoint.

## Key management approach

- Preferred production mode: `PAYOUTS_SIGN_WITH_HOT_KEY=false`.
- Build unsigned XDR server-side, then sign in an external KMS/HSM signer.
- Return signed XDR to `queueSignedTransaction` for worker submission.
- If hot signing is enabled, keep `PAYOUT_HOT_SIGNER_SECRET` in secret manager only.

## Documentation

- [Metrics & Monitoring](./docs/METRICS.md) - Prometheus metrics guide
- [Round State Machine](./docs/ROUND_STATE_MACHINE.md) - Architecture details
- [Payout Execution](./docs/PAYOUT_EXECUTION.md) - Payment system guide
- [Quick Start Guide](./docs/QUICKSTART_ROUNDS.md) - Getting started
- [Implementation Summary](./docs/IMPLEMENTATION_SUMMARY.md) - Feature overview
