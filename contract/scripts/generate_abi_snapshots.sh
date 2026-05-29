#!/usr/bin/env bash
set -euo pipefail

# Generates or checks ABI snapshots for each compiled contract WASM.
#
# Usage:
#   ./scripts/generate_abi_snapshots.sh           # regenerate snapshots
#   ./scripts/generate_abi_snapshots.sh --check   # verify snapshots match
#
# Requires: stellar CLI (or soroban CLI fallback) and pre-built WASM artifacts.
#   Build first: cargo build --target wasm32-unknown-unknown --release
#
# Snapshot files live at: <contract>/abi_snapshot.json
# Add new snapshot files to git after an intentional interface change.

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

# Stellar CLI >= 21 targets wasm32v1-none; older toolchains use wasm32-unknown-unknown.
# Resolve whichever directory was actually produced by the build.
WASM_DIR=""
for candidate in \
  "target/wasm32v1-none/release" \
  "target/wasm32-unknown-unknown/release"; do
  if ls "${candidate}"/*.wasm &>/dev/null 2>&1; then
    WASM_DIR="$candidate"
    break
  fi
done
if [[ -z "$WASM_DIR" ]]; then
  echo "Error: no WASM build artifacts found. Run 'stellar contract build' first." >&2
  exit 1
fi

CONTRACTS=("arena" "factory" "payout" "staking")
FAILED=0

if command -v stellar &>/dev/null; then
  CLI="stellar"
elif command -v soroban &>/dev/null; then
  CLI="soroban"
else
  echo "Error: neither 'stellar' nor 'soroban' CLI found." >&2
  echo "Install with: cargo install --locked stellar-cli" >&2
  exit 1
fi

for contract in "${CONTRACTS[@]}"; do
  WASM="$WASM_DIR/${contract}.wasm"
  SNAPSHOT="${contract}/abi_snapshot.json"

  if [[ ! -f "$WASM" ]]; then
    echo "Warning: $WASM not found — skipping $contract (build first)."
    continue
  fi

  ACTUAL=$("$CLI" contract inspect --wasm "$WASM" --output xdr-base64-array 2>/dev/null || echo "[]")

  if [[ "$CHECK_MODE" == "true" ]]; then
    if [[ ! -f "$SNAPSHOT" ]]; then
      echo "Error: snapshot missing for $contract ($SNAPSHOT). Run without --check to generate." >&2
      FAILED=1
      continue
    fi
    EXPECTED=$(cat "$SNAPSHOT")
    if [[ "$ACTUAL" != "$EXPECTED" ]]; then
      echo "Error: ABI snapshot mismatch for $contract." >&2
      echo "  Committed: $EXPECTED" >&2
      echo "  Actual:    $ACTUAL" >&2
      echo "  Run without --check to regenerate, then commit the updated snapshot." >&2
      FAILED=1
    else
      echo "$contract: ABI snapshot OK"
    fi
  else
    echo "$ACTUAL" > "$SNAPSHOT"
    echo "$contract: snapshot written to $SNAPSHOT"
  fi
done

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
