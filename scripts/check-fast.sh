#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-all}"

log() { printf '[check-fast] %s\n' "$*"; }
skip() { printf '[check-fast] SKIP: %s\n' "$*"; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

run_backend() {
  if [ ! -d backend/node_modules ]; then
    skip "backend deps missing (run: pnpm install)"
    return 0
  fi
  if ! has_cmd node || ! has_cmd npm; then
    skip "node/npm missing"
    return 0
  fi
  log "backend: lint + env example check + unit tests"
  (cd backend && npm run lint)
  (cd backend && npx tsx --test ../scripts/env-example.test.ts)
  (cd backend && npx tsx ../scripts/env-example.ts backend --check)
  (cd backend && npm run test:unit)
}

run_frontend() {
  if [ ! -d frontend/node_modules ]; then
    skip "frontend deps missing (run: pnpm install)"
    return 0
  fi
  if ! has_cmd node || ! has_cmd pnpm; then
    skip "node/pnpm missing"
    return 0
  fi
  log "frontend: env example check + typecheck + i18n + lint + unit tests"
  (cd frontend && pnpm dlx tsx@4.21.0 ../scripts/env-example.ts frontend --check)
  (cd frontend && pnpm exec tsc --noEmit)
  (cd frontend && pnpm run i18n:check)
  (cd frontend && pnpm exec eslint . --max-warnings 0)
  (cd frontend && pnpm exec jest --ci --runInBand --passWithNoTests)
}

run_contract_fmt() {
  if ! has_cmd cargo; then
    skip "cargo missing (install Rust 1.96.0)"
    return 0
  fi
  log "contract-fmt: cargo fmt --check"
  (cd contract && cargo fmt --all -- --check)
}

run_contract() {
  if ! has_cmd cargo; then
    skip "cargo missing (install Rust 1.96.0)"
    return 0
  fi
  log "contract: cargo test --workspace"
  (cd contract && cargo test --workspace)
}

run_ops_cli() {
  if [ ! -d tools/ops-cli/node_modules ]; then
    skip "ops-cli deps missing (run: pnpm install)"
    return 0
  fi
  if ! has_cmd node || ! has_cmd npm; then
    skip "node/npm missing"
    return 0
  fi
  log "ops-cli: unit tests"
  (cd tools/ops-cli && npm test)
}

run_deps_gate_self() {
  if ! has_cmd node; then
    skip "node missing"
    return 0
  fi
  if [ ! -f scripts/dependency-gate/gate.test.mjs ]; then
    skip "dependency gate tests not found"
    return 0
  fi
  log "deps-gate-self: node --test"
  node --test scripts/dependency-gate/gate.test.mjs
}

case "$MODE" in
  backend) run_backend ;;
  frontend) run_frontend ;;
  contract-fmt) run_contract_fmt ;;
  contract) run_contract ;;
  ops-cli) run_ops_cli ;;
  deps-gate-self) run_deps_gate_self ;;
  all)
    run_backend
    run_frontend
    run_contract_fmt
    run_contract
    run_ops_cli
    run_deps_gate_self
    ;;
  *)
    echo "usage: $0 [backend|frontend|contract-fmt|contract|ops-cli|deps-gate-self|all]" >&2
    exit 2
    ;;
esac
