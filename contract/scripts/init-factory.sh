#!/usr/bin/env bash
# Initialise the factory contract with the deployed arena WASM hash.
# Run from the contract/ workspace root after deploy.sh has produced deployed.json.
#
# Usage:
#   ./scripts/init-factory.sh [--network testnet|mainnet] [--source <identity>]
#
# Reads FACTORY_CONTRACT_ID and arena WASM hash from deployed.json produced by deploy.sh.
# You can override any value with environment variables:
#   FACTORY_CONTRACT_ID  -- factory contract address
#   ARENA_WASM_HASH      -- arena WASM hash (hex)
#   ADMIN_ADDRESS        -- admin/owner address passed to initialize
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-deployer}"
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

# Read deployed.json
if [[ ! -f "$DEPLOYED_JSON" ]]; then
  echo "Error: $DEPLOYED_JSON not found. Run deploy.sh first." >&2
  exit 1
fi

# Extract IDs — prefer env overrides, fall back to deployed.json
if command -v jq &>/dev/null; then
  FACTORY_CONTRACT_ID="${FACTORY_CONTRACT_ID:-$(jq -r '.factory // empty' "$DEPLOYED_JSON")}"
  ARENA_CONTRACT_ID="${ARENA_CONTRACT_ID:-$(jq -r '.arena // empty' "$DEPLOYED_JSON")}"
else
  # Naive extraction for environments without jq
  FACTORY_CONTRACT_ID="${FACTORY_CONTRACT_ID:-$(grep -o '"factory"[[:space:]]*:[[:space:]]*"[^"]*"' "$DEPLOYED_JSON" | sed 's/.*: *"//' | tr -d '"')}"
  ARENA_CONTRACT_ID="${ARENA_CONTRACT_ID:-$(grep -o '"arena"[[:space:]]*:[[:space:]]*"[^"]*"' "$DEPLOYED_JSON" | sed 's/.*: *"//' | tr -d '"')}"
fi

if [[ -z "$FACTORY_CONTRACT_ID" ]]; then
  echo "Error: factory contract ID not found in $DEPLOYED_JSON and FACTORY_CONTRACT_ID is unset." >&2
  exit 1
fi

if [[ -z "$ARENA_CONTRACT_ID" && -z "${ARENA_WASM_HASH:-}" ]]; then
  echo "Error: arena contract ID not found in $DEPLOYED_JSON and ARENA_WASM_HASH is unset." >&2
  echo "Set ARENA_WASM_HASH=<hex> or ensure deploy.sh wrote 'arena' to $DEPLOYED_JSON." >&2
  exit 1
fi

# If ARENA_WASM_HASH is not already set, retrieve it from the chain
if [[ -z "${ARENA_WASM_HASH:-}" ]]; then
  echo "Fetching arena WASM hash from contract $ARENA_CONTRACT_ID ..."
  ARENA_WASM_HASH=$("$CLI" contract info \
    --id "$ARENA_CONTRACT_ID" \
    --network "$NETWORK" \
    --output json 2>/dev/null | (command -v jq &>/dev/null && jq -r '.wasm_hash' || grep -o '"wasm_hash"[^"]*"[^"]*"' | tail -1 | sed 's/.*"//'))
  if [[ -z "$ARENA_WASM_HASH" ]]; then
    echo "Warning: could not fetch WASM hash automatically. Set ARENA_WASM_HASH manually." >&2
  fi
fi

ADMIN_ADDRESS="${ADMIN_ADDRESS:-}"
if [[ -z "$ADMIN_ADDRESS" ]]; then
  # Default to the public key of the deployer identity
  ADMIN_ADDRESS=$("$CLI" keys address "$SOURCE" 2>/dev/null || echo "")
  if [[ -z "$ADMIN_ADDRESS" ]]; then
    echo "Error: ADMIN_ADDRESS is unset and could not resolve from identity '$SOURCE'." >&2
    exit 1
  fi
fi

echo "=== InverseArena: Factory initialisation ==="
echo "Network         : $NETWORK"
echo "Source          : $SOURCE"
echo "Factory ID      : $FACTORY_CONTRACT_ID"
echo "Arena WASM hash : ${ARENA_WASM_HASH:-<not set>}"
echo "Admin address   : $ADMIN_ADDRESS"
echo ""

echo "Invoking factory initialize ..."
"$CLI" contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --source "$SOURCE" \
  --network "$NETWORK" \
  --fee 1000000 \
  -- initialize \
    --admin "$ADMIN_ADDRESS" \
    --arena_wasm_hash "${ARENA_WASM_HASH:-}"

echo ""
echo "=== Factory initialised successfully ==="
echo ""
echo "Next steps:"
echo "  1. Copy $FACTORY_CONTRACT_ID into NEXT_PUBLIC_FACTORY_CONTRACT_ID in frontend/.env.local"
echo "  2. Run init-factory.sh again if you redeploy the arena contract with a new WASM hash"
