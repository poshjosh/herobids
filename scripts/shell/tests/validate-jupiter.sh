#!/usr/bin/env bash
# validate-jupiter.sh — Operator shell wrapper for Jupiter launch validation.
#
# Sources credentials from .env.venue-validation, then runs the TS validation script.
#
# Usage:
#   ./scripts/shell/tests/validate-jupiter.sh            # dry-run
#   ./scripts/shell/tests/validate-jupiter.sh --execute  # live swap submission

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

ENV_FILE="${REPO_ROOT}/.env.venue-validation"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[✗] Missing ${ENV_FILE}"
  echo "    Create it with at minimum:"
  echo "      SOLANA_WALLET_PRIVATE_KEY=..."
  echo "      SOLANA_RPC_URL=..."
  exit 2
fi

# Source env file (supports KEY=VALUE lines, ignores comments and blank lines)
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

cd "${REPO_ROOT}/scripts"
exec npx tsx "ts/validate-jupiter-launch.ts" "$@"
