#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[devcontainer] installing workspace dependencies"
pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

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
