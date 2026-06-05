#!/usr/bin/env bash
# run-all-tests.sh — Run the full Herobids test suite.
#
# Test tiers (in order):
#   1. Unit tests          — pure logic, no external services required
#   2. Integration tests   — DB + auth flows; requires postgres & redis
#   3. Functional tests    — full API + worker in-process; requires postgres & redis
#   4. E2E tests           — Playwright browser journeys; requires the full Docker stack
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
log "Running DB migrations…"
docker compose -f "${ROOT}/docker-compose.yaml" run --rm migrate 2>/dev/null || \
  docker compose -f "${ROOT}/docker-compose.yaml" up --no-deps --exit-code-from migrate migrate

DATABASE_URL="postgres://herobids:herobids@localhost:5432/herobids"
REDIS_URL="redis://localhost:6379"
export DATABASE_URL REDIS_URL

# ─── Step 3: Integration tests ───────────────────────────────────────────────

run_tier "Integration tests" \
  bash -c "cd '${ROOT}' && pnpm test:integration"

# ─── Step 4: Functional tests ────────────────────────────────────────────────

run_tier "Functional tests" \
  bash -c "cd '${ROOT}' && pnpm test:functional"

# ─── Step 5: E2E tests (opt-in) ──────────────────────────────────────────────

if [[ "${RUN_E2E}" == "true" ]]; then
  header "5 / Full stack for E2E"

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
  header "5 / E2E tests (skipped)"
  warn "Pass --e2e to include Playwright end-to-end tests."
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

header "Summary"
for r in "${RESULTS[@]}"; do
  echo -e "  ${r}"
done
echo ""

exit $OVERALL_EXIT
