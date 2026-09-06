#!/usr/bin/env bash
# preset-review-gap-closure-test.sh — Shell wrapper for scripts/ts/preset-review-gap-closure-test.ts
#
# Validates the preset-review gap closure implementation from
# docs/features/2026/07/30/001-preset-review-gap-closure/001-plan.md.
#
# Scenarios:
#   R1  Hybrid agent review_advice.active_preset matches metadata.strategyPreset
#   R2  Intelligence agent POST forced-review returns 403 capability_mode_unsupported
#   R3  Intelligence agent eligibility reports canTrigger=false with capability reason
#   R4  Intelligence agent accumulates no review_advice rows after scheduler run
#   R5  Hybrid agent review_advice rows appear (scheduler is active)
#
# Usage:
#   scripts/shell/tests/preset-review-gap-closure-test.sh
#   scripts/shell/tests/preset-review-gap-closure-test.sh --scenario R1,R2
#   scripts/shell/tests/preset-review-gap-closure-test.sh --env /path/to/custom.env
#
# Stack lifecycle:
#   - If API is not reachable, starts the stack (postgres + redis + api + worker)
#     when DOCKER_COMPOSE_UP=1.
#   - Stops the stack on exit if it was started by this script and
#     DOCKER_COMPOSE_DOWN=1.
#   - Pre-existing services are left untouched.
#
# Requires:
#   - tsx or pnpm available
#   - API and DB reachable (or DOCKER_COMPOSE_UP=1)
#   - Worker running with agent runtime support
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # fill in TEST_EMAIL, TEST_PASSWORD, HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS
#   chmod +x scripts/shell/tests/preset-review-gap-closure-test.sh
#   scripts/shell/tests/preset-review-gap-closure-test.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()  { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

SCENARIOS="${SCENARIOS:-R1,R2,R3,R4,R5}"
SCHEDULER_WAIT_MS="${SCHEDULER_WAIT_MS:-45000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --scenario)
      SCENARIOS="$2"
      shift 2
      ;;
    --scheduler-wait)
      SCHEDULER_WAIT_MS="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Load env file
# CLI-provided env vars take precedence over values in the env file.
# ---------------------------------------------------------------------------

_PRE_DOCKER_COMPOSE_UP_SET="${DOCKER_COMPOSE_UP+1}"
_PRE_DOCKER_COMPOSE_UP_VAL="${DOCKER_COMPOSE_UP:-}"
_PRE_DOCKER_COMPOSE_DOWN_SET="${DOCKER_COMPOSE_DOWN+1}"
_PRE_DOCKER_COMPOSE_DOWN_VAL="${DOCKER_COMPOSE_DOWN:-}"

if [[ -f "$ENV_FILE" ]]; then
  log "Loading env from $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  warn "Env file not found: $ENV_FILE"
  warn "Continuing with environment variables already set in the shell."
fi

# Restore CLI overrides so they take precedence over env file values
[[ "$_PRE_DOCKER_COMPOSE_UP_SET"   == "1" ]] && export DOCKER_COMPOSE_UP="$_PRE_DOCKER_COMPOSE_UP_VAL"
[[ "$_PRE_DOCKER_COMPOSE_DOWN_SET" == "1" ]] && export DOCKER_COMPOSE_DOWN="$_PRE_DOCKER_COMPOSE_DOWN_VAL"
unset _PRE_DOCKER_COMPOSE_UP_SET _PRE_DOCKER_COMPOSE_UP_VAL \
      _PRE_DOCKER_COMPOSE_DOWN_SET _PRE_DOCKER_COMPOSE_DOWN_VAL

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

: "${API_BASE_URL:=http://localhost:3000}"
: "${TEST_EMAIL:=trade-test@local.test}"
: "${TEST_PASSWORD:=TradeTest123!}"
: "${VENUE:=hyperliquid}"
: "${EXECUTION_MODE:=paper}"
: "${LLM_PROVIDER:=ollama}"
: "${LLM_LIGHT_MODEL:=qwen3:8b}"
: "${LLM_HEAVY_MODEL:=qwen3.6:35b-a3b-q4_K_M}"
: "${DOCKER_COMPOSE_UP:=0}"
: "${DOCKER_COMPOSE_DOWN:=0}"

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if ! command -v tsx &>/dev/null && ! command -v pnpm &>/dev/null; then
  die "Neither tsx nor pnpm found. Install pnpm (https://pnpm.io) or tsx (npm i -g tsx)."
fi

if ! command -v docker &>/dev/null; then
  die "docker is required but not found."
fi

# ---------------------------------------------------------------------------
# Auto-start stack if needed
# ---------------------------------------------------------------------------

stackStartedByUs=0

check_api_health() {
  curl -sf -o /dev/null "${API_BASE_URL}/health" 2>/dev/null || return 1
}

if ! check_api_health; then
  if [[ "$DOCKER_COMPOSE_UP" != "1" ]]; then
    die "API at ${API_BASE_URL} is not reachable. Start the stack or re-run with DOCKER_COMPOSE_UP=1."
  fi
  log "API not reachable — starting Docker stack..."
  docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d --build
  stackStartedByUs=1

  # Wait up to 90 s for API + worker
  deadline=$(($(date +%s) + 90))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 3
    if check_api_health; then
      ok "API is now healthy"
      break
    fi
    log "Waiting for API..."
  done
  if ! check_api_health; then
    die "API did not become healthy within 90 s"
  fi
fi

ok "API reachable at ${API_BASE_URL}"

# ---------------------------------------------------------------------------
# Cleanup on exit (stop stack if we started it)
# ---------------------------------------------------------------------------

cleanup() {
  local exit_code=$?
  if [[ "$DOCKER_COMPOSE_DOWN" == "1" && "$stackStartedByUs" == "1" ]]; then
    log "Stopping Docker stack (started by this script)..."
    docker compose -f docker-compose.yaml -f docker-compose.dev.yaml down
    ok "Docker stack stopped"
  fi
  exit $exit_code
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Run the test
# ---------------------------------------------------------------------------

log ""
log "=== Preset Review Gap Closure E2E Test ==="
log "  API: $API_BASE_URL"
log "  Email: $TEST_EMAIL"
log "  Venue: $VENUE"
log "  Scenarios: $SCENARIOS"
log "  Scheduler wait: ${SCHEDULER_WAIT_MS}ms"
log ""

TS_FILE="$REPO_ROOT/scripts/ts/preset-review-gap-closure-test.ts"

if [[ ! -f "$TS_FILE" ]]; then
  die "Test script not found: $TS_FILE"
fi

# ── Pre-check: Ollama readiness (not just reachability) ──────────────────────
# The review scheduler tests need agents to reach 'active' and reason via the
# LLM within tight deadlines. A reachable-but-cold Ollama (models not pulled,
# or pulled but not loaded into memory) blows those deadlines and the test
# fails spuriously. Gate on three things and self-skip (exit 0) otherwise:
#   1. /api/tags reachable (server up)
#   2. the configured light + heavy models are present in /api/tags
#   3. a warmup /api/generate on the light model responds within a deadline
#      (proves responsiveness AND loads the model into memory)
if [[ "${LLM_PROVIDER:-}" == "ollama" ]]; then
  ollama_skip() {
    warn "Skipping preset review gap closure test — $1"
    warn "Start Ollama and ensure models (${LLM_LIGHT_MODEL:-qwen3:8b}, ${LLM_HEAVY_MODEL:-qwen3.6:35b-a3b-q4_K_M}) are pulled and warm."
    exit 0
  }

  OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
  OLLAMA_WARMUP_TIMEOUT_S="${OLLAMA_WARMUP_TIMEOUT_S:-45}"

  # 1. reachable
  TAGS_JSON=$(curl -s --max-time 5 "${OLLAMA_URL}/api/tags" 2>/dev/null || echo "")
  if [[ -z "${TAGS_JSON}" ]]; then
    ollama_skip "Ollama not reachable at ${OLLAMA_URL} (/api/tags)."
  fi

  # 2. required models present (match by name, tolerant of exact tag)
  for _m in "${LLM_LIGHT_MODEL:-qwen3:8b}" "${LLM_HEAVY_MODEL:-qwen3.6:35b-a3b-q4_K_M}"; do
    if ! echo "${TAGS_JSON}" | grep -qF "\"${_m}\""; then
      ollama_skip "required model '${_m}' not present in Ollama /api/tags."
    fi
  done

  # 3. responsive: a trivial generate on the light model within the deadline.
  WARMUP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time "${OLLAMA_WARMUP_TIMEOUT_S}" \
    "${OLLAMA_URL}/api/generate" \
    -d "{\"model\":\"${LLM_LIGHT_MODEL:-qwen3:8b}\",\"prompt\":\"ok\",\"stream\":false,\"options\":{\"num_predict\":1}}" \
    2>/dev/null || echo "000")
  if [[ "${WARMUP_CODE}" != "200" ]]; then
    ollama_skip "Ollama did not answer a warmup generate within ${OLLAMA_WARMUP_TIMEOUT_S}s (HTTP ${WARMUP_CODE}) — reachable but not responsive."
  fi
fi

export SCENARIOS SCHEDULER_WAIT_MS API_BASE_URL TEST_EMAIL TEST_PASSWORD VENUE EXECUTION_MODE
export LLM_PROVIDER LLM_LIGHT_MODEL LLM_HEAVY_MODEL
export HL_API_KEY HL_SECRET HL_WALLET_ADDRESS BYBIT_API_KEY BYBIT_SECRET
export ONEINCH_API_KEY ONEINCH_PRIVATE_KEY

if command -v tsx &>/dev/null; then
  tsx "$TS_FILE"
elif command -v pnpm &>/dev/null; then
  pnpm exec tsx "$TS_FILE"
else
  die "Neither tsx nor pnpm available"
fi
