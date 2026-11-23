# Dev Container

The repository includes a working `.devcontainer` for local development with pinned toolchain versions.

## Pinned versions

- Node: `20.20.2`
- npm: `10.9.9`
- pnpm: `10.11.1`
- Rust: `1.82.0`
- Rust CI extra: `1.96.0`
- Rust nightly: `nightly-2026-10-01`
- Stellar CLI: `22.6.0`
- pre-commit: `4.7.0`

## Quickstart

1. Open the repository in VS Code.
2. Run **Dev Containers: Reopen in Container**.
3. Wait for `postCreateCommand` to install frontend/backend/tools dependencies and print pinned versions.

The container uses Docker-in-Docker so `scripts/dev-stack.sh` localhost URLs work as expected.

## Forwarded ports

- `3000` Frontend
- `3001` Backend
- `4000` Ops/Alt
- `5433` Postgres
- `6380` Redis
- `8000` Stellar Quickstart / Horizon / Soroban RPC
- `27018` MongoDB

## Local stack

```bash
make dev
make dev-doctor
make check-fast
make check-toolchain
```

`make dev` runs `scripts/dev-stack.sh up`. Use `bash scripts/dev-stack.sh --check` to validate config without starting services.

## Pre-commit (optional)

Hooks mirror CI fast checks but are optional to install:

```bash
INSTALL_PRE_COMMIT=1 bash .devcontainer/post-create.sh
# or
pre-commit install
```

## Environment

`dev-stack.sh` writes generated env files with:

- `MONGODB_URI` (and compatibility `MONGO_URI`)
- `PORT=3001`
- `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`

It does not write `NEXT_PUBLIC_BACKEND_URL`.
