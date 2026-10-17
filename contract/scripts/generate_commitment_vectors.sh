#!/usr/bin/env bash
set -euo pipefail

# Generates or checks golden commitment test vectors (#1643).
#
# Usage:
#   ./scripts/generate_commitment_vectors.sh --check  # Verify test vectors match
#   ./scripts/generate_commitment_vectors.sh --bless  # Regenerate test vectors

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE="${1:-}"

if [[ "$MODE" == "--bless" ]]; then
  echo "Regenerating commitment test vectors..."
  if command -v python3 &>/dev/null; then
    python3 "$SCRIPT_DIR/generate_commitment_vectors.py" --bless
  elif command -v python &>/dev/null; then
    python "$SCRIPT_DIR/generate_commitment_vectors.py" --bless
  else
    echo "Python not found, using cargo test bless..."
    BLESS=1 cargo test --manifest-path "$REPO_ROOT/contract/Cargo.toml" -p arena test_vectors:: -- --nocapture
  fi
elif [[ "$MODE" == "--check" ]]; then
  echo "Checking commitment test vectors..."
  if command -v python3 &>/dev/null; then
    python3 "$SCRIPT_DIR/generate_commitment_vectors.py" --check
  elif command -v python &>/dev/null; then
    python "$SCRIPT_DIR/generate_commitment_vectors.py" --check
  else
    cargo test --manifest-path "$REPO_ROOT/contract/Cargo.toml" -p arena test_vectors::
  fi
else
  echo "Usage: $0 [--check | --bless]"
  exit 1
fi
