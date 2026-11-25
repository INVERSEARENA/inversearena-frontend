#!/usr/bin/env bash
set -euo pipefail

# Builds all contracts to WASM, reports sizes, evaluates against baseline,
# and enforces the 64 KB budget and regression thresholds (#1463).
#
# Produces:
#   target/wasm-metrics/sizes.md
#   target/wasm-metrics/sizes.json
# Uploaded as CI artifacts for tracking size regressions over time.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$WORKSPACE_ROOT/target/wasm32-unknown-unknown/release"
METRICS_DIR="$WORKSPACE_ROOT/target/wasm-metrics"
BASELINE_FILE="$WORKSPACE_ROOT/baseline-wasm-sizes.json"
BUDGET=65536
MAX_REGRESSION_PCT=5.0

echo "Building WASM artifacts..."
cargo build --target wasm32-unknown-unknown --release

# Optimise WASM with wasm-opt (binaryen) if available.
if ! command -v wasm-opt &>/dev/null; then
  echo "wasm-opt not found, attempting to install binaryen (v121)..."
  BINARYEN_DIR="/tmp/binaryen"
  if [ ! -f "$BINARYEN_DIR/bin/wasm-opt" ]; then
    mkdir -p "$BINARYEN_DIR"
    curl -sL "https://github.com/WebAssembly/binaryen/releases/download/version_121/binaryen-version_121-x86_64-linux.tar.gz" | tar xz -C "$BINARYEN_DIR" --strip-components=1 || true
  fi
  export PATH="$BINARYEN_DIR/bin:$PATH"
fi

if command -v wasm-opt &>/dev/null; then
  echo "Optimising WASM artifacts with wasm-opt -Oz..."
  for wasm in "$WASM_DIR"/*.wasm; do
    [[ -f "$wasm" ]] || continue
    wasm-opt -Oz --enable-bulk-memory-opt "$wasm" -o "$wasm" && echo "  optimised $(basename "$wasm")" || echo "  skipped $(basename "$wasm") (wasm-opt failed)"
  done
fi

mkdir -p "$METRICS_DIR"

{
  echo "# Contract WASM Sizes & Performance Budgets"
  echo ""
  echo "| Contract | Size (bytes) | Baseline | Delta | Budget (64 KB) | Status |"
  echo "| --- | --- | --- | --- | --- | --- |"
} > "$METRICS_DIR/sizes.md"

FAILED=0
JSON_ENTRIES=()

for wasm in "$WASM_DIR"/*.wasm; do
  [[ -f "$wasm" ]] || continue
  NAME=$(basename "$wasm")
  SIZE=$(stat -c%s "$wasm")
  STATUS="✅"

  # Baseline comparison
  BASELINE="—"
  DELTA_STR="—"
  DELTA_BYTES=0

  if [[ -f "$BASELINE_FILE" ]] && command -v jq &>/dev/null; then
    BASE_VAL=$(jq -r ".contracts[\"$NAME\"].baselineBytes // empty" "$BASELINE_FILE" 2>/dev/null || true)
    if [[ -n "$BASE_VAL" && "$BASE_VAL" != "null" ]]; then
      BASELINE="$BASE_VAL bytes"
      DELTA_BYTES=$(( SIZE - BASE_VAL ))
      DELTA_PCT=$(awk -v cur="$SIZE" -v base="$BASE_VAL" 'BEGIN { printf "%.2f", ((cur - base) / base) * 100 }')
      if [[ $DELTA_BYTES -gt 0 ]]; then
        DELTA_STR="+${DELTA_BYTES}b (+${DELTA_PCT}%)"
      else
        DELTA_STR="${DELTA_BYTES}b (${DELTA_PCT}%)"
      fi

      MAX_PCT=$(jq -r ".contracts[\"$NAME\"].maxAllowedRegressionPercent // $MAX_REGRESSION_PCT" "$BASELINE_FILE" 2>/dev/null || echo "$MAX_REGRESSION_PCT")
      IS_REGRESSION=$(awk -v delta="$DELTA_PCT" -v max="$MAX_PCT" 'BEGIN { print (delta > max) ? 1 : 0 }')
      if [[ $IS_REGRESSION -eq 1 ]]; then
        STATUS="❌ regression > ${MAX_PCT}%"
        FAILED=1
        echo "Error: $NAME regressed by $DELTA_PCT% over baseline (max: $MAX_PCT%)" >&2
      fi
    fi
  fi

  if [[ $SIZE -gt $BUDGET ]]; then
    STATUS="❌ over budget"
    FAILED=1
    echo "Error: $NAME exceeds 64 KB limit ($SIZE bytes)" >&2
  fi

  echo "| $NAME | $SIZE | $BASELINE | $DELTA_STR | $BUDGET | $STATUS |" >> "$METRICS_DIR/sizes.md"
  echo "$NAME: $SIZE bytes (delta: $DELTA_STR) — $STATUS"
  JSON_ENTRIES+=("\"$NAME\": {\"size\": $SIZE, \"budget\": $BUDGET, \"status\": \"$STATUS\"}")
done

if [[ ! -s "$METRICS_DIR/sizes.md" ]] || ! grep -q "\.wasm" "$METRICS_DIR/sizes.md"; then
  echo "| (no WASM artifacts found) | — | — | — | — | — |" >> "$METRICS_DIR/sizes.md"
fi

# Write sizes.json
IFS=,
echo "{\"timestamp\": \"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\", \"contracts\": {${JSON_ENTRIES[*]}}}" > "$METRICS_DIR/sizes.json"

echo ""
echo "Size report written to $METRICS_DIR/sizes.md and $METRICS_DIR/sizes.json"

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
