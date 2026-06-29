#!/usr/bin/env bash
set -euo pipefail

# Builds all contracts to WASM, reports sizes, and enforces the 64 KB budget.
#
# Produces: target/wasm-metrics/sizes.md
# Uploaded as a CI artifact for tracking size regressions over time.

WASM_DIR="target/wasm32-unknown-unknown/release"
METRICS_DIR="target/wasm-metrics"
BUDGET=65536

echo "Building WASM artifacts..."
cargo build --target wasm32-unknown-unknown --release

# Optimise WASM with wasm-opt (binaryen) if available.
if ! command -v wasm-opt &>/dev/null; then
  echo "wasm-opt not found, attempting to install binaryen..."
  if sudo apt-get update -qq && sudo apt-get install -y -qq binaryen; then
    echo "binaryen installed"
  else
    echo "warning: could not install binaryen; skipping WASM optimisation" >&2
  fi
fi

if command -v wasm-opt &>/dev/null; then
  echo "Optimising WASM artifacts with wasm-opt -Oz..."
  for wasm in "$WASM_DIR"/*.wasm; do
    [[ -f "$wasm" ]] || continue
    wasm-opt -Oz "$wasm" -o "$wasm" 2>/dev/null && echo "  optimised $(basename "$wasm")" || echo "  skipped $(basename "$wasm") (wasm-opt failed)"
  done
fi

mkdir -p "$METRICS_DIR"

{
  echo "# Contract WASM Sizes"
  echo ""
  echo "| Contract | Size (bytes) | Budget (64 KB) | Status |"
  echo "| --- | --- | --- | --- |"
} > "$METRICS_DIR/sizes.md"

FAILED=0

for wasm in "$WASM_DIR"/*.wasm; do
  [[ -f "$wasm" ]] || continue
  NAME=$(basename "$wasm")
  SIZE=$(stat -c%s "$wasm")
  if [[ $SIZE -gt $BUDGET ]]; then
    STATUS="❌ over budget"
    FAILED=1
    echo "Error: $NAME exceeds 64 KB limit ($SIZE bytes)" >&2
  else
    STATUS="✅"
  fi
  echo "| $NAME | $SIZE | $BUDGET | $STATUS |" >> "$METRICS_DIR/sizes.md"
  echo "$NAME: $SIZE bytes — $STATUS"
done

if [[ ! -s "$METRICS_DIR/sizes.md" ]] || ! grep -q "\.wasm" "$METRICS_DIR/sizes.md"; then
  echo "| (no WASM artifacts found) | — | — | — |" >> "$METRICS_DIR/sizes.md"
fi

echo ""
echo "Size report written to $METRICS_DIR/sizes.md"

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
