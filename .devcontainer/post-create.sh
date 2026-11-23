#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[devcontainer] installing frontend dependencies"
if [ -d frontend ]; then
  (cd frontend && pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts)
fi

echo "[devcontainer] installing backend dependencies"
if [ -d backend ]; then
  (cd backend && npm ci --ignore-scripts || npm install --ignore-scripts)
fi

echo "[devcontainer] installing tools dependencies"
if [ -d tools/ops-cli ]; then
  (cd tools/ops-cli && npm ci --ignore-scripts || npm install --ignore-scripts)
fi
if [ -d scripts ] && [ -f scripts/package.json ]; then
  (cd scripts && npm ci --ignore-scripts || npm install --ignore-scripts)
fi

echo "[devcontainer] pinned versions"
node -v || true
npm -v || true
pnpm -v || true
rustc -V || true
cargo -V || true
stellar --version || true
pre-commit --version || true

if [ "${INSTALL_PRE_COMMIT:-0}" = "1" ]; then
  echo "[devcontainer] installing pre-commit hooks"
  pre-commit install --install-hooks
else
  echo "[devcontainer] pre-commit hooks not installed (set INSTALL_PRE_COMMIT=1 to enable)"
fi
