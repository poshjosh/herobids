#!/usr/bin/env bash
# with-boundary.sh — cross-stack run harness (herobids → boundary → traderton).
#
# Stands up the traderton boundary stack, wires the herobids api/worker to it,
# then (optionally) runs the black-box shell test scripts against the running
# herobids API. Trading in herobids is ALWAYS behind the boundary, so there is
# no opt-in flag — the boundary is brought up unconditionally.
#
# It re-uses the two EXISTING composes (no third duplicate compose):
#   - the traderton stack under project name `traderton_xstack`, with a
#     herobids-side overlay that remaps its host ports (5433/6380) to dodge the
#     collision with herobids (5432/6379). The boundary stays on host :8080.
#   - the herobids stack with docker/xstack.override.yml, which adds
#     host.docker.internal wiring + the TRADERTON_BOUNDARY_* creds so herobids
#     reaches the boundary at host.docker.internal:8080.
#
# Usage:
#   scripts/shell/run/with-boundary.sh
#       # bring both stacks up, print readiness + the reachability probe, leave up
#   scripts/shell/run/with-boundary.sh scripts/shell/tests/bot-trade-test.sh
#       # bring both stacks up, run the given test script(s) with
#       # API_BASE_URL=http://localhost:3000, then tear down what we started
#   scripts/shell/run/with-boundary.sh --keep-up scripts/shell/tests/bot-trade-test.sh
#       # as above but skip teardown (useful for running multiple test scripts)
#
# Options:
#   --keep-up   Do not tear down the stacks on exit (leave them running).
#   --help, -h  Show this help.
#
# Environment:
#   TRADERTON_DIR   Path to the traderton checkout (default: ../traderton
#                   relative to the herobids repo root).
#   Any TRADERTON_BOUNDARY_* var overrides the local-dev default in the overlay.
#
# Infrastructure lifecycle:
#   - The traderton boundary stack is brought up under project `traderton_xstack`.
#     If this script created it, it is torn down (`down`) on exit; if it was
#     already running, it is left untouched.
#   - herobids postgres/redis/migrate + api/worker are brought up. Services this
#     script started are stopped on exit; services already running are left
#     untouched. Containers this script created (did not exist before) are
#     removed; ones it merely started (pre-existing, stopped) are only stopped.
#   - Pass --keep-up to skip all teardown.
#
# Requirements:
#   - docker (with compose plugin >= 2.24 — the port-remap overlay uses the
#     `!override` YAML tag to REPLACE the traderton `ports:` list; without it,
#     compose MERGES the lists and re-collides on host 5432/6379).
#   - a traderton checkout at $TRADERTON_DIR (default ../traderton).
#
# Prerequisites — matching boundary credentials (both sides read from .env):
#   The boundary REJECTS every call with `authentication.invalid_caller`
#   ("signature mismatch") unless the HMAC identity matches on both sides, and
#   provisioning fails without a valid encryption key. Set, in each repo's
#   (gitignored) .env — see the committed .env.example twins for the keys:
#     traderton/.env : BOUNDARY_CONSUMER_ID, BOUNDARY_KEY_ID,
#                      BOUNDARY_SIGNING_SECRET, CREDENTIAL_ENCRYPTION_KEY
#                      (64 hex chars = 32 bytes), + venue/market keys
#                      (BIRDEYE_API_KEY, COINMARKETCAP_API_KEY, ONEINCH_API_KEY,
#                      JUPITER_API_KEY).
#     herobids/.env  : TRADERTON_BOUNDARY_CONSUMER_ID, TRADERTON_BOUNDARY_KEY_ID,
#                      TRADERTON_BOUNDARY_HMAC_SECRET — MUST equal traderton's
#                      BOUNDARY_CONSUMER_ID / KEY_ID / SIGNING_SECRET respectively.
#   Both stacks load these via `env_file: .env`; the boundary URL is injected by
#   docker/xstack.override.yml as host.docker.internal:8080 (the two composes are
#   separate Docker networks, so it is NOT localhost from inside the containers).
#
# Troubleshooting:
#   - `authentication.invalid_caller` / "signature mismatch": the HMAC triple
#     differs between herobids/.env and traderton/.env — align consumer/key/secret.
#   - provider-link 502 "Credential encryption unavailable ... 64 hex chars":
#     traderton/.env CREDENTIAL_ENCRYPTION_KEY is missing/invalid — set 64 hex.
#   - create_bot "no default venue account for owner (ambiguous)" or provider-link
#     403 "Connection limit reached": LEAKED STATE from a prior FAILED run (a
#     completed bot-trade-test deprovisions itself; failed runs can leak). Clear it
#     to UNBLOCK a re-run (do NOT use this to mask a real failure):
#       # traderton venue accounts (delete bots first — FK):
#       docker compose -p traderton_xstack -f "$TRADERTON_DIR/docker-compose.yml" \
#         -f docker/traderton-xstack.override.yml exec -T postgres \
#         psql -U traderton -d traderton -c "delete from bots; delete from venue_accounts;"
#       # herobids connections for the test user:
#       docker compose -f docker-compose.yaml -f docker/xstack.override.yml exec -T postgres \
#         psql -U herobids -d herobids -c \
#         "delete from connections where user_id=(select id from users where email='herobids@gmail.com');"
#   - boundary never reaches /health/ready: first `--build` is slow (builds the
#     traderton migrate + boundary images); or host :8080 is taken.
#
# Exit codes:
#   0  — readiness reached (and any test scripts passed)
#   1  — setup error or a test script failed

set -euo pipefail

# ─── Resolve project roots ───────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TRADERTON_DIR="${TRADERTON_DIR:-$(cd "${ROOT}/.." && pwd)/traderton}"

TRADERTON_PROJECT="traderton_xstack"
TRADERTON_COMPOSE="${TRADERTON_DIR}/docker-compose.yml"
TRADERTON_OVERLAY="${ROOT}/docker/traderton-xstack.override.yml"
HEROBIDS_OVERLAY="${ROOT}/docker/xstack.override.yml"

BOUNDARY_URL="http://localhost:8080"
HEROBIDS_API_URL="http://localhost:3000"

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

log()    { echo -e "${CYAN}[boundary]${RESET} $*"; }
ok()     { echo -e "${GREEN}[boundary]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[boundary]${RESET} $*"; }
err()    { echo -e "${RED}[boundary]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

# ─── Argument parsing ────────────────────────────────────────────────────────

KEEP_UP=false
declare -a TEST_SCRIPTS=()
for arg in "$@"; do
  case "$arg" in
    --keep-up) KEEP_UP=true ;;
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) err "Unknown option: $arg"; exit 1 ;;
    *) TEST_SCRIPTS+=("$arg") ;;
  esac
done

# ─── State tracking ──────────────────────────────────────────────────────────

TRADERTON_STARTED=false   # true if this script brought the traderton stack up
TRADERTON_CREATED=false   # true if the traderton containers did NOT exist before
INFRA_STARTED=false       # true if this script started herobids postgres+redis+deps
STACK_STARTED=false       # true if this script started herobids api+worker
STACK_CREATED=false       # true if herobids api/worker did NOT exist before

# ─── Compose wrappers ────────────────────────────────────────────────────────

herobids_compose() {
  docker compose -f "${ROOT}/docker-compose.yaml" -f "${HEROBIDS_OVERLAY}" "$@"
}

traderton_compose() {
  docker compose -p "${TRADERTON_PROJECT}" \
    -f "${TRADERTON_COMPOSE}" -f "${TRADERTON_OVERLAY}" "$@"
}

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  echo ""
  if [[ "${KEEP_UP}" == "true" ]]; then
    warn "--keep-up set — leaving stacks running."
    if [[ $exit_code -eq 0 ]]; then ok "Done (stacks left up)."; else err "Failed (exit ${exit_code}); stacks left up."; fi
    exit $exit_code
  fi

  # herobids api/worker
  if [[ "${STACK_STARTED}" == "true" ]]; then
    if [[ "${STACK_CREATED}" == "true" ]]; then
      warn "Tearing down herobids api+worker (created by this script)…"
      herobids_compose stop api worker 2>/dev/null || true
      herobids_compose rm -f api worker 2>/dev/null || true
    else
      warn "Stopping herobids api+worker (started — not created — by this script)…"
      herobids_compose stop api worker 2>/dev/null || true
    fi
  fi

  # herobids infra (postgres/redis/deps) — only stop, never destroy volumes
  if [[ "${INFRA_STARTED}" == "true" ]]; then
    warn "Stopping herobids infra (started by this script)…"
    herobids_compose stop postgres redis docker-proxy skills-api 2>/dev/null || true
  fi

  # traderton boundary stack
  if [[ "${TRADERTON_STARTED}" == "true" ]]; then
    if [[ "${TRADERTON_CREATED}" == "true" ]]; then
      warn "Tearing down traderton boundary stack (created by this script)…"
      traderton_compose down --timeout 20 2>/dev/null || true
    else
      warn "Stopping traderton boundary stack (started — not created — by this script)…"
      traderton_compose stop 2>/dev/null || true
    fi
  fi

  if [[ $exit_code -eq 0 ]]; then
    ok "All done."
  else
    err "Run failed (exit ${exit_code})."
  fi
  exit $exit_code
}
trap cleanup EXIT

# ─── Helpers: herobids service state ─────────────────────────────────────────
# Mirror run-all-tests.sh: distinguish healthy / running / exists so cleanup can
# stop-only-what-was-down and only destroy containers this script created.

service_healthy() {
  local service="$1" state
  state=$(herobids_compose ps --format json "$service" 2>/dev/null \
    | grep -o '"Health":"[^"]*"' | head -1 | cut -d'"' -f4)
  [[ "$state" == "healthy" ]]
}

service_running() {
  local service="$1" state
  state=$(herobids_compose ps --format json "$service" 2>/dev/null \
    | grep -o '"State":"[^"]*"' | head -1 | cut -d'"' -f4)
  [[ "$state" == "running" ]]
}

service_exists() {
  local service="$1" id
  id=$(herobids_compose ps -a --format json "$service" 2>/dev/null \
    | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
  [[ -n "$id" ]]
}

wait_healthy() {
  local service="$1" retries=30
  log "Waiting for herobids ${service} to be healthy…"
  while [[ $retries -gt 0 ]]; do
    if service_healthy "$service"; then
      ok "herobids ${service} is healthy."
      return 0
    fi
    sleep 2
    (( retries-- ))
  done
  err "herobids ${service} did not become healthy in time."
  return 1
}

# ─── Helper: wait for an HTTP endpoint (curl -sf) ────────────────────────────
# Budget mirrors traderton's own harness: ~45 × 2s.

wait_http() {
  local label="$1" url="$2" retries="${3:-45}"
  log "Waiting for ${label} (${url})…"
  while [[ $retries -gt 0 ]]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      ok "${label} is ready."
      return 0
    fi
    sleep 2
    (( retries-- ))
  done
  err "${label} did not become ready at ${url}."
  return 1
}

# ─── Preflight ───────────────────────────────────────────────────────────────

header "Cross-stack boundary harness"

if [[ ! -f "${TRADERTON_COMPOSE}" ]]; then
  err "traderton compose not found at: ${TRADERTON_COMPOSE}"
  err "Set TRADERTON_DIR to your traderton checkout (currently: ${TRADERTON_DIR})."
  exit 1
fi

# ─── Step 1: bring up the traderton boundary stack ───────────────────────────

header "1 / traderton boundary stack (project: ${TRADERTON_PROJECT})"

# Was the boundary already serving before we touched anything?
if curl -sf "${BOUNDARY_URL}/health/ready" > /dev/null 2>&1; then
  log "Boundary already ready at ${BOUNDARY_URL} — reusing it (will not tear down)."
else
  # Did any traderton_xstack container already exist? If not, we created them
  # and may fully `down`; if some existed (stopped), we only `stop`.
  TRADERTON_PREEXISTED=true
  if [[ -z "$(traderton_compose ps -aq 2>/dev/null)" ]]; then
    TRADERTON_PREEXISTED=false
  fi
  log "Building and starting the traderton boundary stack (host ports remapped: pg 5433, redis 6380)…"
  traderton_compose up -d --build
  TRADERTON_STARTED=true
  if [[ "${TRADERTON_PREEXISTED}" == "false" ]]; then
    TRADERTON_CREATED=true
  fi
fi

wait_http "traderton boundary" "${BOUNDARY_URL}/health/ready" 45

# ─── Step 2: bring up herobids infra (postgres/redis/deps) + migrate ─────────

header "2 / herobids infrastructure"

POSTGRES_WAS_HEALTHY=false
REDIS_WAS_HEALTHY=false
if service_healthy postgres; then log "herobids postgres already healthy."; POSTGRES_WAS_HEALTHY=true; fi
if service_healthy redis;    then log "herobids redis already healthy.";    REDIS_WAS_HEALTHY=true;    fi

if [[ "${POSTGRES_WAS_HEALTHY}" == "false" || "${REDIS_WAS_HEALTHY}" == "false" ]]; then
  log "Starting herobids postgres, redis, and container deps…"
  herobids_compose up -d postgres redis docker-proxy skills-api
  INFRA_STARTED=true
fi

wait_healthy postgres
wait_healthy redis

# Run migrations (idempotent — safe to re-run), mirroring run-all-tests.sh.
log "Running DB migrations…"
herobids_compose build migrate 2>&1 | tail -1
herobids_compose run --rm migrate 2>/dev/null || \
  herobids_compose up --no-deps --build --exit-code-from migrate migrate

# ─── Step 3: bring up herobids api + worker (with the boundary overlay) ──────

header "3 / herobids api + worker (wired to the boundary)"

# Inspect state BEFORE touching, so cleanup does the right thing.
STACK_WAS_RUNNING=true
STACK_PREEXISTED=true
for svc in api worker; do
  if ! service_running "$svc"; then STACK_WAS_RUNNING=false; fi
  if ! service_exists "$svc";  then STACK_PREEXISTED=false;  fi
done

if [[ "${STACK_WAS_RUNNING}" == "true" ]]; then
  log "herobids api+worker already running — reusing (will not tear down)."
else
  log "Building and starting herobids api+worker with docker/xstack.override.yml…"
  herobids_compose up -d --build api worker
  STACK_STARTED=true
  if [[ "${STACK_PREEXISTED}" == "false" ]]; then
    STACK_CREATED=true
  fi
fi

wait_healthy api

# ─── Step 4: run test scripts, or report readiness ───────────────────────────

PROBE_CMD="docker compose -f \"${ROOT}/docker-compose.yaml\" -f \"${HEROBIDS_OVERLAY}\" exec -T api node -e \"fetch('http://host.docker.internal:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""

if [[ ${#TEST_SCRIPTS[@]} -eq 0 ]]; then
  header "Ready"
  ok "traderton boundary: ${BOUNDARY_URL}/health/ready"
  ok "herobids API:       ${HEROBIDS_API_URL}/health"
  log "Probe boundary reachability from inside the api container with:"
  echo "  ${PROBE_CMD}"
  if [[ "${KEEP_UP}" != "true" ]]; then
    warn "No test scripts passed and --keep-up not set — stacks will be torn down on exit."
    warn "Pass --keep-up to leave them running for manual/black-box testing."
  fi
  exit 0
fi

header "4 / Running test scripts"
OVERALL_EXIT=0
declare -a RESULTS=()
for script in "${TEST_SCRIPTS[@]}"; do
  log "Running: ${script}"
  if API_BASE_URL="${HEROBIDS_API_URL}" bash "${script}"; then
    RESULTS+=("${GREEN}PASS${RESET}  ${script}")
  else
    RESULTS+=("${RED}FAIL${RESET}  ${script}")
    OVERALL_EXIT=1
  fi
done

header "Summary"
for r in "${RESULTS[@]}"; do
  echo -e "  ${r}"
done
echo ""

exit $OVERALL_EXIT
