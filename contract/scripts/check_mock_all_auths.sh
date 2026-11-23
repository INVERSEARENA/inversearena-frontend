#!/usr/bin/env bash
# Fail if any contract source calls `mock_all_auths` outside the allowlist
# (#1636). See scripts/mock-all-auths-allowlist.txt for why.
#
# Usage: scripts/check_mock_all_auths.sh   (from anywhere)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/mock-all-auths-allowlist.txt"

cd "$ROOT"

allowed() {
  grep -vE '^\s*(#|$)' "$ALLOWLIST" | grep -qxF "$1"
}

status=0
# A call, not a mention: `mock_all_auths(` or `mock_all_auths_allowing_non_root_auth(`
# on a line that is not a `//` comment.
while IFS=: read -r file line _; do
  file="${file#./}"
  if ! allowed "$file"; then
    echo "error: $file:$line calls mock_all_auths but is not in scripts/mock-all-auths-allowlist.txt" >&2
    echo "       use the exact-auth helpers in test-support/auth.rs instead (#1636)" >&2
    status=1
    continue
  fi
  # Production files may only use it inside their test module.
  case "$file" in
    */lib.rs)
      first_test_line="$(grep -n '^#\[cfg(test)\]' "$file" | head -1 | cut -d: -f1)"
      if [ -z "$first_test_line" ] || [ "$line" -lt "$first_test_line" ]; then
        echo "error: $file:$line calls mock_all_auths outside a #[cfg(test)] module" >&2
        status=1
      fi
      ;;
  esac
done < <(
  grep -rnE 'mock_all_auths(_allowing_non_root_auth)?\s*\(' --include='*.rs' . \
    | grep -v '^\./target/' \
    | grep -vE '^[^:]+:[0-9]+:\s*//' \
    || true
)

# Keep the allowlist honest: every entry must exist.
while read -r entry; do
  if [ ! -f "$entry" ]; then
    echo "error: allowlisted file $entry does not exist; remove it from the allowlist" >&2
    status=1
  fi
done < <(grep -vE '^\s*(#|$)' "$ALLOWLIST")

if [ "$status" -eq 0 ]; then
  echo "mock_all_auths is confined to $(grep -cvE '^\s*(#|$)' "$ALLOWLIST") allowlisted test files."
fi
exit "$status"
