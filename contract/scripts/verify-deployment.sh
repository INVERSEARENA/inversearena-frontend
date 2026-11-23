#!/usr/bin/env bash
# Verify that on-chain WASM hashes match the deployment manifest (issue #1638).
#
# For each contract in deployment-manifest.json, fetches the installed WASM
# from the Soroban RPC, sha256-hashes it, and compares against the manifest.
# Exits 1 if any hash mismatches or any contract is unreachable.
#
# Usage:
#   ./scripts/verify-deployment.sh [--manifest <path>] [--network testnet|mainnet]
#
# Prerequisites:
#   stellar CLI installed (cargo install --locked stellar-cli)
#   jq installed
set -euo pipefail

MANIFEST="${MANIFEST:-deployment-manifest.json}"
NETWORK="${NETWORK:-testnet}"
FAIL=0
PASS=0

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --network)  NETWORK="$2";  shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "Error: manifest not found at $MANIFEST" >&2
  exit 1
fi

if ! command -v stellar &>/dev/null; then
  echo "Error: stellar CLI not found. Install: cargo install --locked stellar-cli" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq not found. Install: apt-get install jq / brew install jq" >&2
  exit 1
fi

MANIFEST_COMMIT=$(jq -r '.gitCommit // "unknown"' "$MANIFEST")
echo "=== InverseArena WASM verification ==="
echo "Manifest:  $MANIFEST"
echo "Commit:    $MANIFEST_COMMIT"
echo "Network:   $NETWORK"
echo ""

# Iterate over contracts in the manifest
while IFS= read -r contract_name; do
  CONTRACT_ID=$(jq -r ".contracts.${contract_name}.id" "$MANIFEST")
  EXPECTED_HASH=$(jq -r ".contracts.${contract_name}.wasmHash" "$MANIFEST")

  if [[ "$CONTRACT_ID" == "null" || "$EXPECTED_HASH" == "null" ]]; then
    echo "  SKIP $contract_name — no id/wasmHash in manifest"
    continue
  fi

  echo -n "  Checking $contract_name ($CONTRACT_ID)... "

  # Fetch on-chain WASM to a temp file
  TMPWASM=$(mktemp /tmp/inversearena-verify-XXXXXX.wasm)
  trap 'rm -f "$TMPWASM"' EXIT

  if ! stellar contract fetch \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --out-file "$TMPWASM" 2>/dev/null; then
    echo "FAIL (could not fetch WASM)"
    ((FAIL++)) || true
    continue
  fi

  ACTUAL_HASH=$(sha256sum "$TMPWASM" | awk '{print $1}')

  if [[ "$ACTUAL_HASH" == "$EXPECTED_HASH" ]]; then
    echo "OK  ($ACTUAL_HASH)"
    ((PASS++)) || true
  else
    echo "MISMATCH"
    echo "    Expected: $EXPECTED_HASH"
    echo "    On-chain: $ACTUAL_HASH"
    ((FAIL++)) || true
  fi
done < <(jq -r '.contracts | keys[]' "$MANIFEST")

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "Deployment does NOT match manifest."
  echo "Re-deploy from commit $MANIFEST_COMMIT or update the manifest."
  exit 1
fi

echo "All on-chain WASM hashes match the deployment manifest."
