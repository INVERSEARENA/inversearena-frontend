<div align="center">
  <img width="80" height="80" alt="InverseLogo" src="https://github.com/user-attachments/assets/d75a1127-d4d5-4e3c-8289-3e1379552bdb" />

  # Inverse Arena

  **The RWA-powered multiplayer blockchain elimination game where the minority wins.**

  Built on the Stellar Network · Powered by Soroban Smart Contracts

  [![Stellar](https://img.shields.io/badge/Built%20on-Stellar-000000?style=flat-square&logo=stellar&logoColor=white)](https://stellar.org)
  [![Soroban](https://img.shields.io/badge/Smart%20Contracts-Soroban%2FRust-orange?style=flat-square)](https://soroban.stellar.org)
  [![Next.js](https://img.shields.io/badge/Frontend-Next.js%2015-black?style=flat-square&logo=next.js)](https://nextjs.org)
  [![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
</div>

---

## What is Inverse Arena?

Inverse Arena is a high-stakes, real-time PvP elimination game where players compete by making binary choices — **Heads or Tails** — each round. The twist that makes it unique:

> **The minority side always wins. Majority is eliminated.**

Players who pick the option chosen by *fewer* players advance to the next round. This creates a pure psychological battle — every decision is a meta-game of predicting what others will do, then doing the opposite.

While the game runs, entry fees are never idle. Funds are routed into **Real-World Asset (RWA)** yield protocols on Stellar, so the prize pool grows with institutional-grade yield every second the game is live. The last player standing claims the entire pool plus accumulated yield.

---

## The Problem

| Problem | How Inverse Arena Solves It |
|---|---|
| GameFi economies rely on inflationary token emissions that collapse when growth slows | Prize pools are funded by real yield from US Treasury-backed RWAs — no token printing |
| Billions in GameFi TVL earns 0% while locked in contracts | Player stakes earn ~5% APY from Ondo USDY the moment they enter |
| Majority-rule prediction games breed herd behavior and low tension | Contrarian mechanics reward strategic thinking over crowd-following |
| Long matchmaking wait times with no value accrual | Yield accrues from the moment of deposit, even before a game starts |

---

## How the Game Works

```
Players enter → Choose Heads or Tails → Minority advances → Repeat → Last survivor wins
```

1. **Join a Pool** — Players stake USDC, EURC, or XLM to enter an arena.
2. **Yield Starts** — Soroban smart contracts route funds into RWA yield vaults (Ondo USDY).
3. **Each Round** — Every 30–60 seconds, players choose Heads or Tails.
   - The option chosen by the **majority** is eliminated.
   - Players on the **minority** side advance.
4. **Elimination** — Majority players exit; their share remains in the pool.
5. **Winner** — The last player standing claims **Principal + All Accumulated Yield**.

---

## Why Stellar?

Stellar is the optimal foundation for Inverse Arena:

- **2–5 second finality** — Fast enough for real-time elimination rounds
- **~0.00001 XLM per transaction** — Micro-stake games are economically viable
- **Native RWA ecosystem** — Direct access to Ondo USDY, tokenized T-bills, and yield-bearing anchors
- **Passkey support** — Players can sign moves with FaceID or TouchID; no seed phrases needed

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Frontend (Next.js)               │
│  Wallet Connect · Game UI · Leaderboard · Analytics  │
└────────────────────────┬────────────────────────────┘
                         │ REST / WebSocket
┌────────────────────────▼────────────────────────────┐
│                    Backend (Express + TypeScript)     │
│  Auth · Game State · Round Resolution · Job Workers  │
│  PostgreSQL · Redis · BullMQ · Prometheus Metrics    │
└────────────────────────┬────────────────────────────┘
                         │ Soroban RPC
┌────────────────────────▼────────────────────────────┐
│               Stellar Blockchain (Soroban/Rust)      │
│  Arena Manager · RWA Adapter · Payout Contract       │
└─────────────────────────────────────────────────────┘
```

> **RWA Yield Flow:** For a complete end-to-end explanation of how entry fees are converted to USDY, how yield accrues, and how the winner's payout is calculated, see [docs/RWA_YIELD_FLOW.md](docs/RWA_YIELD_FLOW.md).

### Smart Contracts (Rust/WASM on Soroban)

| Contract | Responsibility |
|---|---|
| `arena_manager.rs` | Player states, round timing, elimination logic |
| `rwa_adapter.rs` | Interfaces with Stellar Asset Contracts to deposit into yield protocols |
| `random_engine.rs` | Ledger-based entropy for fair, verifiable round outcomes |
| `payout.rs` | Distributes principal + yield to the winner |
| `factory.rs` | Deploys and manages arena contract instances |

### Backend Services

| Service | Responsibility |
|---|---|
| Round State Machine | `OPEN → CLOSED → RESOLVED → SETTLED` with transactional integrity |
| Payout Worker | BullMQ job queue for Soroban transaction submission with retries |
| Auth Service | Wallet-based JWT authentication with nonce challenge flow |
| Metrics | Prometheus endpoint at `/metrics` for observability |

For a deeper breakdown of the system boundaries, state machines, and data model, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Repository Structure

```
inversearena-frontend/
├── frontend/               # Next.js 15 application
│   ├── src/
│   │   ├── app/            # Next.js App Router pages
│   │   ├── features/       # Feature modules (arena, wallet, leaderboard…)
│   │   ├── components/     # Shared UI components
│   │   └── lib/            # Utilities and SDK wrappers
│   ├── public/             # Static assets
│   └── .env.example        # Frontend environment variable template
│
├── backend/                # Express API + background workers
│   ├── src/
│   │   ├── routes/         # API route handlers
│   │   ├── services/       # Business logic
│   │   ├── workers/        # BullMQ background workers
│   │   ├── middleware/      # Auth, rate limiting, validation
│   │   └── repositories/   # Database access layer
│   ├── prisma/
│   │   └── schema.prisma   # PostgreSQL schema (User, Arena, Pool, Round…)
│   ├── tests/              # Integration and unit tests
│   └── .env.example        # Backend environment variable template
│
└── CONTRIBUTING.md         # Contribution guide (snapshot tests, XDR serialization)
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- PostgreSQL 15+
- Redis 7+
- Docker (optional, for monitoring stack)

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/inversearena-frontend.git
cd inversearena-frontend
```

### 2. Quick Start with Make

A root-level `Makefile` provides a single discoverable entry point for all common tasks:

```bash
make help          # List all available targets
make dev           # Start frontend + backend in development mode
make test          # Run all tests (backend + frontend)
make build         # Build both services for production
make migrate       # Apply pending Prisma migrations (development)
make migrate-prod  # Apply migrations in production (no seed)
make infra         # Start PostgreSQL + Redis via Docker Compose
make monitoring    # Start Prometheus + Grafana monitoring stack
make clean         # Remove build artifacts and node_modules
```

### 3. Set Up the Frontend

```bash
cd frontend
cp .env.example .env.local
pnpm install
pnpm dev
```

The frontend runs at **http://localhost:3000** by default.

### 4. Set Up the Backend

```bash
cd backend
cp .env.example .env
npm install
npm run migrate:dev    # Apply Prisma migrations
npm run dev            # Start API server on port 3001
```

---

## Environment Variables

### Frontend (`frontend/.env.local`)

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | No | `testnet` (default) or `mainnet` |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Yes | Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | Yes | Stellar Horizon endpoint |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID` | Yes | Arena factory contract address |
| `NEXT_PUBLIC_USDC_CONTRACT_ID` | Yes | USDC token contract address |
| `NEXT_PUBLIC_APP_ORIGIN` | Yes | Canonical app URL (used for CORS) |
| `ALLOWED_ORIGINS` | Yes | Comma-separated allowed CORS origins |
| `REDIS_URL` | Yes | Redis connection string (rate limiting) |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry DSN — leave blank to disable error reporting |

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_SECRET` | Yes | Minimum 32-character secret for JWT signing |
| `SOROBAN_RPC_URL` | Yes | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | Yes | Network passphrase |
| `PAYOUT_CONTRACT_ID` | Yes | Payout contract address |
| `PAYOUT_SOURCE_ACCOUNT` | Yes | Stellar account that submits payout transactions |
| `PAYOUTS_LIVE_EXECUTION` | No | `false` (default) — set `true` to submit real transactions |
| `PAYOUTS_SIGN_WITH_HOT_KEY` | No | `false` recommended in production; use external KMS |
| `ADMIN_API_KEY` | Yes | Secret key for admin endpoints |

> Never commit `.env` files. Use a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.) for production credentials.

---

## Running Tests

### Frontend

```bash
cd frontend
pnpm test:frontend        # Jest unit tests
pnpm test:rate-limit      # Rate limiter integration test
pnpm test:pagination      # Pagination integration test
```

### Backend

```bash
cd backend
npm run test:ci                              # All tests
npx tsx tests/round.integration.test.ts     # Round state machine
npx tsx tests/payment.integration.test.ts   # Payout worker
npx tsx tests/auth.unit.test.ts             # Auth service unit tests
```

### Smart Contracts (Rust)

See [CONTRIBUTING.md](CONTRIBUTING.md) for snapshot testing requirements.

```bash
cargo test --manifest-path contract/arena/Cargo.toml
cargo test --manifest-path contract/payout/Cargo.toml
```

---

## Monitoring

Start the full observability stack with Docker Compose:

```bash
cd backend
docker-compose -f docker-compose.monitoring.yml up -d
```

| Service | URL | Default Credentials |
|---|---|---|
| Prometheus | http://localhost:9090 | — |
| Grafana | http://localhost:3000 | admin / admin |
| Metrics endpoint | http://localhost:3001/metrics | — |

Tracked metrics include HTTP request rates and latencies, BullMQ job queue lengths, transaction confirmation rates, and round resolution counts.

---

## Key Management

Inverse Arena is designed for production-grade custody:

- **Recommended**: Set `PAYOUTS_SIGN_WITH_HOT_KEY=false`. The backend builds an unsigned XDR transaction, which is then signed by an external KMS or HSM before being returned to the worker for submission.
- **Development only**: Set `PAYOUTS_SIGN_WITH_HOT_KEY=true` with `PAYOUT_HOT_SIGNER_SECRET` — never use this in production.

---

## Roadmap

| Phase | Status | Milestone |
|---|---|---|
| Phase 1 — Stellar Testnet | ✅ Complete | Soroban core logic, USDC integration, alpha with 100 players |
| Phase 2 — RWA Integration | ⏳ In Progress | Mainnet launch, Ondo USDY yield, MoneyGram Cash-In |
| Phase 3 — Expansion | 🚀 Planned | Mobile app with Passkey, DAO-governed RWA allocation, private arenas |

---

## Contributing

Pull requests are welcome. Before contributing:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) — especially the snapshot testing rules for Soroban contract types.
2. For smart contract contributions, see [docs/CONTRIBUTING_CONTRACTS.md](docs/CONTRIBUTING_CONTRACTS.md) — covers environment setup, build commands, coding conventions, and the PR checklist.
2. Run all relevant tests and ensure they pass.
3. Keep PRs focused — one concern per pull request.

---

## License

MIT — see [LICENSE](LICENSE) for details.
