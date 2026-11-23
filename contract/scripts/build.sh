#!/usr/bin/env bash
# Compile all workspace contracts to WASM and optimise each with the Stellar CLI.
# Run from the contract/ workspace root.
#
# Usage:
#   ./scripts/build.sh
#   ./scripts/build.sh --package arena      # single contract
#
# Outputs:
#   target/wasm32-unknown-unknown/release/<name>.wasm
#   target/wasm32-unknown-unknown/release/<name>.optimized.wasm
set -euo pipefail

CONTRACTS=("arena" "factory" "payout" "staking")
WASM_DIR="target/wasm32-unknown-unknown/release"

# Resolve CLI
if command -v stellar &>/dev/null; then
  CLI="stellar"
elif command -v soroban &>/dev/null; then
  CLI="soroban"
else
  echo "Error: neither 'stellar' nor 'soroban' CLI found." >&2
  echo "Install: cargo install --locked stellar-cli" >&2
  exit 1
fi

# Single-package mode
if [[ "${1:-}" == "--package" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "Usage: $0 --package <contract-name>" >&2
    exit 1
  fi
  CONTRACTS=("$2")
fi

echo "=== InverseArena: Soroban contract build ==="
echo "Contracts: ${CONTRACTS[*]}"
echo ""

for contract in "${CONTRACTS[@]}"; do
  echo "--- Building $contract ---"

  if [[ ! -d "$contract" ]]; then
    echo "Error: directory '$contract' not found. Run from contract/ workspace root." >&2
    exit 1
  fi

  cargo build --manifest-path "$contract/Cargo.toml" \
    --target wasm32-unknown-unknown \
    --release

  WASM_FILE="$WASM_DIR/${contract}.wasm"

  if [[ ! -f "$WASM_FILE" ]]; then
    # Some toolchain/SDK versions name the artifact differently
    # Try underscore form
    WASM_FILE_UNDERSCORE="$WASM_DIR/inverse_${contract//-/_}.wasm"
    if [[ -f "$WASM_FILE_UNDERSCORE" ]]; then
      WASM_FILE="$WASM_FILE_UNDERSCORE"
    else
      echo "Error: WASM artifact not found at $WASM_DIR/${contract}.wasm" >&2
      echo "Check 'cargo build' output above for the actual path." >&2
      exit 1
    fi
  fi

  echo "Optimising $WASM_FILE ..."
  "$CLI" contract optimize --wasm "$WASM_FILE"

  OPTIMIZED="${WASM_FILE%.wasm}.optimized.wasm"
  echo "Built: $OPTIMIZED"
  echo ""
done

echo "=== Build complete ==="
echo ""
echo "Optimised WASM files:"
for contract in "${CONTRACTS[@]}"; do
  ls "$WASM_DIR/${contract}.optimized.wasm" 2>/dev/null \
    || ls "$WASM_DIR/inverse_${contract//-/_}.optimized.wasm" 2>/dev/null \
    || echo "  (not found for $contract)"
done
