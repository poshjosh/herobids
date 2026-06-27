#!/usr/bin/env bash
# bot-trade-test.sh — Shell wrapper for scripts/ts/bot-trade-test.ts
#
# Loads credentials from an env file (default: scripts/.env.trade-test),
# validates required vars are present, then runs the TypeScript bot lifecycle test.
#
# Usage:
#   scripts/shell/tests/bot-trade-test.sh
#   scripts/shell/tests/bot-trade-test.sh --env /path/to/custom.env
#   scripts/shell/tests/bot-trade-test.sh --dry-run
#   scripts/shell/tests/bot-trade-test.sh --help
#
# Setup:
#   cp scripts/.env.trade-test.example scripts/.env.trade-test
#   # fill in your credentials, then:
#   chmod +x scripts/shell/tests/bot-trade-test.sh
#   scripts/shell/tests/bot-trade-test.sh
#
# ─────────────────────────────────────────────────────────────────
# Variables in .env.trade-test
# ─────────────────────────────────────────────────────────────────
#
# Required
#   API_BASE_URL          Base URL of the HeroBids API
#                         Default: http://localhost:3000
#
#   TEST_EMAIL            Test user email
#                         Default: trade-test@local.test
#   TEST_PASSWORD         Password (≥ 8 characters)
#                         Default: TradeTest123!
#
#   VENUE                 hyperliquid (default) | bybit | 1inch
#
#   Hyperliquid secrets   (required when VENUE=hyperliquid)
#     HL_API_KEY
#     HL_SECRET
#     HL_WALLET_ADDRESS   EVM address: 0x + 40 hex chars
#
# Optional
#   EXECUTION_MODE        paper (default) | shadow | live
#   TICK_INTERVAL_MS      Tick interval in ms. Default: 60000 (1 min)
#   TIMEOUT_MS            Total timeout in ms. Default: 600000 (10 min)
#   DOCKER_COMPOSE_UP     1 to auto-start Docker stack
#   DOCKER_COMPOSE_DOWN   1 to stop Docker stack on exit
#   SKIP_TEARDOWN         1 to leave bot running

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE=""

# ── Parse flags ────────────────────────────────────────────────────────

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--env <path>] [--dry-run] [--help]"
      echo ""
      echo "Shell wrapper for scripts/ts/bot-trade-test.ts"
      echo ""
      echo "  --env <path>   Path to env file (default: scripts/.env.trade-test)"
      echo "  --dry-run      Print env vars without running"
      echo "  --help         Show this help"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1"
      exit 1
      ;;
  esac
done

# ── Load env file ──────────────────────────────────────────────────────

if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="$REPO_ROOT/scripts/.env.trade-test"
fi

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  echo "[bot-trade-test] Loaded env from $ENV_FILE"
else
  echo "[bot-trade-test] No env file at $ENV_FILE — using process env vars"
fi

# ── Set defaults ───────────────────────────────────────────────────────

export API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
export TEST_EMAIL="${TEST_EMAIL:-trade-test@local.test}"
export TEST_PASSWORD="${TEST_PASSWORD:-TradeTest123!}"
export VENUE="${VENUE:-hyperliquid}"
export EXECUTION_MODE="${EXECUTION_MODE:-paper}"
export TICK_INTERVAL_MS="${TICK_INTERVAL_MS:-60000}"
export TIMEOUT_MS="${TIMEOUT_MS:-600000}"
export DOCKER_COMPOSE_UP="${DOCKER_COMPOSE_UP:-0}"
export DOCKER_COMPOSE_DOWN="${DOCKER_COMPOSE_DOWN:-0}"
export SKIP_TEARDOWN="${SKIP_TEARDOWN:-0}"

# ── Validate required vars ─────────────────────────────────────────────

MISSING=()
for VAR in TEST_EMAIL TEST_PASSWORD; do
  if [[ -z "${!VAR:-}" ]]; then
    MISSING+=("$VAR")
  fi
done

if [[ "${VENUE:-}" == "hyperliquid" ]]; then
  for VAR in HL_API_KEY HL_SECRET HL_WALLET_ADDRESS; do
    if [[ -z "${!VAR:-}" ]]; then
      MISSING+=("$VAR")
    fi
  done
elif [[ "${VENUE:-}" == "bybit" ]]; then
  for VAR in BYBIT_API_KEY BYBIT_SECRET; do
    if [[ -z "${!VAR:-}" ]]; then
      MISSING+=("$VAR")
    fi
  done
elif [[ "${VENUE:-}" == "1inch" ]]; then
  for VAR in ONEINCH_API_KEY ONEINCH_PRIVATE_KEY; do
    if [[ -z "${!VAR:-}" ]]; then
      MISSING+=("$VAR")
    fi
  done
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "[bot-trade-test] ERROR: Missing required env vars: ${MISSING[*]}"
  echo "[bot-trade-test] Set them in $ENV_FILE or export them."
  exit 1
fi

# ── Dry run ────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[bot-trade-test] Dry run — would execute with:"
  echo "  API_BASE_URL=$API_BASE_URL"
  echo "  TEST_EMAIL=$TEST_EMAIL"
  echo "  VENUE=$VENUE"
  echo "  EXECUTION_MODE=$EXECUTION_MODE"
  echo "  TICK_INTERVAL_MS=$TICK_INTERVAL_MS"
  echo "  TIMEOUT_MS=$TIMEOUT_MS"
  exit 0
fi

# ── Run the TypeScript test ────────────────────────────────────────────

echo "[bot-trade-test] Running bot-trade-test.ts..."
cd "$REPO_ROOT"
exec npx tsx scripts/ts/bot-trade-test.ts
