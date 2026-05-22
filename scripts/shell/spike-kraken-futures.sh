#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# spike-kraken-futures.sh
#
# Validates that ccxt can connect to Kraken Futures (demo/sandbox) and perform
# core derivatives operations: fetch markets, set leverage, place a short order,
# query positions/balance, and cancel the order.
#
# Prerequisites:
#   1. Create a Kraken Futures demo account: https://demo-futures.kraken.com
#   2. Generate API key + secret from the demo account (free, no KYC)
#   3. Set environment variables:
#        export KRAKEN_FUTURES_KEY="your-demo-key"
#        export KRAKEN_FUTURES_SECRET="your-demo-secret"
#
# Usage:
#   ./scripts/shell/spike-kraken-futures.sh
#
# What success looks like:
#   - All steps complete without errors
#   - You see perpetual markets, balance, order ID, and position data
#
# What failure means:
#   - ccxt's Kraken Futures adapter is incomplete or broken for derivatives
#   - May need to fall back to Kraken's native API or a different first venue
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Validate required env vars
if [[ -z "${KRAKEN_FUTURES_KEY:-}" || -z "${KRAKEN_FUTURES_SECRET:-}" ]]; then
  echo "Error: KRAKEN_FUTURES_KEY and KRAKEN_FUTURES_SECRET must be set."
  echo ""
  echo "  export KRAKEN_FUTURES_KEY=\"your-demo-key\""
  echo "  export KRAKEN_FUTURES_SECRET=\"your-demo-secret\""
  echo ""
  echo "Get demo credentials at: https://demo-futures.kraken.com"
  exit 1
fi

echo "Running ccxt + Kraken Futures spike (sandbox mode)..."
echo ""

cd "$ROOT_DIR"
npx tsx scripts/spike-kraken-futures.ts
