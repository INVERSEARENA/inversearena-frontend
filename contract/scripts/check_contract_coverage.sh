#!/usr/bin/env bash
set -euo pipefail

# Runs contract test coverage with cargo-llvm-cov and enforces ratcheted thresholds (#1651).
#
# Produces:
#   target/llvm-cov/lcov.info
#   target/llvm-cov/html/
#   target/llvm-cov/coverage.json
#   target/llvm-cov/coverage-summary.md
#
# Usage:
#   ./scripts/check_contract_coverage.sh           # Runs coverage and checks thresholds
#   ./scripts/check_contract_coverage.sh --ratchet # Checks and ratchets thresholds upward if coverage improved

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$WORKSPACE_ROOT/target/llvm-cov"
BASELINE_FILE="$WORKSPACE_ROOT/baseline-coverage.json"

RATCHET_FLAG=""
if [[ "${1:-}" == "--ratchet" ]]; then
  RATCHET_FLAG="--ratchet"
fi

echo "=== [1/3] Ensuring arena WASM is built for integration tests ==="
# Arena integration tests embed arena WASM to test dynamic factory deployments.
cargo build -p arena --target wasm32v1-none --release || true

mkdir -p "$REPORT_DIR"

echo "=== [2/3] Running cargo-llvm-cov across contract workspace ==="
# Filter out tests, mocks, and fixtures to measure pure contract implementation code
cargo llvm-cov --workspace \
  --ignore-filename-regex '(/tests/|/test/|/fixtures/|test_|tests\.rs|storage_layout)' \
  --lcov --output-path "$REPORT_DIR/lcov.info" \
  --html --output-dir "$REPORT_DIR/html" \
  --json --output-path "$REPORT_DIR/coverage.json"

echo "=== [3/3] Evaluating coverage against ratcheted thresholds ==="
PYTHON_CMD="python3"
if ! command -v python3 &>/dev/null; then
  PYTHON_CMD="python"
fi

$PYTHON_CMD "$SCRIPT_DIR/evaluate_coverage.py" \
  --coverage "$REPORT_DIR/coverage.json" \
  --baseline "$BASELINE_FILE" \
  --output-markdown "$REPORT_DIR/coverage-summary.md" \
  $RATCHET_FLAG
