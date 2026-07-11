#!/usr/bin/env bash
# cost-benchmark.sh — Shell wrapper for scripts/ts/cost-benchmark.ts
#
# Compares LLM token usage across hybrid modes (intelligence vs scanner_gated)
# and reasoning levels (none/low/medium/high) by running agents simultaneously
# for a fixed duration and aggregating token counts from their activity feeds.
#
# Usage:
#   scripts/shell/ops/cost-benchmark.sh
#   scripts/shell/ops/cost-benchmark.sh --duration 10     # 10 minutes
#   scripts/shell/ops/cost-benchmark.sh --tick 15          # 15s tick interval
#   scripts/shell/ops/cost-benchmark.sh --skip-teardown    # leave agents running
#   scripts/shell/ops/cost-benchmark.sh --help
#
# Setup:
#   chmod +x scripts/shell/ops/cost-benchmark.sh
#   scripts/shell/ops/cost-benchmark.sh
#
# ─────────────────────────────────────────────────────────────────
# Variables (can be set in .env.ops.dev or as env vars)
# ─────────────────────────────────────────────────────────────────
#
#   API_BASE_URL          Default: http://localhost:3000
#   TEST_EMAIL            Default: trade-test@local.test
#   TEST_PASSWORD         Default: TradeTest123!
#   LLM_PROVIDER          Default: ollama
#   LLM_LIGHT_MODEL       Default: qwen3:8b
#   LLM_HEAVY_MODEL       Default: qwen3.6:35b-a3b-q4_K_M
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"
DRY_RUN=0

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()  { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --duration MINUTES   Benchmark duration in minutes (default: 5)
  --tick SECONDS       Tick interval in seconds (default: 30)
  --skip-teardown      Leave agents running after benchmark
  --env FILE           Path to env file (default: .env.ops.dev)
  --dry-run            Print config without running
  --help               Show this message

Examples:
  $(basename "$0")
  $(basename "$0") --duration 10 --tick 15
  $(basename "$0") --duration 3 --skip-teardown
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

DURATION_MIN=5
TICK_SEC=30
SKIP_TEARDOWN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION_MIN="$2"; shift 2 ;;
    --tick)     TICK_SEC="$2";      shift 2 ;;
    --skip-teardown) SKIP_TEARDOWN="1"; shift ;;
    --env)      ENV_FILE="$2";      shift 2 ;;
    --dry-run)  DRY_RUN=1;          shift ;;
    --help)     usage ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Load env file (skip if missing — user may use shell env vars directly)
# ---------------------------------------------------------------------------

if [ -f "$ENV_FILE" ]; then
  log "Loading env: $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
else
  warn "Env file not found: $ENV_FILE — using shell environment / defaults"
fi

# ---------------------------------------------------------------------------
# Resolve config
# ---------------------------------------------------------------------------

export API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
export TEST_EMAIL="${TEST_EMAIL:-trade-test@local.test}"
export TEST_PASSWORD="${TEST_PASSWORD:-TradeTest123!}"
export LLM_PROVIDER="${LLM_PROVIDER:-ollama}"
export LLM_LIGHT_MODEL="${LLM_LIGHT_MODEL:-qwen3:8b}"
export LLM_HEAVY_MODEL="${LLM_HEAVY_MODEL:-qwen3.6:35b-a3b-q4_K_M}"
export TICK_INTERVAL_MS=$((TICK_SEC * 1000))
export BENCHMARK_DURATION_MS=$((DURATION_MIN * 60 * 1000))
export SKIP_TEARDOWN="${SKIP_TEARDOWN:-}"

# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "  API_BASE_URL         = $API_BASE_URL"
  echo "  TEST_EMAIL           = $TEST_EMAIL"
  echo "  LLM_PROVIDER         = $LLM_PROVIDER"
  echo "  LLM_LIGHT_MODEL      = $LLM_LIGHT_MODEL"
  echo "  LLM_HEAVY_MODEL      = $LLM_HEAVY_MODEL"
  echo "  TICK_INTERVAL_MS     = $TICK_INTERVAL_MS"
  echo "  BENCHMARK_DURATION_MS = $BENCHMARK_DURATION_MS"
  echo "  SKIP_TEARDOWN        = ${SKIP_TEARDOWN:-0}"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

log "Cost Benchmark — ${DURATION_MIN}min, ${TICK_SEC}s ticks, ${LLM_PROVIDER}/${LLM_LIGHT_MODEL}"
log "API: $API_BASE_URL"

cd "$REPO_ROOT"
exec pnpm tsx scripts/ts/cost-benchmark.ts
