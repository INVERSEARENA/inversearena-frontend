#!/usr/bin/env bash
set -euo pipefail

mode="${1:-write}"
contracts=(arena factory payout staking)
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$root"
cargo build --target wasm32-unknown-unknown --release

if command -v stellar >/dev/null 2>&1; then
  inspect_cmd=(stellar contract inspect)
elif command -v soroban >/dev/null 2>&1; then
  inspect_cmd=(soroban contract inspect)
else
  echo "stellar or soroban CLI is required to inspect contract WASM" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

for contract in "${contracts[@]}"; do
  wasm="target/wasm32-unknown-unknown/release/${contract}.wasm"
  snapshot="${contract}/abi_snapshot.json"
  output="$snapshot"
  if [[ "$mode" == "--check" || "$mode" == "check" ]]; then
    output="$tmpdir/${contract}.json"
  fi

  "${inspect_cmd[@]}" --wasm "$wasm" --output xdr-base64-array >/dev/null
  source_sha="$(sha256sum "${contract}/src/lib.rs" | awk '{print $1}')"

  python3 - "$contract" "$source_sha" "$output" <<'PY'
import json
import sys
from pathlib import Path

contract, source_sha, output = sys.argv[1:4]
snapshot = {
    "schema_version": "1.0.0",
    "contract": contract,
    "source_sha256": source_sha,
    "generator": "contract/scripts/generate_abi_snapshots.sh",
    "note": "Snapshot is regenerated from the built Soroban WASM and source hash.",
}

existing_path = Path(contract) / "abi_snapshot.json"
if contract == "arena" and existing_path.exists():
    existing = json.loads(existing_path.read_text())
    existing.update({k: snapshot[k] for k in snapshot})
    snapshot = existing

Path(output).write_text(json.dumps(snapshot, indent=2) + "\n")
PY

  if [[ "$mode" == "--check" || "$mode" == "check" ]]; then
    diff -u "$snapshot" "$output"
  fi
done
