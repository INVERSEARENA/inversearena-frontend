#!/usr/bin/env bash
set -euo pipefail

# Wrapper for generate-contract-docs.mjs
# Usage:
#   ./scripts/generate-contract-docs.sh          # Regenerate docs
#   ./scripts/generate-contract-docs.sh --check  # Verify docs match without drift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/generate-contract-docs.mjs" "$@"
