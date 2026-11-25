#!/usr/bin/env bash
# Deploy the protocol to a local Stellar network and write a deployment
# manifest for inverse-ops, for the smoke test (#1648).
#
#   stellar container start local          # Docker; RPC on http://localhost:8000/rpc
#   cargo build --workspace --target wasm32v1-none --release   # in contract/
#   tools/ops-cli/scripts/local-stack.sh   # writes tools/ops-cli/.local/manifest.json
#
# Creates one arena through factory.create_pool, so there is an arena with
# state and events to inspect. It does not join a player: join_arena currently
# fails on a real network with VaultDepositFailed (#35), because the vault's
# nested token transfer needs an authorization the arena does not grant.
# Only ever targets the "local" network; identities are throwaway keys.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WASM_DIR="${WASM_DIR:-$ROOT/contract/target/wasm32v1-none/release}"
OUT_DIR="$HERE/../.local"
RPC_URL="${LOCAL_RPC_URL:-http://localhost:8000/rpc}"
NET=(--network local)
ADMIN=inverse-ops-admin
STAKE=10000000 # 1 XLM in stroops

for wasm in arena factory oracle rwa_adapter; do
  [[ -f "$WASM_DIR/$wasm.wasm" ]] || { echo "Missing $WASM_DIR/$wasm.wasm; build the contracts first." >&2; exit 1; }
done

echo "Waiting for $RPC_URL…"
healthy=false
for _ in $(seq 1 150); do # a cold quickstart can take several minutes
  if curl -fsS -X POST -H 'content-type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC_URL" 2>/dev/null | grep -q '"healthy"'; then
    healthy=true
    break
  fi
  sleep 2
done
$healthy || { echo "RPC at $RPC_URL never became healthy; is \`stellar container start local\` running?" >&2; exit 1; }

for _ in $(seq 1 30); do
  stellar keys generate "$ADMIN" "${NET[@]}" --fund --overwrite >/dev/null 2>&1 && break
  sleep 2 # friendbot starts a little after the RPC
done
admin_addr=$(stellar keys address "$ADMIN")

# Run a command; on failure print its output (the CLI reports errors there).
run() {
  local out
  if ! out=$("$@" 2>&1); then
    echo "Failed: $*" >&2
    echo "$out" >&2
    return 1
  fi
  printf '%s\n' "$out" | tail -1
}
deploy() { run stellar contract deploy --wasm "$WASM_DIR/$1.wasm" --source "$ADMIN" "${NET[@]}"; }
invoke() { local id=$1; shift; run stellar contract invoke --id "$id" --source "$ADMIN" "${NET[@]}" -- "$@" >/dev/null; }

echo "Deploying contracts…"
token=$(stellar contract id asset --asset native "${NET[@]}")
stellar contract asset deploy --asset native --source "$ADMIN" "${NET[@]}" >/dev/null 2>&1 || true # exists already on quickstart
arena_hash=$(run stellar contract upload --wasm "$WASM_DIR/arena.wasm" --source "$ADMIN" "${NET[@]}")
factory=$(deploy factory)
oracle=$(deploy oracle)
vault=$(deploy rwa_adapter)

echo "Initialising…"
invoke "$oracle" initialize --admin "$admin_addr" --initial_rate_bps 500
invoke "$vault" initialize --admin "$admin_addr" --stake_token "$token" --oracle "$oracle"
invoke "$factory" initialize --admin "$admin_addr" --min_stake "$STAKE"
invoke "$factory" set_arena_wasm_hash --wasm_hash "$arena_hash"
invoke "$factory" add_to_whitelist --host "$admin_addr"
invoke "$factory" add_supported_token --token "$token"
invoke "$factory" add_approved_vault --vault "$vault"
invoke "$factory" add_approved_oracle --oracle "$oracle"

echo "Creating a pool…"
deadline=$(( $(date +%s) + 3600 ))
config=$(printf '{"stake_token":"%s","yield_vault":"%s","entry_fee":"%s","oracle_contract":"%s","min_players":2,"max_players":10,"round_duration":60,"start_deadline":%s}' \
  "$token" "$vault" "$STAKE" "$oracle" "$deadline")
arena=$(run stellar contract invoke --id "$factory" --source "$ADMIN" "${NET[@]}" -- create_pool \
  --host "$admin_addr" --config "$config" --metadata_hash "$(printf '0%.0s' {1..64})" | tr -d '"')

mkdir -p "$OUT_DIR"
cat > "$OUT_DIR/manifest.json" <<JSON
{
  "schemaVersion": 1,
  "network": "standalone",
  "networkPassphrase": "Standalone Network ; February 2017",
  "rpcUrl": "$RPC_URL",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "factory": { "id": "$factory", "wasmHash": "", "abiVersion": "local", "methods": [] },
    "oracle": { "id": "$oracle", "wasmHash": "", "abiVersion": "local", "methods": [] },
    "rwa_adapter": { "id": "$vault", "wasmHash": "", "abiVersion": "local", "methods": [] }
  },
  "local": { "arena": "$arena", "host": "$admin_addr", "adminKey": "$ADMIN" }
}
JSON
echo "Wrote $OUT_DIR/manifest.json (arena $arena)"
