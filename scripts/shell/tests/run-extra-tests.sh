#!/usr/bin/env bash
# run-extra-tests.sh — Run test scripts NOT covered by run-all-tests.sh
#
# This script runs the 11 test scripts that live in scripts/shell/tests/ but
# are NOT invoked by run-all-tests.sh.  The 3 venue-validation scripts
# (validate-1inch.sh, validate-jupiter.sh, validate-swap-venue.sh) are
# excluded by design — they require operator-managed API keys and hit live
# venue endpoints.
#
# ── Known skips (tests that self-skip in dev) ────────────────────────────────
#
# billing-webhook-smoke       Tier 3  Requires BILLING_PRIMARY_PROVIDER=creem.
#                                     Default dev config uses 'mock' provider.
#                                     Set in config/{staging,production}.yaml.
#
# agent-trade-test            Tier 5  Requires Ollama LLM models pulled AND warm.
# preset-review-gap-closure   Tier 5  These tests need the agent runtime to
#                                     reason via LLM within tight deadlines. A
#                                     reachable-but-cold Ollama (models absent,
#                                     or pulled but not loaded) blows those
#                                     deadlines and fails spuriously.
#                                     Pre-check (readiness, not just reachable):
#                                       1. /api/tags reachable
#                                       2. light + heavy models present
#                                       3. warmup /api/generate answers within
#                                          OLLAMA_WARMUP_TIMEOUT_S (default 45s)
#                                     If any fails → the test self-skips (exit 0).
#                                     Warm the stack via reset-and-run.sh.
#
# caddy-routing-smoke         Tier 6  Requires network access to CADDY_BASE_URL
#                                     (default: staging.openaidom.com).
#                                     Pre-check: curl to CADDY_BASE_URL/health.
#
# autoscale-smoke             Tier 6  Requires SSH to control plane and .env.backend.
#                                     Pre-check: .env.backend file exists.
#
# telegram-messaging          Tier 6  Requires TELEGRAM_WEBHOOK_URL set.
#                                     Webhook absence is a config choice; the
#                                     test treats it as informational (non-fatal).
#
# ── API validation known issue ───────────────────────────────────────────────
#
# resolveExecutionModeForSkills (agent-config-helpers.ts) only checks skillIds
# for trading capability, not capabilityMode. The CreateAgentSchema superRefine
# considers capabilityMode='hybrid' as trading-capable. This forces test
# payloads for hybrid agents to include BOTH executionDefaults AND
# skillIds:['trading'], even though skills are auto-resolved later in the
# handler flow. See .ignore/test-related-changes.md for details.
#
# Tiers (run in order; tiers 5-6 are opt-in):
#   1. No-stack              — pure vitest, no services required
#   2. Redis-only            — requires Redis (auto-started if needed)
#   3. API + DB              — requires API + Postgres
#   4. Full stack (no keys)  — requires API + worker + DB, no venue credentials
#   5. Full stack + venue    — requires full stack + Hyperliquid credentials
#   6. External infra        — tests remote endpoints (staging/prod, Telegram)
#
# Usage:
#   scripts/shell/tests/run-extra-tests.sh                 # tiers 1-4
#   scripts/shell/tests/run-extra-tests.sh --all           # all 6 tiers
#   scripts/shell/tests/run-extra-tests.sh --tier 1,2,3    # specific tiers
#   scripts/shell/tests/run-extra-tests.sh --skip-tier 5,6 # skip tiers
#   scripts/shell/tests/run-extra-tests.sh --env-file .env.ops.staging
#   scripts/shell/tests/run-extra-tests.sh --help
#
# Environment file:
#   Default: .env.ops.dev (at repo root).  Copy from .env.ops.dev.example.
#   Minimum required vars: API_BASE_URL, TEST_EMAIL, TEST_PASSWORD.
#   Tier 5 also needs: HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS.
#   Tier 6 also needs: TELEGRAM_BOT_TOKEN, TEST_CHAT_IDS (telegram),
#                      CADDY_BASE_URL (caddy, defaults to staging).
#
# Stack lifecycle:
#   - Postgres and Redis are started if not already healthy.
#   - API + worker are started for tiers 3-5 if not already healthy.
#   - Services started by this script are torn down on exit.
#   - Pre-existing services are left untouched.
#
# Requirements:
#   - docker (with compose plugin)
#   - pnpm (node >=22)
#   - curl, jq
#
# Exit codes:
#   0 — all selected test tiers passed
#   1 — one or more test tiers failed (or setup error)

set -euo pipefail

# ─── Resolve project root ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
COMPOSE_FILE="${ROOT}/docker-compose.yaml"

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; CYAN='\033[0;36m'; BLUE='\033[0;34m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; BLUE=''; RESET=''
fi

log()    { echo -e "${CYAN}[extra]${RESET} $*"; }
ok()     { echo -e "${GREEN}[extra]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[extra]${RESET} $*"; }
err()    { echo -e "${RED}[extra]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }
info()   { echo -e "${BLUE}[extra]${RESET} $*"; }

# ─── Argument parsing ────────────────────────────────────────────────────────

ENV_FILE="${ROOT}/.env.ops.dev"
SELECTED_TIERS=()         # empty = run default tiers (1-4)
SKIP_TIERS=()
RUN_ALL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --tier)
      IFS=',' read -ra SELECTED_TIERS <<< "$2"
      shift 2
      ;;
    --skip-tier)
      IFS=',' read -ra SKIP_TIERS <<< "$2"
      shift 2
      ;;
    --all)
      RUN_ALL=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      err "Unknown argument: $1  (use --help for usage)"
      exit 1
      ;;
  esac
done

# ─── Determine which tiers to run ────────────────────────────────────────────

if ${RUN_ALL}; then
  SELECTED_TIERS=(1 2 3 4 5 6)
elif [[ ${#SELECTED_TIERS[@]} -eq 0 ]]; then
  SELECTED_TIERS=(1 2 3 4)  # default: safe tiers only
fi

# Filter out skipped tiers
if [[ ${#SKIP_TIERS[@]} -gt 0 ]]; then
  FILTERED=()
  for t in "${SELECTED_TIERS[@]}"; do
    skip=false
    for s in "${SKIP_TIERS[@]}"; do
      [[ "$t" == "$s" ]] && skip=true && break
    done
    $skip || FILTERED+=("$t")
  done
  SELECTED_TIERS=("${FILTERED[@]}")
fi

# tier_enabled: check if a tier number is in SELECTED_TIERS (bash 3.x compat)
tier_enabled() {
  local target="$1"
  for t in "${SELECTED_TIERS[@]}"; do
    [[ "$t" == "$target" ]] && return 0
  done
  return 1
}

# ─── State tracking ──────────────────────────────────────────────────────────

INFRA_STARTED=false       # true if this script started postgres+redis
STACK_STARTED=false       # true if this script started api+worker
TESTS_DIR="${SCRIPT_DIR}"

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  echo ""
  if [[ "${STACK_STARTED}" == "true" ]]; then
    warn "Tearing down api + worker (started by this script)…"
    docker compose -f "${COMPOSE_FILE}" stop api worker 2>/dev/null || true
    docker compose -f "${COMPOSE_FILE}" rm -f api worker 2>/dev/null || true
  fi
  if [[ "${INFRA_STARTED}" == "true" ]]; then
    warn "Tearing down postgres + redis (started by this script)…"
    docker compose -f "${COMPOSE_FILE}" stop postgres redis 2>/dev/null || true
    docker compose -f "${COMPOSE_FILE}" rm -f postgres redis 2>/dev/null || true
  fi
  if [[ $exit_code -eq 0 ]]; then
    ok "All done."
  else
    err "Test run failed (exit ${exit_code})."
  fi
  exit $exit_code
}
trap cleanup EXIT

# ─── Dry-run: print plan and exit early (no infrastructure touched) ─────────

if [[ "${DRY_RUN}" == "true" ]]; then
  header "Dry-run plan"

  echo ""
  echo -e "${BOLD}Tiers selected:${RESET} ${SELECTED_TIERS[*]}"
  echo ""

  tier_enabled 1 && echo -e "  ${BLUE}Tier 1${RESET} (no-stack)           → agent-bot-e2e-test.sh"
  tier_enabled 2 && echo -e "  ${BLUE}Tier 2${RESET} (redis-only)         → agent-watch-invariants.sh --smoke"
  tier_enabled 3 && echo -e "  ${BLUE}Tier 3${RESET} (api+db)             → agent-config-matrix-test.sh"
  tier_enabled 3 && echo -e "                                          → agent-config-persistence-test.sh"
  tier_enabled 3 && echo -e "                                          → billing-webhook-smoke-test.sh"
  tier_enabled 4 && echo -e "  ${BLUE}Tier 4${RESET} (full stack, no keys) → agent-document-handling-test.sh"
  tier_enabled 4 && echo -e "                                          → agent-scanner-gated-lifecycle-test.sh"
  tier_enabled 4 && echo -e "                                          → browser-pool-agent-browser-smoke-test.sh"
  tier_enabled 4 && echo -e "                                          → sandbox-allowlist-smoke-test.sh"
  tier_enabled 5 && echo -e "  ${BLUE}Tier 5${RESET} (full stack + venue)  → agent-trade-test.sh"
  tier_enabled 5 && echo -e "                                          → bot-trade-test.sh"
  tier_enabled 5 && echo -e "                                          → platform-preset-assessment-test.sh"
  tier_enabled 5 && echo -e "                                          → preset-review-gap-closure-test.sh"
  tier_enabled 5 && echo -e "                                          → scanner-provider-smoke-test.sh"
  tier_enabled 6 && echo -e "  ${BLUE}Tier 6${RESET} (external infra)     → autoscale-smoke-test.sh"
  tier_enabled 6 && echo -e "                                          → autoscale-capacity-trigger-test.sh (AUTOSCALE_DESTRUCTIVE=true)"
  tier_enabled 6 && echo -e "                                          → caddy-routing-smoke-test.sh"
  tier_enabled 6 && echo -e "                                          → test-telegram-messaging.sh"

  echo ""
  echo -e "${BOLD}Env file:${RESET} ${ENV_FILE}"
  if [[ -f "${ENV_FILE}" ]]; then
    echo -e "${BOLD}API_BASE_URL:${RESET} ${API_BASE_URL:-http://localhost:3000}"
  else
    echo -e "  ${YELLOW}(not found — will use process environment)${RESET}"
  fi

  echo ""
  if tier_enabled 5; then
    echo -e "${YELLOW}⚠  Tier 5 requires Hyperliquid credentials (HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS)${RESET}"
  fi
  if tier_enabled 6; then
    echo -e "${YELLOW}⚠  Tier 6 requires TELEGRAM_BOT_TOKEN, TEST_CHAT_IDS, network access to CADDY_BASE_URL,${RESET}"
    echo -e "${YELLOW}   and BACKEND_ENV_FILE (autoscale tests)${RESET}"
  fi

  echo ""
  ok "Dry-run complete (no tests executed, no services started)."
  exit 0
fi

# ─── Helper: check if a compose service is healthy ───────────────────────────

service_healthy() {
  local service="$1"
  local state
  state=$(docker compose -f "${COMPOSE_FILE}" ps --format json "$service" 2>/dev/null \
    | grep -o '"Health":"[^"]*"' | head -1 | cut -d'"' -f4)
  [[ "$state" == "healthy" ]]
}

# ─── Helper: wait for a service to become healthy ────────────────────────────

wait_healthy() {
  local service="$1"
  local retries=30
  log "Waiting for ${service} to be healthy…"
  while [[ $retries -gt 0 ]]; do
    if service_healthy "$service"; then
      ok "${service} is healthy."
      return 0
    fi
    sleep 2
    (( retries-- ))
  done
  err "${service} did not become healthy in time."
  return 1
}

# ─── Helper: check if API is reachable ───────────────────────────────────────

api_healthy() {
  curl -sf -o /dev/null "${API_BASE_URL:-http://localhost:3000}/health" 2>/dev/null || return 1
}

# ─── Results tracking ────────────────────────────────────────────────────────

declare -a RESULTS=()
OVERALL_EXIT=0

run_tier() {
  local label="$1"
  shift
  header "${label}"
  if "$@"; then
    RESULTS+=("${GREEN}PASS${RESET}  ${label}")
  else
    RESULTS+=("${RED}FAIL${RESET}  ${label}")
    OVERALL_EXIT=1
  fi
}

run_script() {
  local label="$1"
  local script_path="$2"
  shift 2

  log "Running: ${script_path}${*:+ $*}"
  if bash "${script_path}" "$@"; then
    RESULTS+=("${GREEN}PASS${RESET}  ${label}")
  else
    RESULTS+=("${RED}FAIL${RESET}  ${label}")
    OVERALL_EXIT=1
  fi
  # Always return 0 — failures are tracked in RESULTS/OVERALL_EXIT.
  # Returning non-zero would trigger `set -e` and kill the script early.
  return 0
}

# ══════════════════════════════════════════════════════════════════════════════
# Step 0: Load environment file
# ══════════════════════════════════════════════════════════════════════════════

header "0 / Load environment"

if [[ -f "${ENV_FILE}" ]]; then
  log "Sourcing ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
else
  warn "Env file not found: ${ENV_FILE}"
  warn "Continuing with environment variables already set in the shell."
fi

# ─── Apply defaults for vars not set in env file ─────────────────────────────

: "${API_BASE_URL:=http://localhost:3000}"
: "${TEST_EMAIL:=trade-test@local.test}"
: "${TEST_PASSWORD:=TradeTest123!}"
: "${VENUE:=hyperliquid}"
: "${EXECUTION_MODE:=paper}"
: "${TICK_INTERVAL_MS:=60000}"
: "${TIMEOUT_MS:=600000}"
: "${CADDY_BASE_URL:=https://staging.openaidom.com}"
: "${LLM_PROVIDER:=ollama}"
: "${LLM_LIGHT_MODEL:=qwen3:8b}"
: "${LLM_HEAVY_MODEL:=qwen3.6:35b-a3b-q4_K_M}"

# Prevent child scripts from auto-managing the stack — we handle it centrally.
export DOCKER_COMPOSE_UP=0
export DOCKER_COMPOSE_DOWN=0
export SKIP_TEARDOWN="${SKIP_TEARDOWN:-0}"

export API_BASE_URL TEST_EMAIL TEST_PASSWORD VENUE EXECUTION_MODE
export TICK_INTERVAL_MS TIMEOUT_MS CADDY_BASE_URL
export LLM_PROVIDER LLM_LIGHT_MODEL LLM_HEAVY_MODEL
export DOCKER_COMPOSE_UP DOCKER_COMPOSE_DOWN SKIP_TEARDOWN

# ══════════════════════════════════════════════════════════════════════════════
# Tier 1: No-stack tests (pure vitest, no services needed)
# ══════════════════════════════════════════════════════════════════════════════

if tier_enabled 1; then
  header "Tier 1 / No-stack tests"

  run_script "agent-bot-e2e (LLM inheritance)" \
    "${TESTS_DIR}/agent-bot-e2e-test.sh"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Tier 2: Redis-only tests
# ══════════════════════════════════════════════════════════════════════════════

if tier_enabled 2; then
  header "Tier 2 / Redis-only tests"

  # Ensure Redis is up
  REDIS_WAS_HEALTHY=false
  if service_healthy redis; then
    log "redis already healthy — skipping start."
    REDIS_WAS_HEALTHY=true
  fi

  if [[ "${REDIS_WAS_HEALTHY}" == "false" ]]; then
    log "Starting redis…"
    docker compose -f "${COMPOSE_FILE}" up -d redis
    INFRA_STARTED=true
  fi
  wait_healthy redis

  run_script "agent-watch-invariants (smoke)" \
    "${TESTS_DIR}/agent-watch-invariants.sh" --smoke
fi

# ══════════════════════════════════════════════════════════════════════════════
# Tiers 3-5: Ensure postgres + api + worker are up
# ══════════════════════════════════════════════════════════════════════════════

NEEDS_FULL_STACK=false
if tier_enabled 3 || tier_enabled 4 || tier_enabled 5; then
  NEEDS_FULL_STACK=true
fi

if ${NEEDS_FULL_STACK}; then
  header "Infrastructure / postgres + redis + api + worker"

  # --- postgres ---
  POSTGRES_WAS_HEALTHY=false
  if service_healthy postgres; then
    log "postgres already healthy — skipping start."
    POSTGRES_WAS_HEALTHY=true
  fi

  # --- redis (may already be up from tier 2) ---
  REDIS_WAS_HEALTHY=false
  if service_healthy redis; then
    log "redis already healthy — skipping start."
    REDIS_WAS_HEALTHY=true
  fi

  if [[ "${POSTGRES_WAS_HEALTHY}" == "false" || "${REDIS_WAS_HEALTHY}" == "false" ]]; then
    log "Starting postgres and redis…"
    docker compose -f "${COMPOSE_FILE}" up -d postgres redis
    INFRA_STARTED=true
  fi

  wait_healthy postgres
  wait_healthy redis

  # Run DB migrations (idempotent)
  log "Running DB migrations…"
  docker compose -f "${COMPOSE_FILE}" build migrate 2>&1 | tail -1
  docker compose -f "${COMPOSE_FILE}" run --rm migrate 2>/dev/null || \
    docker compose -f "${COMPOSE_FILE}" up --no-deps --build --exit-code-from migrate migrate

  # --- api + worker ---
  API_WAS_HEALTHY=false
  if api_healthy; then
    log "API already healthy — skipping start."
    API_WAS_HEALTHY=true
  fi

  WORKER_WAS_RUNNING=false
  if docker compose -f "${COMPOSE_FILE}" ps --format json worker 2>/dev/null | grep -q '"State":"running"'; then
    log "worker already running — skipping start."
    WORKER_WAS_RUNNING=true
  fi

  if [[ "${API_WAS_HEALTHY}" == "false" || "${WORKER_WAS_RUNNING}" == "false" ]]; then
    log "Starting api + worker…"
    docker compose -f "${COMPOSE_FILE}" up -d --build api worker
    STACK_STARTED=true
  fi

  wait_healthy api
fi

# ══════════════════════════════════════════════════════════════════════════════
# Tier 3: API + DB tests (no worker, no venue keys)
# ══════════════════════════════════════════════════════════════════════════════

if tier_enabled 3; then
  header "Tier 3 / API + DB tests"

  run_script "agent-config-matrix (6 agent-type × method combos)" \
    "${TESTS_DIR}/agent-config-matrix-test.sh"

  run_script "agent-config-persistence (DB write + reject)" \
    "${TESTS_DIR}/agent-config-persistence-test.sh"

  run_script "billing-webhook-smoke (subscription + top-up persistence)" \
    "${TESTS_DIR}/billing-webhook-smoke-test.sh"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Tier 4: Full stack tests (no venue keys)
# ══════════════════════════════════════════════════════════════════════════════

if tier_enabled 4; then
  header "Tier 4 / Full stack tests (no venue keys)"

  run_script "agent-document-handling (PDF+DOCX upload, artifact verify)" \
    "${TESTS_DIR}/agent-document-handling-test.sh"

  run_script "agent-scanner-gated-lifecycle (create → start → running)" \
    "${TESTS_DIR}/agent-scanner-gated-lifecycle-test.sh"

  run_script "browser-pool-agent-browser-smoke (CLI → Browserless → CDP)" \
    "${TESTS_DIR}/browser-pool-agent-browser-smoke-test.sh"

  run_script "sandbox-allowlist-smoke (SANDBOX_ALLOWED_HOSTS iptables)" \
    "${TESTS_DIR}/sandbox-allowlist-smoke-test.sh"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Tier 5: Full stack + venue credentials  [opt-in]
# ══════════════════════════════════════════════════════════════════════════════

if tier_enabled 5; then
  header "Tier 5 / Full stack + venue credentials"

  # Validate that Hyperliquid keys are present before attempting
  HL_MISSING=false
  for VAR in HL_API_KEY HL_SECRET HL_WALLET_ADDRESS; do
    if [[ -z "${!VAR:-}" ]]; then
      err "Missing required env var: ${VAR}"
      HL_MISSING=true
    fi
  done

  if ${HL_MISSING}; then
    err "Skipping Tier 5 — Hyperliquid credentials not configured."
    err "Set HL_API_KEY, HL_SECRET, and HL_WALLET_ADDRESS in ${ENV_FILE}"
    RESULTS+=("${RED}FAIL${RESET}  Tier 5 / Full stack + venue (missing credentials)")
    OVERALL_EXIT=1
  else
    run_script "agent-trade-test (agent smoke)" \
      "${TESTS_DIR}/agent-trade-test.sh"

    run_script "bot-trade-test (bot lifecycle)" \
      "${TESTS_DIR}/bot-trade-test.sh"

    run_script "platform-preset-assessment (operator + agent config gating)" \
      "${TESTS_DIR}/platform-preset-assessment-test.sh"

    run_script "preset-review-gap-closure (hybrid preset resolution + intelligence gating)" \
      "${TESTS_DIR}/preset-review-gap-closure-test.sh"

    run_script "scanner-provider-smoke (BTC+ETH candle scan)" \
      "${TESTS_DIR}/scanner-provider-smoke-test.sh"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Tier 6: External infra checks  [opt-in]
# ══════════════════════════════════════════════════════════════════════════════

if tier_enabled 6; then
  header "Tier 6 / External infra checks"

  # --- Autoscale smoke test ---
  AUTOSCALE_BACKEND_ENV="${BACKEND_ENV_FILE:-${ROOT}/infra/hetzner/.env.backend}"
  if [[ -f "${AUTOSCALE_BACKEND_ENV}" ]]; then
    run_script "autoscale-smoke (Nomad cluster + capacity + scale-in dry-run)" \
      "${TESTS_DIR}/autoscale-smoke-test.sh" --env "${HEROBIDS_ENV:-staging}" --backend-env-file "${AUTOSCALE_BACKEND_ENV}"
  else
    warn "Skipping autoscale-smoke-test: ${AUTOSCALE_BACKEND_ENV} not found"
  fi

  # --- Autoscale capacity trigger test (destructive, opt-in) ---
  if [[ "${AUTOSCALE_DESTRUCTIVE:-false}" == "true" ]] && [[ -f "${AUTOSCALE_BACKEND_ENV}" ]]; then
    run_script "autoscale-capacity-trigger (dummy jobs → scale-out → cleanup)" \
      "${TESTS_DIR}/autoscale-capacity-trigger-test.sh" --env "${HEROBIDS_ENV:-staging}" --backend-env-file "${AUTOSCALE_BACKEND_ENV}"
  elif [[ "${AUTOSCALE_DESTRUCTIVE:-false}" == "true" ]]; then
    warn "Skipping autoscale-capacity-trigger: ${AUTOSCALE_BACKEND_ENV} not found"
  fi

  # --- Caddy routing smoke test ---
  run_script "caddy-routing-smoke (OAuth routing)" \
    "${TESTS_DIR}/caddy-routing-smoke-test.sh" "${CADDY_BASE_URL}"

  # --- Telegram messaging test ---
  TELEGRAM_MISSING=false
  for VAR in TELEGRAM_BOT_TOKEN TEST_CHAT_IDS; do
    if [[ -z "${!VAR:-}" ]]; then
      warn "Missing env var: ${VAR} — telegram test will likely fail"
      TELEGRAM_MISSING=true
    fi
  done

  if ${TELEGRAM_MISSING}; then
    warn "Telegram credentials not fully configured. Test may skip or fail."
  fi

  # test-telegram-messaging.sh needs --env-file explicitly
  TELEGRAM_ENV_FILE="${ENV_FILE}"
  if [[ ! -f "${TELEGRAM_ENV_FILE}" ]]; then
    # Fall back: if the primary env file doesn't exist, let the script
    # try its own default (it will warn and continue).
    TELEGRAM_ENV_FILE=""
  fi

  if [[ -n "${TELEGRAM_ENV_FILE}" ]]; then
    run_script "telegram-messaging (bot token, webhook, chat reachability)" \
      "${TESTS_DIR}/test-telegram-messaging.sh" --env-file "${TELEGRAM_ENV_FILE}"
  else
    run_script "telegram-messaging (bot token, webhook, chat reachability)" \
      "${TESTS_DIR}/test-telegram-messaging.sh"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════

header "Summary"
for r in "${RESULTS[@]}"; do
  echo -e "  ${r}"
done
echo ""

exit $OVERALL_EXIT
