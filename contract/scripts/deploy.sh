#!/usr/bin/env bash
# Upload and deploy all compiled Soroban contracts to testnet or mainnet.
# Run from the contract/ workspace root after running build.sh.
#
# Usage:
#   ./scripts/deploy.sh [--network testnet|mainnet] [--source <identity>]
#
# Options:
#   --network   Target network (default: testnet)
#   --source    Stellar CLI identity name (default: deployer)
#
# Outputs:
#   contracts/deployed.json  — contract IDs keyed by contract name
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-deployer}"
CONTRACTS=("arena" "factory" "payout" "staking")
WASM_DIR="target/wasm32-unknown-unknown/release"
DEPLOYED_JSON="deployed.json"

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --source)  SOURCE="$2";  shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Validate network
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "Error: --network must be 'testnet' or 'mainnet'" >&2
  exit 1
fi

if [[ "$NETWORK" == "mainnet" ]]; then
  echo "WARNING: Deploying to MAINNET. Press Ctrl-C within 5 seconds to abort."
  sleep 5
fi

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

echo "=== InverseArena: Soroban contract deploy ==="
echo "Network : $NETWORK"
echo "Source  : $SOURCE"
echo ""

# Initialise JSON output
echo "{}" > "$DEPLOYED_JSON"

for contract in "${CONTRACTS[@]}"; do
  echo "--- Deploying $contract ---"

  # Prefer optimised WASM
  WASM_FILE=""
  for candidate in \
    "$WASM_DIR/${contract}.optimized.wasm" \
    "$WASM_DIR/inverse_${contract//-/_}.optimized.wasm" \
    "$WASM_DIR/${contract}.wasm" \
    "$WASM_DIR/inverse_${contract//-/_}.wasm"; do
    if [[ -f "$candidate" ]]; then
      WASM_FILE="$candidate"
      break
    fi
  done

  if [[ -z "$WASM_FILE" ]]; then
    echo "Error: no WASM artifact found for $contract. Run build.sh first." >&2
    exit 1
  fi

  echo "Uploading $WASM_FILE ..."
  WASM_HASH=$("$CLI" contract upload \
    --wasm "$WASM_FILE" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    --fee 1000000)

  echo "WASM hash: $WASM_HASH"

  echo "Deploying contract instance ..."
  CONTRACT_ID=$("$CLI" contract deploy \
    --wasm-hash "$WASM_HASH" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    --fee 1000000)

  echo "Contract ID: $CONTRACT_ID"

  # Append to deployed.json using jq or pure bash
  if command -v jq &>/dev/null; then
    TMP=$(mktemp)
    jq --arg k "$contract" --arg v "$CONTRACT_ID" '.[$k] = $v' "$DEPLOYED_JSON" > "$TMP"
    mv "$TMP" "$DEPLOYED_JSON"
  else
    # Minimal JSON merge without jq
    TMP_JSON=$(cat "$DEPLOYED_JSON")
    # Remove trailing } and append new entry
    TMP_JSON="${TMP_JSON%\}}"
    if [[ "$TMP_JSON" == "{" ]]; then
      echo "{ \"${contract}\": \"${CONTRACT_ID}\" }" > "$DEPLOYED_JSON"
    else
      echo "${TMP_JSON}, \"${contract}\": \"${CONTRACT_ID}\" }" > "$DEPLOYED_JSON"
    fi
  fi

  echo "Done: $contract deployed to $NETWORK"
  echo ""
done

echo "=== Deploy complete ==="
echo ""
echo "Contract addresses written to $DEPLOYED_JSON:"
cat "$DEPLOYED_JSON"
echo ""
echo "Copy these IDs into your frontend .env.local / backend .env as required."
