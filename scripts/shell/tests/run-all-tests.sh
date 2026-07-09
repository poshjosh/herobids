#!/usr/bin/env bash
# run-all-tests.sh — Run the full HeroBids test suite.
#
# Test tiers (in order):
#   1. Unit tests          — pure logic, no external services required
#   4. Integration tests   — DB + auth flows; requires postgres & redis
#   5. Functional tests    — full API + worker in-process; requires postgres & redis
#   6. API smoke tests     — shell-based API tests (runtime-policy); requires API server
#   7. E2E tests           — Playwright browser journeys; requires the full Docker stack
#                            (opt-in: pass --e2e to include)
#
# Venue integration tests (Hyperliquid, Bybit, 1inch) are excluded — they
# require real API keys and hit live endpoints.
#
# Usage:
#   scripts/shell/tests/run-all-tests.sh           # unit + integration + functional
#   scripts/shell/tests/run-all-tests.sh --e2e     # all of the above + E2E
#
# Infrastructure lifecycle:
#   - Postgres and Redis are started via Docker Compose if not already healthy.
#   - The full stack (api, worker, web) is additionally started for --e2e.
#   - Services that this script started are torn down on exit (success or failure).
#   - Services that were already running before the script are left untouched.
#
# Requirements:
#   - docker (with compose plugin)
#   - pnpm (node >=22)
#   - playwright browsers installed: pnpm --filter @herobids/e2e exec playwright install
#
# Exit codes:
#   0  — all selected test tiers passed
#   1  — one or more test tiers failed (or setup error)

set -euo pipefail

# ─── Resolve project root ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

log()    { echo -e "${CYAN}[tests]${RESET} $*"; }
ok()     { echo -e "${GREEN}[tests]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[tests]${RESET} $*"; }
err()    { echo -e "${RED}[tests]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

# ─── Argument parsing ────────────────────────────────────────────────────────

RUN_E2E=false
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=true ;;
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ─── State tracking ──────────────────────────────────────────────────────────

INFRA_STARTED=false   # true if this script started postgres+redis
STACK_STARTED=false   # true if this script started the full stack

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  echo ""
  if [[ "${STACK_STARTED}" == "true" ]]; then
    warn "Tearing down full stack (started by this script)…"
    docker compose -f "${ROOT}/docker-compose.yaml" \
      down --timeout 20 2>/dev/null || true
  elif [[ "${INFRA_STARTED}" == "true" ]]; then
    warn "Tearing down postgres + redis (started by this script)…"
    docker compose -f "${ROOT}/docker-compose.yaml" \
      stop postgres redis 2>/dev/null || true
    docker compose -f "${ROOT}/docker-compose.yaml" \
      rm -f postgres redis 2>/dev/null || true
  fi
  if [[ $exit_code -eq 0 ]]; then
    ok "All done."
  else
    err "Test run failed (exit ${exit_code})."
  fi
  exit $exit_code
}
trap cleanup EXIT

# ─── Helper: check if a compose service is healthy/running ───────────────────

service_healthy() {
  local service="$1"
  local state
  state=$(docker compose -f "${ROOT}/docker-compose.yaml" ps --format json "$service" 2>/dev/null \
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

# ─── Step 1: Unit tests (no stack required) ──────────────────────────────────

header "1 / Unit tests"
log "Running unit tests (vitest)…"
if (cd "${ROOT}" && pnpm test); then
  RESULTS+=("${GREEN}PASS${RESET}  Unit tests")
else
  RESULTS+=("${RED}FAIL${RESET}  Unit tests")
  OVERALL_EXIT=1
fi

# ─── Step 1b: Agent-bot LLM inheritance verification ─────────────────────────
# Dedicated verification for bug-report 001: ensures agent-created LLM bots
# inherit the creator agent's provider/model instead of hardcoded defaults.
# Runs the focused vitest suite (4 tests) to keep feedback fast.

run_tier "Agent-bot LLM inheritance" \
  bash -c "cd '${ROOT}' && pnpm test -- --run -t 'manage_bot create_and_start.*LLM inheritance'"

# ─── Step 2: Ensure postgres + redis are up ──────────────────────────────────

header "2 / Infrastructure: postgres + redis"

POSTGRES_WAS_HEALTHY=false
REDIS_WAS_HEALTHY=false

if service_healthy postgres; then
  log "postgres already healthy — skipping start."
  POSTGRES_WAS_HEALTHY=true
fi
if service_healthy redis; then
  log "redis already healthy — skipping start."
  REDIS_WAS_HEALTHY=true
fi

if [[ "${POSTGRES_WAS_HEALTHY}" == "false" || "${REDIS_WAS_HEALTHY}" == "false" ]]; then
  log "Starting postgres and redis…"
  docker compose -f "${ROOT}/docker-compose.yaml" up -d postgres redis
  INFRA_STARTED=true
fi

wait_healthy postgres
wait_healthy redis

# Run migrations (idempotent — safe to re-run)
# Always rebuild the migrate image to pick up new migration files
log "Running DB migrations…"
docker compose -f "${ROOT}/docker-compose.yaml" build migrate 2>&1 | tail -1
docker compose -f "${ROOT}/docker-compose.yaml" run --rm migrate 2>/dev/null || \
  docker compose -f "${ROOT}/docker-compose.yaml" up --no-deps --build --exit-code-from migrate migrate

DATABASE_URL="postgres://herobids:herobids@localhost:5432/herobids"
REDIS_URL="redis://localhost:6379"
export DATABASE_URL REDIS_URL

# Load CREDENTIAL_ENCRYPTION_KEY from .env.dev if not already set in the environment
if [[ -z "${CREDENTIAL_ENCRYPTION_KEY:-}" && -f "${ROOT}/.env.dev" ]]; then
  CREDENTIAL_ENCRYPTION_KEY="$(grep -E '^CREDENTIAL_ENCRYPTION_KEY=' "${ROOT}/.env.dev" | cut -d= -f2- | tr -d '[:space:]')"
fi
export CREDENTIAL_ENCRYPTION_KEY

# ─── Step 3: Integration tests ───────────────────────────────────────────────

run_tier "Integration tests" \
  bash -c "cd '${ROOT}' && pnpm test:integration"

# ─── Step 4: Functional tests ────────────────────────────────────────────────

run_tier "Functional tests" \
  bash -c "cd '${ROOT}' && pnpm test:functional"

# ─── Step 5: API smoke tests (shell-based, against running API) ──────────────

API_STARTED=false
WORKER_STARTED=false
header "5 / API smoke tests"

log "Starting API + worker …"
docker compose -f "${ROOT}/docker-compose.yaml" up -d --build api worker
API_STARTED=true
WORKER_STARTED=true
wait_healthy api

run_tier "API smoke (runtime-policy)" \
  bash -c "cd '${ROOT}' && API_BASE_URL=http://localhost:3000 scripts/shell/tests/runtime-policy-e2e.sh"

run_tier "API smoke (agent-evaluation)" \
  bash -c "cd '${ROOT}' && DEFAULT_PROVIDER='${DEFAULT_PROVIDER:-ollama}' DEFAULT_LIGHT_MODEL='${DEFAULT_LIGHT_MODEL:-qwen3.6:35b-a3b-q4_K_M}' DEFAULT_HEAVY_MODEL='${DEFAULT_HEAVY_MODEL:-qwen3.6:35b-a3b-q4_K_M}' API_BASE_URL=http://localhost:3000 scripts/shell/tests/agent-evaluation-test.sh"

run_tier "API smoke (strategy-presets)" \
  bash -c "cd '${ROOT}' && API_BASE_URL=http://localhost:3000 scripts/shell/tests/test-presets.sh"

log "Stopping API + worker …"
docker compose -f "${ROOT}/docker-compose.yaml" stop api worker 2>/dev/null || true
docker compose -f "${ROOT}/docker-compose.yaml" rm -f api worker 2>/dev/null || true
API_STARTED=false
WORKER_STARTED=false

# Re-seed system skills after functional tests (they truncate the skills table)
if [[ "${RUN_E2E}" == "true" ]]; then
  log "Re-seeding system skills for E2E…"
  docker compose -f "${ROOT}/docker-compose.yaml" exec -T postgres psql -U herobids -d herobids <<'PSQL' 2>/dev/null || log "WARN: skill reseed failed (non-fatal)"
INSERT INTO "skills" (
  "id", "author_id", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "capability_families", "suggested_tick_interval_ms", "publication_status",
  "current_revision_id", "price_cents", "auto_published_by_plan", "tags",
  "created_at", "updated_at"
) VALUES
  (
    'bot-management', NULL,
    'Bot Management',
    'Create, start, stop, and monitor trading bots.',
    $$You have access to bot-management tools.

- Use `create_bot` to create a trading bot.
- Use `list_bots` to inspect existing bots.
- Use `get_bot_status` to inspect a bot's current state.
- Use `start_bot` to start a bot.
- Use `stop_bot` to stop a bot.
- Use `adjust_bot_config` to update a bot's configuration.
- Use `get_analytics` to inspect bot performance.
- Use `list_positions` to inspect open positions tied to managed bots.
- Use `send_message` to report actions, status, or issues to the user.$$,
    ARRAY['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'send_message'],
    ARRAY['bot_statuses', 'positions', 'costs'],
    ARRAY['token-budget', 'daily-loss', 'bot-limit'],
    ARRAY['trading'], 900000, 'published', 'bot-management:system:1', 0, false, ARRAY[]::text[], now(), now()
  ),
  (
    'trading', NULL,
    'Trading',
    'Submit trade decisions and inspect trading state.',
    $$You have access to trading tools.

- Use `submit_decision` to submit a trade intent for a specific instrument.
- Use `list_positions` to inspect current open positions.
- Use `get_analytics` to inspect recent trading outcomes and exposure.
- Use `check_regime` to assess current market conditions.
- Use `search_tokens` to find a token by name or symbol.
- Use `discover_tokens` to explore available trading candidates.
- Use `get_funding_rates` to inspect perpetual funding conditions.
- Use `get_market_overview` to inspect broad market state.
- Use `get_price` for focused price checks.
- Use `watch_token`, `list_watches`, `remove_watch`, and `check_watches` to maintain and inspect watch-based monitoring.$$,
    ARRAY['submit_decision', 'list_positions', 'get_analytics', 'check_regime', 'search_tokens', 'discover_tokens', 'get_funding_rates', 'get_market_overview', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
    ARRAY['positions', 'fills', 'analytics', 'costs'],
    ARRAY['token-budget', 'daily-loss'],
    ARRAY['trading'], 300000, 'published', 'trading:system:1', 0, false, ARRAY[]::text[], now(), now()
  ),
  (
    'risk-monitoring', NULL,
    'Risk Monitoring',
    'Watch open positions and alert the user when risk thresholds are approaching.',
    $$You have access to risk-monitoring and alerting tools.

- Use `list_positions` to inspect current open positions and exposure.
- Use `get_analytics` to inspect realized and unrealized performance context.
- Use `get_price` for focused price checks.
- Use `watch_token`, `list_watches`, `remove_watch`, and `check_watches` to maintain and inspect watch-based monitoring.
- Use `send_message` to alert the user.
- Use `publish_artifact` to publish structured monitoring outputs.$$,
    ARRAY['send_message', 'publish_artifact', 'list_positions', 'get_analytics', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
    ARRAY['positions', 'fills', 'analytics'],
    ARRAY['token-budget', 'daily-loss'],
    ARRAY['trading'], 300000, 'published', 'risk-monitoring:system:1', 0, false, ARRAY[]::text[], now(), now()
  ),
  (
    'programming', NULL,
    'Programming',
    'Run sandboxed code for analysis, calculations, and implementation support.',
    $$You have access to programming tools.

- Use `execute_code` to run sandboxed JavaScript for analysis, calculations, and implementation support.
- Use `send_message` to report findings or ask for clarification when needed.
- Use `publish_artifact` when a structured output is more useful than plain text.$$,
    ARRAY['execute_code', 'send_message', 'publish_artifact'],
    ARRAY['costs', 'session_elapsed'],
    ARRAY['token-budget'],
    ARRAY[]::text[], 900000, 'published', 'programming:system:1', 0, false, ARRAY[]::text[], now(), now()
  ),
  (
    'web-access', NULL,
    'Web Access',
    'Search the internet, read web pages, and fetch documents for research and information gathering.',
    $$You have access to internet research tools.

- Use `search_web(query)` to search the internet. Returns a list of results with titles, URLs, and text extracts.
- Use `browse_url(url)` to fetch and read the contents of a specific web page. Only `https://` URLs are allowed.
- Use `read_document(url)` to fetch and extract text from a document URL (e.g. PDF). Only `https://` URLs are allowed.
- Use `send_message` to share findings with the user.
- Use `publish_artifact` when findings are substantial enough to warrant a structured output.$$,
    ARRAY['search_web', 'browse_url', 'read_document', 'send_message', 'publish_artifact'],
    ARRAY['costs', 'session_elapsed'],
    ARRAY['token-budget'],
    ARRAY[]::text[], 900000, 'published', 'web-access:system:1', 0, false, ARRAY[]::text[], now(), now()
  ),
  (
    'task-management', NULL,
    'Task Management',
    'Create, track, and complete durable tasks; schedule one-shot reminders.',
    $$You have access to task management tools.

- Use `create_task` to create a durable task with a title, optional notes, and optional due datetime.
- Use `list_tasks` to list your current tasks and their status.
- Use `complete_task` to mark a task as completed by its ID.
- Use `schedule_reminder` to schedule a one-shot reminder at a specific datetime. The reminder will wake you at the scheduled time with structured context.$$,
    ARRAY['create_task', 'list_tasks', 'complete_task', 'schedule_reminder'],
    ARRAY['costs', 'session_elapsed'],
    ARRAY['token-budget'],
    ARRAY[]::text[], 900000, 'published', 'task-management:system:1', 0, false, ARRAY[]::text[], now(), now()
  )
ON CONFLICT ("id") DO UPDATE SET
  "name"                       = EXCLUDED."name",
  "description"                = EXCLUDED."description",
  "instructions"               = EXCLUDED."instructions",
  "required_tools"             = EXCLUDED."required_tools",
  "context_requirements"       = EXCLUDED."context_requirements",
  "required_guardrails"        = EXCLUDED."required_guardrails",
  "capability_families"        = EXCLUDED."capability_families",
  "suggested_tick_interval_ms" = EXCLUDED."suggested_tick_interval_ms",
  "publication_status"         = EXCLUDED."publication_status",
  "current_revision_id"        = EXCLUDED."current_revision_id",
  "updated_at"                 = now()
WHERE "skills"."author_id" IS NULL;

DELETE FROM "skill_revisions"
WHERE "skill_id" IN (SELECT "id" FROM "skills" WHERE "author_id" IS NULL)
  AND "id" NOT LIKE '%:system:%';

INSERT INTO "skill_revisions" (
  "id", "skill_id", "version", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "capability_families", "suggested_tick_interval_ms", "tags",
  "change_summary", "created_by_user_id", "created_at"
)
SELECT
  (s."id" || ':system:1') AS "id",
  s."id" AS "skill_id",
  1 AS "version",
  s."name", s."description", s."instructions",
  s."required_tools", s."context_requirements", s."required_guardrails",
  s."capability_families", s."suggested_tick_interval_ms",
  COALESCE(s."tags", '{}'::text[]) AS "tags",
  'reseed' AS "change_summary",
  NULL AS "created_by_user_id",
  COALESCE(s."created_at", now()) AS "created_at"
FROM "skills" s
WHERE s."author_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
PSQL
fi

# ─── Step 6: E2E tests (opt-in) ──────────────────────────────────────────────

if [[ "${RUN_E2E}" == "true" ]]; then
  header "6 / Full stack for E2E"

  log "Building and starting full stack (api, worker, web)…"
  docker compose -f "${ROOT}/docker-compose.yaml" up -d --build api worker web
  STACK_STARTED=true

  # api health is the gate; web + worker follow
  wait_healthy api

  log "Waiting for web (port 5173)…"
  retries=30
  while [[ $retries -gt 0 ]]; do
    if curl -sf http://localhost:5173 > /dev/null 2>&1; then
      ok "Web is reachable."
      break
    fi
    sleep 2
    (( retries-- ))
  done
  if [[ $retries -eq 0 ]]; then
    err "Web did not become reachable at http://localhost:5173"
    RESULTS+=("${RED}FAIL${RESET}  E2E tests (stack did not start)")
    OVERALL_EXIT=1
  else
    run_tier "E2E tests (Playwright)" \
      bash -c "cd '${ROOT}/tests/e2e' && BASE_URL=http://localhost:5173 pnpm test"
  fi
else
  header "6 / E2E tests (skipped)"
  warn "Pass --e2e to include Playwright end-to-end tests."
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

header "Summary"
for r in "${RESULTS[@]}"; do
  echo -e "  ${r}"
done
echo ""

exit $OVERALL_EXIT
