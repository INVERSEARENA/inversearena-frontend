# InverseArena — Deployment Guide

End-to-end reference for building, deploying, and running the InverseArena stack.

---

## Quick Start for Contributors

> Get from `git clone` to a running testnet environment in under 5 minutes.

### 1. Install prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| **Node 20+** | Backend + frontend | [nodejs.org](https://nodejs.org) |
| **Rust stable** | Soroban contract builds | `rustup update stable` |
| **wasm32 target** | Cross-compile contracts | `rustup target add wasm32-unknown-unknown` |
| **Stellar CLI** | Build / deploy contracts | `cargo install --locked stellar-cli` |
| **PostgreSQL** | Backend DB | docker or local install |

Verify:

```bash
node --version        # v20+
stellar --version
rustc --version
```

### 2. Fund testnet accounts

Run the contributor setup script to create and fund all required Stellar testnet accounts:

```bash
cd scripts
npm install
npx tsx setup-testnet.ts
```

This creates four accounts (admin, payout source, two test players), funds them via Stellar Friendbot, and writes keys to `.env.test` in the repo root.

> **WARNING:** Never commit `.env.test`. It contains private keys. It is already in `.gitignore`.

### 3. Build and deploy contracts

```bash
# From repo root
make contracts-build                       # compile + optimise all contracts
make contracts-deploy NETWORK=testnet      # upload + deploy, writes deployed.json
make contracts-init-factory NETWORK=testnet
```

Contract addresses are written to `contract/deployed.json`. Copy them into your environment files.

### 4. Configure environment

Copy the relevant IDs from `contract/deployed.json` into:

```
frontend/.env.local
backend/.env
```

See `contract/DEPLOY.md` for the full env var reference.

### 5. Start the stack

```bash
make backend-dev    # terminal 1
make frontend-dev   # terminal 2
```

---

## Contract Build and Deploy Scripts

Scripts live in `contract/scripts/`. Run them from the `contract/` directory or via `make` targets from the repo root.

### `build.sh`

Compiles all workspace contracts to WASM and optimises each:

```bash
cd contract
bash scripts/build.sh                    # all contracts
bash scripts/build.sh --package arena   # single contract
```

### `deploy.sh`

Uploads WASM and deploys contract instances, writing addresses to `deployed.json`:

```bash
cd contract
bash scripts/deploy.sh --network testnet --source deployer
```

### `init-factory.sh`

Initialises the factory contract with the deployed arena WASM hash:

```bash
cd contract
bash scripts/init-factory.sh --network testnet --source deployer
```

### Makefile targets (from repo root)

```bash
make contracts-build
make contracts-deploy NETWORK=testnet
make contracts-init-factory NETWORK=testnet
make contracts-abi-check
```

---

## Local Development — Game Simulation

To test the full game lifecycle without real players, use the simulation CLI:

```bash
cd backend
npm run simulate -- --players 10 --rounds 5 --network testnet
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--players <n>` | `10` | Number of simulated players |
| `--rounds <n>` | `5` | Maximum rounds to play |
| `--network` | `testnet` | `testnet` or `mainnet` |
| `--arena-id` | (new) | Reuse an existing arena instead of creating one |

The script:

1. Creates N funded keypairs (from environment-configured accounts or generates ephemeral ones)
2. Creates an arena via the factory contract
3. Joins all players
4. Starts the arena and runs rounds, randomly assigning heads/tails
5. Resolves each round, logging eliminations
6. Logs the winner and prize amount

See `backend/scripts/simulate-game.ts` for source and extension points.

---

## Admin Audit Log

Every admin action is written to the `audit_logs` collection in MongoDB. The log is append-only.

Retrieve logs (admin auth required):

```
GET /api/admin/audit-logs?limit=50&action=resolve_round&adminId=apikey:abcdef01
```

Query parameters: `limit` (1–200, default 50), `action`, `adminId`.

---

## Mainnet checklist

- [ ] Separate funded mainnet deployer identity with minimal balance
- [ ] Review all contract WASM with `scripts/generate_abi_snapshots.sh --check`
- [ ] Run `deploy.sh --network mainnet` — script pauses 5 s before proceeding
- [ ] Update frontend + backend env vars with mainnet contract IDs
- [ ] Do not use accounts from `.env.test` on mainnet

---

## Environment variables reference

Copy `backend/.env.example` → `backend/.env` and `frontend/.env.example` →
`frontend/.env.local`, then fill in the values below. Contract IDs come from
`contract/deployed.json` after `deploy.sh`.

### Backend (`backend/.env`)

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port the API listens on |
| `DATABASE_URL` | Postgres connection string (Prisma) |
| `MONGODB_URI` | MongoDB connection string |
| `REDIS_URL` | Redis URL for caching (arena stats, leaderboard) |
| `ADMIN_API_KEY` | API key gating admin routes |
| `ADMIN_TOKEN_TTL_SECONDS` | Lifetime of issued admin tokens |
| `JWT_SECRET` | Secret for signing auth JWTs |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Access / refresh token lifetimes |
| `NONCE_TTL_SECONDS` | Validity window for auth challenge nonces |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase (testnet/mainnet) |
| `PAYOUT_CONTRACT_ID` | Deployed payout contract id |
| `PAYOUT_SOURCE_ACCOUNT` | Account that submits payout transactions |
| `PAYOUT_METHOD_NAME` | Payout contract method (default `distribute_winnings`) |
| `PAYOUTS_LIVE_EXECUTION` | `true` to submit on-chain; `false` builds only |
| `PAYOUTS_SIGN_WITH_HOT_KEY` | Sign payouts with a hot key vs. external signer |
| `PAYOUTS_MAX_GAS_STROOPS` | Reject prepared txs whose fee exceeds this |
| `PAYOUTS_MAX_ATTEMPTS` | Max submission attempts before a payout fails |
| `PAYOUTS_CONFIRM_POLL_MS` / `PAYOUTS_CONFIRM_MAX_POLLS` | Confirmation polling cadence/limit |

### Frontend (`frontend/.env.local`)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_STELLAR_NETWORK` | `testnet` or `public` |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | Network passphrase |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | Horizon endpoint |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID` | Deployed factory contract id |
| `NEXT_PUBLIC_USDC_CONTRACT_ID` | USDC token contract id |
| `NEXT_PUBLIC_APP_ORIGIN` | Public app origin (used for share links / sitemap) |
| `ALLOWED_ORIGINS` | CORS allow-list for the API |
| `REDIS_URL` | Redis URL (if the frontend uses server-side caching) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN (optional) |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` / `NEXT_PUBLIC_SENTRY_RELEASE` | Sentry tagging (optional) |

> There is no `docker-compose.yml` in this repo today; local services (Postgres,
> MongoDB, Redis) are expected to be provided by the developer, and the app is run
> with the `make backend-dev` / `make frontend-dev` targets above.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `NotInitialised` from payout calls | The payout contract was deployed but `initialize(admin, token)` was never called. |
| Payout returns `AlreadyPaid` | The `payout_id` was already executed — idempotency guard. Use a fresh id. |
| Frontend can't reach contracts | `NEXT_PUBLIC_*` contract IDs don't match `contract/deployed.json`, or RPC URL points at the wrong network. |
| API 500s with no obvious cause | Grab the `X-Request-Id` response header and grep the backend logs / Sentry for that id. |
| Arena stats look stale | Redis cache TTL not yet expired; stats are invalidated automatically on round resolution. |
| `make deploy` fails funding accounts | Testnet friendbot rate-limited — wait and retry, or fund manually (see step 2). |
