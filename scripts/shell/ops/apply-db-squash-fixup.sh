#!/usr/bin/env bash
# apply-db-squash-fixup.sh — load .env.ops.dev if present, then register the
# squashed baseline migration hash for existing databases.
#
# Usage:
#   bash scripts/shell/ops/apply-db-squash-fixup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

exec pnpm --filter @herobids/scripts exec tsx ts/apply-db-squash-fixup.ts "$@"