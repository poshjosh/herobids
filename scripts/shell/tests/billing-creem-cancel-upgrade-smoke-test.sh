#!/usr/bin/env bash
# billing-creem-cancel-upgrade-smoke-test.sh — Validate cancel/upgrade requests
# against Creem's REAL test-mode API end-to-end (through our own API routes).
#
# Unlike billing-webhook-smoke-test.sh (which validates INBOUND webhook
# handling with synthetic payloads), this script validates OUTBOUND calls —
# CreemProvider.cancelSubscription()/upgradeSubscription() making real HTTP
# requests to https://test-api.creem.io/v1. It exists because those request
# shapes were never verified against Creem's actual contract (see
# docs/bug-reports/2026/08/15/002-creem-cancel-upgrade-subscription-payload.md)
# and unit tests only assert the request we send, not that Creem accepts it.
#
# Prerequisite (one-time, manual — Creem has no API-only way to create a
# subscription; it requires a hosted checkout):
#   1. Set CREEM_API_KEY to a real `creem_test_*` key from the Creem dashboard.
#   2. Complete one test-mode checkout (test card) against a product in
#      billing.creem.planProducts (see config/staging.yaml) to obtain a live
#      subscription. Copy its id (sub_...) from the Creem dashboard or the
#      checkout success redirect.
#   3. Export it as EXTERNAL_SUBSCRIPTION_ID.
#
# This script consumes the fixture subscription — the cancel step schedules
# real cancellation on Creem's side. Create a fresh EXTERNAL_SUBSCRIPTION_ID
# for each run (or skip --with-cancel to only check the upgrade path).
#
# Usage:
#   scripts/shell/tests/billing-creem-cancel-upgrade-smoke-test.sh
#   scripts/shell/tests/billing-creem-cancel-upgrade-smoke-test.sh --env /path/to/custom.env
#   scripts/shell/tests/billing-creem-cancel-upgrade-smoke-test.sh --no-cancel   # upgrade check only
#
# Requires:
#   - API and postgres reachable
#   - CREEM_API_KEY = a real creem_test_* key (refuses non-test keys)
#   - EXTERNAL_SUBSCRIPTION_ID = a live Creem test-mode subscription id
#   - TEST_EMAIL/TEST_PASSWORD test user (logged in or registered automatically)
#
# ─────────────────────────────────────────────────────────────────
# Variables in .env.ops.dev
# ─────────────────────────────────────────────────────────────────
#
# Required
#   API_BASE_URL              default http://localhost:3000
#   CREEM_API_KEY              real creem_test_* key
#   EXTERNAL_SUBSCRIPTION_ID   live Creem test-mode subscription id (sub_...)
#
# Optional
#   TEST_EMAIL                 test user email (default: creem-cancel-upgrade-smoke@local.test)
#   TEST_PASSWORD              test user password (default: E2ETest123!)
#   UPGRADE_PLAN_ID            plan id to upgrade to (default: starter)
#   FIXTURE_PRODUCT_ID         Creem product id backing EXTERNAL_SUBSCRIPTION_ID
#                              (default: config/staging.yaml starter product)
#   DOCKER_COMPOSE_UP          1 to auto-start the stack when API is unreachable (default: 1)
#   DOCKER_COMPOSE_DOWN        1 to stop the stack on exit if started by this script (default: 1)
# ─────────────────────────────────────────────────────────────────

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

RUN_CANCEL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --no-cancel)
      RUN_CANCEL=0
      shift
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
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

: "${API_BASE_URL:=http://localhost:3000}"
: "${TEST_EMAIL:=creem-cancel-upgrade-smoke@local.test}"
: "${TEST_PASSWORD:=E2ETest123!}"
: "${UPGRADE_PLAN_ID:=starter}"
: "${FIXTURE_PRODUCT_ID:=prod_2muSl3xna4UWLN6O9nJcjR}"
: "${DOCKER_COMPOSE_UP:=1}"
: "${DOCKER_COMPOSE_DOWN:=1}"

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if [[ -z "${CREEM_API_KEY:-}" ]]; then
  die "CREEM_API_KEY is not set. Add a real creem_test_* key to ${ENV_FILE} or export it."
fi
if [[ "${CREEM_API_KEY}" != creem_test_* ]]; then
  die "CREEM_API_KEY does not start with 'creem_test_' — refusing to run against a non-test key."
fi
if [[ -z "${EXTERNAL_SUBSCRIPTION_ID:-}" ]]; then
  die "EXTERNAL_SUBSCRIPTION_ID is not set. Create one live test-mode subscription via a Creem test checkout and export its id (see script header)."
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
  log "API not reachable — starting stack via build-and-run.sh..."
  bash "$SCRIPT_DIR/../run/build-and-run.sh" || die "build-and-run.sh failed"
  stackStartedByUs=1

  deadline=$(($(date +%s) + 60))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 3
    if check_api_health; then
      ok "API is healthy"
      break
    fi
  done
  if ! check_api_health; then
    die "API did not become healthy within 60s"
  fi
fi

ok "API reachable at ${API_BASE_URL}"

cleanup() {
  if [[ "$stackStartedByUs" == "1" && "$DOCKER_COMPOSE_DOWN" == "1" ]]; then
    log "Tearing down stack (started by this script)..."
    bash "$SCRIPT_DIR/../run/shutdown.sh" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Authenticate (login-or-register) + resolve the test user's id
# ---------------------------------------------------------------------------

COMPOSE_DEV="${REPO_ROOT}/docker-compose.dev.yaml"

db_query() {
  docker compose -f "${REPO_ROOT}/docker-compose.yaml" -f "${COMPOSE_DEV}" exec -T postgres \
    psql -U herobids -d herobids -At -c "$1" 2>/dev/null || echo ""
}

log "Authenticating as ${TEST_EMAIL}..."

login_payload=$(jq -n --arg email "${TEST_EMAIL}" --arg password "${TEST_PASSWORD}" '{email: $email, password: $password}')
login_resp=$(curl -s -X POST "${API_BASE_URL}/auth/login" -H 'Content-Type: application/json' -d "${login_payload}")
AUTH_TOKEN=$(echo "${login_resp}" | jq -r '.token // empty')

if [[ -z "${AUTH_TOKEN}" ]]; then
  log "Login failed — trying to register..."
  register_payload=$(jq -n --arg email "${TEST_EMAIL}" --arg password "${TEST_PASSWORD}" \
    '{email: $email, password: $password, displayName: "Creem Cancel/Upgrade Smoke"}')
  register_resp=$(curl -s -X POST "${API_BASE_URL}/auth/register" -H 'Content-Type: application/json' -d "${register_payload}")
  AUTH_TOKEN=$(echo "${register_resp}" | jq -r '.token // empty')
  if [[ -z "${AUTH_TOKEN}" ]]; then
    die "Could not authenticate. Login response: $(echo "${login_resp}" | jq -c '.'); Register response: $(echo "${register_resp}" | jq -c '.')"
  fi
fi
ok "Authenticated as ${TEST_EMAIL}"

USER_ID=$(db_query "SELECT id FROM users WHERE email = '${TEST_EMAIL}';")
if [[ -z "${USER_ID}" ]]; then
  die "Could not resolve user id for ${TEST_EMAIL} from the local DB."
fi
log "Test user id: ${USER_ID}"

log "Wiring fixture subscription ${EXTERNAL_SUBSCRIPTION_ID} to test user (provider=creem)..."
# Replace any existing subscription row for this user — findSubscriptionByUserId
# picks one row per user (active/trialing preferred, most recently updated).
db_query "DELETE FROM billing_subscriptions WHERE user_id = '${USER_ID}';" > /dev/null
db_query "
  INSERT INTO billing_subscriptions (id, user_id, provider, external_customer_id, external_subscription_id, plan_id, external_price_or_product_id, status, current_period_start, current_period_end, cancel_at_period_end)
  VALUES (gen_random_uuid()::text, '${USER_ID}', 'creem', 'cus_smoke', '${EXTERNAL_SUBSCRIPTION_ID}', 'starter', '${FIXTURE_PRODUCT_ID}', 'active', now(), now() + interval '30 days', false);
" > /dev/null

# ---------------------------------------------------------------------------
# State tracking
# ---------------------------------------------------------------------------

PASSED=0
FAILED=0

check() {
  local label="$1"; shift
  if "$@"; then
    ok "${label}"
    # Plain assignment (not ((PASSED++))) — post-increment from 0 evaluates to 0/false and would trip `set -e`.
    PASSED=$((PASSED + 1))
  else
    warn "FAIL: ${label}"
    FAILED=$((FAILED + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# Test 1 — Upgrade subscription (real Creem test API call via our route)
# ═══════════════════════════════════════════════════════════════════════════

log "── Test 1: POST /billing/upgrade-subscription (planId=${UPGRADE_PLAN_ID}) ──"

UPGRADE_RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "${API_BASE_URL}/billing/upgrade-subscription" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${AUTH_TOKEN}" \
  -d "{\"planId\":\"${UPGRADE_PLAN_ID}\"}" 2>&1)

UPGRADE_HTTP=$(echo "${UPGRADE_RESPONSE}" | tail -1)
UPGRADE_BODY=$(echo "${UPGRADE_RESPONSE}" | sed '$d')

log "  response: ${UPGRADE_HTTP} ${UPGRADE_BODY}"

check "upgrade-subscription returns HTTP 200 (Creem accepted items[]/update_behavior payload)" \
  bash -c "[[ '${UPGRADE_HTTP}' == '200' ]]"

check "upgrade-subscription body has success:true" \
  bash -c "echo '${UPGRADE_BODY}' | jq -e '.success == true' > /dev/null 2>&1"

# ═══════════════════════════════════════════════════════════════════════════
# Test 2 — Cancel subscription (real Creem test API call via our route)
# ═══════════════════════════════════════════════════════════════════════════

if [[ "${RUN_CANCEL}" == "1" ]]; then
  log "── Test 2: POST /billing/cancel-subscription (consumes the fixture subscription) ──"

  CANCEL_RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "${API_BASE_URL}/billing/cancel-subscription" \
    -H "authorization: Bearer ${AUTH_TOKEN}" 2>&1)

  CANCEL_HTTP=$(echo "${CANCEL_RESPONSE}" | tail -1)
  CANCEL_BODY=$(echo "${CANCEL_RESPONSE}" | sed '$d')

  log "  response: ${CANCEL_HTTP} ${CANCEL_BODY}"

  check "cancel-subscription returns HTTP 200 (Creem accepted mode/onExecute payload)" \
    bash -c "[[ '${CANCEL_HTTP}' == '200' ]]"
else
  warn "Skipping cancel test (--no-cancel). Fixture subscription left active."
fi

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

echo ""
log "── Results ──"
log "  Passed: ${PASSED}"
if [[ ${FAILED} -gt 0 ]]; then
  warn "  Failed: ${FAILED}"
  exit 1
else
  ok "All Creem cancel/upgrade contract checks passed."
  exit 0
fi
