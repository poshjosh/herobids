#!/usr/bin/env bash
# agent-matrix-evaluation.sh — Full lifecycle: setup → create → run → evaluate → shutdown.
#
# Creates a 2×2 matrix of agents testing:
#   - scanner_gated vs pure intelligence
#   - ICT skills (bullish + bearish swing) vs no skills
#
# Pipeline:
#   1. Setup    — reset-and-run.sh (teardown, rebuild, seed admin, provision venue credentials)
#   2. Create   — tsx scripts/ts/agent-matrix-evaluation.ts (ICT skills + 4 agents)
#   3. Run      — agents start automatically within step 2 and run for EVAL_DURATION_MIN
#   4. Stop     — agents stop automatically at end of step 2
#   5. Evaluate — download-eval-reports.sh (trigger evaluations, download reports)
#   6. Shutdown — shutdown.sh (tear down stack)
#
# Usage:
#   scripts/shell/ops/agent-matrix-evaluation.sh
#   scripts/shell/ops/agent-matrix-evaluation.sh --duration 120   # 2 hours
#   scripts/shell/ops/agent-matrix-evaluation.sh --mode paper     # paper trading
#   scripts/shell/ops/agent-matrix-evaluation.sh --skip-setup     # skip reset-and-run
#   scripts/shell/ops/agent-matrix-evaluation.sh --skip-shutdown  # leave stack running
#   scripts/shell/ops/agent-matrix-evaluation.sh --help
#
# Prerequisites:
#   - .env.ops.dev must exist with valid credentials
#   - Docker must be running
#   - Ollama must be installed (for local LLM inference)
#
# Exit codes:
#   0  All steps completed successfully
#   1  Fatal error in any step

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

EVAL_DURATION_MIN=60
EXECUTION_MODE="shadow"
SKIP_SETUP=0
SKIP_SHUTDOWN=0
DRY_RUN=0

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()    { echo "[$(date '+%H:%M:%S')] $*"; }
ok()     { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn()   { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()    { echo "[$(date '+%H:%M:%S')]  ✗ FATAL: $*" >&2; exit 1; }
banner() { echo; echo "============================================================"; echo "  $*"; echo "============================================================"; echo; }

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --duration MINUTES   How long agents run before stopping (default: 60)
  --mode MODE          Execution mode: paper | shadow | live (default: shadow)
  --skip-setup         Skip reset-and-run.sh (stack already provisioned)
  --skip-shutdown      Leave stack running after evaluation
  --dry-run            Print config without running
  --help               Show this message

Examples:
  $(basename "$0")
  $(basename "$0") --duration 120 --mode paper
  $(basename "$0") --skip-setup --skip-shutdown
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration)
      EVAL_DURATION_MIN="$2"
      shift 2
      ;;
    --mode)
      EXECUTION_MODE="$2"
      shift 2
      ;;
    --skip-setup)
      SKIP_SETUP=1
      shift
      ;;
    --skip-shutdown)
      SKIP_SHUTDOWN=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------

if [[ "$EXECUTION_MODE" != "paper" && "$EXECUTION_MODE" != "shadow" && "$EXECUTION_MODE" != "live" ]]; then
  die "Invalid execution mode: $EXECUTION_MODE (must be: paper | shadow | live)"
fi

if ! [[ "$EVAL_DURATION_MIN" =~ ^[0-9]+$ ]] || [[ "$EVAL_DURATION_MIN" -lt 1 ]]; then
  die "Invalid duration: $EVAL_DURATION_MIN (must be a positive integer)"
fi

# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  banner "Agent Matrix Evaluation — DRY RUN"
  echo "  EVAL_DURATION_MIN  = $EVAL_DURATION_MIN"
  echo "  EXECUTION_MODE     = $EXECUTION_MODE"
  echo "  SKIP_SETUP         = $SKIP_SETUP"
  echo "  SKIP_SHUTDOWN      = $SKIP_SHUTDOWN"
  echo "  ENV_FILE           = $ENV_FILE"
  echo "  REPO_ROOT          = $REPO_ROOT"
  echo ""
  echo "Would run:"
  if [[ "$SKIP_SETUP" -eq 0 ]]; then
    echo "  1. $SCRIPT_DIR/../run/reset-and-run.sh"
  fi
  echo "  2. EVAL_DURATION_MIN=$EVAL_DURATION_MIN EXECUTION_MODE=$EXECUTION_MODE tsx $REPO_ROOT/scripts/ts/agent-matrix-evaluation.ts"
  echo "  3. HEROBIDS_ENV=dev $SCRIPT_DIR/download-eval-reports.sh"
  if [[ "$SKIP_SHUTDOWN" -eq 0 ]]; then
    echo "  4. $SCRIPT_DIR/../run/shutdown.sh"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Load env
# ---------------------------------------------------------------------------

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
else
  warn "Env file not found: $ENV_FILE — using defaults"
fi

# Export env vars for the TypeScript script
export EVAL_DURATION_MIN
export EXECUTION_MODE
export API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
export TEST_EMAIL="${TEST_EMAIL:-trade-test@local.test}"
export TEST_PASSWORD="${TEST_PASSWORD:-TradeTest123!}"
export ADMIN_EMAIL="${ADMIN_EMAIL:-admin@herobids.local}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-AdminTest123!}"
export LLM_PROVIDER="${LLM_PROVIDER:-ollama}"
export LLM_HEAVY_MODEL="${LLM_HEAVY_MODEL:-qwen3.6:35b-a3b-q4_K_M}"

# ---------------------------------------------------------------------------
# Step 1 — Setup
# ---------------------------------------------------------------------------

if [[ "$SKIP_SETUP" -eq 1 ]]; then
  banner "Step 1: Setup — SKIPPED (--skip-setup)"
else
  banner "Step 1: Setup — reset-and-run.sh"
  log "Tearing down, rebuilding, seeding admin, provisioning venue credentials..."
  bash "$SCRIPT_DIR/../run/reset-and-run.sh" || die "reset-and-run.sh failed"
  ok "Setup complete"
fi

# ---------------------------------------------------------------------------
# Step 2 — Create + Run + Stop agents
# ---------------------------------------------------------------------------

banner "Step 2: Agent Matrix Evaluation — create, run (${EVAL_DURATION_MIN}min), stop"

log "Running agent-matrix-evaluation.ts..."
npx tsx "$REPO_ROOT/scripts/ts/agent-matrix-evaluation.ts" || die "agent-matrix-evaluation.ts failed"

ok "Agent matrix evaluation complete"

# ---------------------------------------------------------------------------
# Step 3 — Evaluate
# ---------------------------------------------------------------------------

banner "Step 3: Evaluate — download-eval-reports.sh"

log "Triggering evaluations and downloading reports..."
HEROBIDS_ENV=dev bash "$SCRIPT_DIR/download-eval-reports.sh" || {
  warn "download-eval-reports.sh exited with non-zero status — some evaluations may have failed"
}

ok "Evaluation reports downloaded"

# ---------------------------------------------------------------------------
# Step 4 — Shutdown
# ---------------------------------------------------------------------------

if [[ "$SKIP_SHUTDOWN" -eq 1 ]]; then
  banner "Step 4: Shutdown — SKIPPED (--skip-shutdown)"
  log "Stack left running. Shut down manually with: scripts/shell/run/shutdown.sh"
else
  banner "Step 4: Shutdown — shutdown.sh"
  log "Tearing down stack..."
  bash "$SCRIPT_DIR/../run/shutdown.sh" || warn "shutdown.sh exited with non-zero status"
  ok "Stack shut down"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

banner "Agent Matrix Evaluation — COMPLETE"
log "Evaluation reports: .ignore/eval/$(date '+%Y/%m/%d')/"
