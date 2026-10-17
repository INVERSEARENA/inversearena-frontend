#!/usr/bin/env bash
set -euo pipefail

# Runs the Soroban contract resource cost benchmarks, compares against baseline,
# and enforces regression thresholds (#1649).
#
# Produces:
#   target/resource-metrics/report.md
#   target/resource-metrics/costs.json
# Uploaded as CI artifacts for tracking resource usage regressions over time.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$WORKSPACE_ROOT/baseline-resource-costs.json"
METRICS_DIR="$WORKSPACE_ROOT/target/resource-metrics"
MARKDOWN_OUT="$METRICS_DIR/report.md"
JSON_OUT="$METRICS_DIR/costs.json"

mkdir -p "$METRICS_DIR"

BLESS_FLAG=""
for arg in "$@"; do
  if [[ "$arg" == "--bless" ]]; then
    BLESS_FLAG="--bless"
  fi
done

PYTHON_BIN="python3"
if ! command -v python3 &>/dev/null && command -v python &>/dev/null; then
  PYTHON_BIN="python"
fi

echo "============================================================"
echo " Running Contract Resource Benchmarks"
echo "============================================================"

# Run cargo test for the resource_benchmarks modules in workspace
TEST_OUTPUT=$(cargo test --workspace resource_benchmarks -- --nocapture 2>&1)
echo "$TEST_OUTPUT"

echo "============================================================"
echo " Evaluating Resource Costs against Baseline"
echo "============================================================"

echo "$TEST_OUTPUT" | "$PYTHON_BIN" "$SCRIPT_DIR/evaluate_resource_costs.py" \
  --baseline "$BASELINE_FILE" \
  --markdown-output "$MARKDOWN_OUT" \
  --json-output "$JSON_OUT" \
  $BLESS_FLAG
