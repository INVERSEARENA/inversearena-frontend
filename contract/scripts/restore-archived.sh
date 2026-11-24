#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec pnpm --dir "$root/tools/ops-cli" exec tsx "$root/tools/ops-cli/src/cli.ts" restore archived "$@"
