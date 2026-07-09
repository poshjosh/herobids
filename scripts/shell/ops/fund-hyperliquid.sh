#!/usr/bin/env bash
# fund-hyperliquid.sh — Load scripts/.env then run the fund-hyperliquid TypeScript script.
#
# Usage:
#   scripts/shell/ops/fund-hyperliquid.sh            # interactive (asks to confirm each tx)
#   scripts/shell/ops/fund-hyperliquid.sh --dry-run  # simulate — no transactions sent
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # edit .env.ops.dev with your BASE_WALLET_PRIVATE_KEY, HL_WALLET_ADDRESS, AMOUNT_USDC
#   chmod +x scripts/shell/ops/fund-hyperliquid.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  echo "  cp .env.ops.dev.example .env.ops.dev"
  echo "  # then fill in BASE_WALLET_PRIVATE_KEY, HYPERLIQUID_ACCOUNT_ADDRESS, AMOUNT_USDC"
  exit 1
fi

# Export each non-comment, non-blank line from .env
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# ---------------------------------------------------------------------------
# Basic validation before invoking the script
# ---------------------------------------------------------------------------
missing=0
for var in BASE_WALLET_PRIVATE_KEY HL_WALLET_ADDRESS AMOUNT_USDC; do
  if [[ -z "${!var:-}" ]]; then
    echo "Error: $var is not set in .env.ops.dev"
    missing=1
  fi
done
if [[ "$missing" -eq 1 ]]; then exit 1; fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
exec pnpm --filter @herobids/scripts exec tsx ts/fund-hyperliquid.ts "$@"
