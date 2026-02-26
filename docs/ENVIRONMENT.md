# Environment Variables Reference

A consolidated reference for all environment variables used by the Inverse Arena monorepo — both the **Next.js frontend** and the **Node.js/Express backend**.

> **Rule**: Never commit real secrets. Use placeholder values in `.env.example` files and populate actual secrets through your secret manager or CI/CD environment.

---

## Backend (`backend/`)

Copy `backend/.env.example` to `backend/.env` and fill in the values before starting the server.

| Variable                  | Required | Default | Description                                                                              |
| ------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `NODE_ENV`                | Yes      | —       | Runtime environment. One of `development`, `test`, `production`.                         |
| `PORT`                    | No       | `3001`  | HTTP port the Express server listens on.                                                 |
| `MONGODB_URI`             | Yes      | —       | MongoDB connection string (e.g. `mongodb://localhost:27017/inversearena`).               |
| `REDIS_URL`               | Yes      | —       | Redis connection URL used for caching and rate limiting (e.g. `redis://localhost:6379`). |
| `JWT_SECRET`              | Yes      | —       | Secret key used to sign and verify JWT access tokens. Must be long and random.           |
| `JWT_EXPIRES_IN`          | No       | `15m`   | Access token lifetime (e.g. `15m`, `1h`).                                                |
| `JWT_REFRESH_EXPIRES_IN`  | No       | `7d`    | Refresh token lifetime.                                                                  |
| `NONCE_TTL_SECONDS`       | No       | `300`   | TTL in seconds for auth nonce values stored in Redis.                                    |
| `LOG_LEVEL`               | No       | `info`  | Pino log level. One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`.               |
| `SENTRY_DSN`              | No       | —       | Sentry DSN for backend error tracking. Leave empty to disable.                           |
| `ADMIN_API_KEY`           | Yes      | —       | Static secret key that gates admin-only HTTP routes.                                     |
| `ADMIN_TOKEN_TTL_SECONDS` | No       | `300`   | TTL in seconds for admin confirmation tokens.                                            |

### Stellar / Soroban (backend)

| Variable                     | Required | Default               | Description                                                                                                           |
| ---------------------------- | -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK_PASSPHRASE` | Yes      | —                     | Stellar network passphrase (e.g. `Test SDF Network ; September 2015`).                                                |
| `SOROBAN_RPC_URL`            | Yes      | —                     | Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`).                                                    |
| `PAYOUT_CONTRACT_ID`         | Yes      | —                     | Soroban contract ID for the payout distribution contract.                                                             |
| `PAYOUT_METHOD_NAME`         | No       | `distribute_winnings` | Contract method invoked for payouts.                                                                                  |
| `PAYOUT_SOURCE_ACCOUNT`      | Yes      | —                     | Stellar account (G…) that funds and submits payout transactions.                                                      |
| `PAYOUT_HOT_SIGNER_SECRET`   | No       | —                     | Ed25519 secret key for hot signing. Only set in controlled or development environments; prefer KMS/HSM in production. |

### Payout Worker

| Variable                    | Required | Default   | Description                                                                                       |
| --------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------- |
| `PAYOUTS_LIVE_EXECUTION`    | No       | `false`   | Set to `true` to submit transactions to the Soroban network (otherwise dry-run).                  |
| `PAYOUTS_SIGN_WITH_HOT_KEY` | No       | `false`   | Set to `true` to sign transactions with `PAYOUT_HOT_SIGNER_SECRET`. Prefer `false` in production. |
| `PAYOUTS_MAX_ATTEMPTS`      | No       | `5`       | Maximum worker submit retries before marking a transaction as failed.                             |
| `PAYOUTS_MAX_GAS_STROOPS`   | No       | `1000000` | Maximum accepted prepared transaction fee in stroops.                                             |
| `PAYOUTS_CONFIRM_POLL_MS`   | No       | `3000`    | Polling interval in milliseconds when confirming a submitted transaction.                         |
| `PAYOUTS_CONFIRM_MAX_POLLS` | No       | `20`      | Maximum number of confirmation polls before giving up.                                            |

---

## Frontend (`frontend/`)

Copy `frontend/.env.example` (or `frontend/.env.local.example`) to `frontend/.env.local` and fill in the values.

> All frontend variables that must be available in the browser **must** be prefixed with `NEXT_PUBLIC_`.

| Variable                                 | Required | Default         | Description                                                                                                                                                   |
| ---------------------------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                               | Yes      | —               | Next.js runtime environment. Set automatically by the framework in most cases.                                                                                |
| `ALLOWED_ORIGINS`                        | Yes      | —               | Comma-separated list of allowed CORS origins (e.g. `https://app.inversearena.io,https://staging.inversearena.io`). Used by the frontend API proxy middleware. |
| `REDIS_URL`                              | Yes      | —               | Redis connection URL for the frontend rate-limiter middleware.                                                                                                |
| `RATE_LIMIT_NONCE_PREFIX`                | No       | `rl:auth:nonce` | Key prefix for nonce-based rate limiting in Redis.                                                                                                            |
| `RATE_LIMIT_POOLS_PREFIX`                | No       | `rl:pools`      | Key prefix for pool-related rate limiting in Redis.                                                                                                           |
| `NEXT_PUBLIC_APP_ORIGIN`                 | No       | —               | Canonical origin of the frontend app. Used for absolute URL construction.                                                                                     |
| `NEXT_PUBLIC_HORIZON_URL`                | Yes      | —               | Stellar Horizon REST API URL (e.g. `https://horizon-testnet.stellar.org`).                                                                                    |
| `NEXT_PUBLIC_SOROBAN_RPC_URL`            | Yes      | —               | Soroban RPC URL for wallet/contract calls in the browser (e.g. `https://soroban-testnet.stellar.org`).                                                        |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | Yes      | —               | Stellar network passphrase exposed to the client (e.g. `Test SDF Network ; September 2015`).                                                                  |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID`        | Yes      | —               | Soroban contract ID for the arena factory contract.                                                                                                           |
| `NEXT_PUBLIC_STAKING_CONTRACT_ID`        | Yes      | —               | Soroban contract ID for the staking contract.                                                                                                                 |
| `NEXT_PUBLIC_USDC_CONTRACT_ID`           | Yes      | —               | Soroban contract ID for the USDC token.                                                                                                                       |
| `NEXT_PUBLIC_COINGECKO_SIMPLE_PRICE_URL` | No       | —               | Optional override for the CoinGecko simple-price API URL (e.g. `https://api.coingecko.com/api/v3/simple/price`).                                              |
| `NEXT_PUBLIC_SENTRY_DSN`                 | No       | —               | Sentry DSN for frontend error tracking. Leave empty to disable.                                                                                               |

---

## Quick Start Examples

### Backend `.env`

```bash
NODE_ENV=development
PORT=3001
MONGODB_URI=mongodb://localhost:27017/inversearena
REDIS_URL=redis://localhost:6379
JWT_SECRET=replace-with-a-long-random-secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
ADMIN_API_KEY=replace-with-admin-secret
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
PAYOUT_CONTRACT_ID=C...
PAYOUT_SOURCE_ACCOUNT=G...
PAYOUTS_LIVE_EXECUTION=false
PAYOUTS_SIGN_WITH_HOT_KEY=false
```

### Frontend `.env.local`

```bash
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
NEXT_PUBLIC_FACTORY_CONTRACT_ID=C...
NEXT_PUBLIC_STAKING_CONTRACT_ID=C...
NEXT_PUBLIC_USDC_CONTRACT_ID=C...
```

---

## Further Reading

- [Backend README](../backend/README.md)
- [Frontend README](../frontend/README.md)
- [Payout Execution Guide](../backend/docs/PAYOUT_EXECUTION.md)
- [Metrics Reference](../backend/docs/METRICS.md)
