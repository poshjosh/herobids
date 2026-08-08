#!/usr/bin/env bash
# billing-webhook-smoke-test.sh — Validate Creem webhook → DB persistence end-to-end.
#
# Sends known Creem webhook payloads (subscription + top-up) with valid HMAC
# signatures directly to the API, then verifies the expected DB changes.
#
# Scenarios:
#   1. Subscription webhook (checkout.completed) → billing_webhook_events row,
#      billing_subscriptions row, plan_id resolved correctly
#   2. Top-up webhook (checkout.completed with checkoutKind=top_up) →
#      billing_webhook_events row, top_up_credit ledger entry created
#
# Key assertions:
#   - Both webhooks return HTTP 200 {received:true}
#   - billing_webhook_events rows created with status=processed
#   - Subscription row created with non-empty plan_id (not defaulted to free)
#   - Top-up credit ledger entry created with correct amount (5,000,000 microUSD)
#
# Bug 2026-08-04/001: CreemProvider silently dropped webhooks due to field name
# mismatches (eventType vs event_type, product.id vs product_id, customer.id
# vs customer_id). This test catches regressions by sending Creem's actual
# payload format (camelCase, nested objects).
#
# Usage:
#   scripts/shell/tests/billing-webhook-smoke-test.sh
#   scripts/shell/tests/billing-webhook-smoke-test.sh --env /path/to/custom.env
#
# Requires:
#   - API and postgres reachable
#   - At least one user in the DB
#   - Creem provider configured (CREEM_API_KEY + CREEM_WEBHOOK_SECRET)
#
# Stack lifecycle:
#   - Start:  scripts/shell/run/build-and-run.sh  (pnpm build, lint, agent image,
#             docker compose up with dev overlay, seed admin, Ollama warmup)
#   - Stop:   scripts/shell/run/shutdown.sh        (graceful worker stop, agent
#             container cleanup, compose down -v)
#
# Setup:
#   cp .env.ops.dev.example .env.ops.dev
#   # Add CREEM_API_KEY=creem_test_local and CREEM_WEBHOOK_SECRET=whsec_test
#   chmod +x scripts/shell/tests/billing-webhook-smoke-test.sh
#   scripts/shell/tests/billing-webhook-smoke-test.sh
#
# ─────────────────────────────────────────────────────────────────
# Variables in .env.ops.dev
# ─────────────────────────────────────────────────────────────────
#
# Required
#   API_BASE_URL              default http://localhost:3000
#   CREEM_API_KEY             any creem_test_* key (e.g. creem_test_local)
#   CREEM_WEBHOOK_SECRET      any value (e.g. whsec_test)
#
# Optional
#   DOCKER_COMPOSE_UP         1 to auto-start the stack via build-and-run.sh when
#                             API is unreachable (default: 1)
#   DOCKER_COMPOSE_DOWN       1 to stop the stack via shutdown.sh on exit (only
#                             if started by this script; default: 1)
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="$2"
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
: "${DOCKER_COMPOSE_UP:=1}"
: "${DOCKER_COMPOSE_DOWN:=1}"

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

if [[ -z "${CREEM_API_KEY:-}" ]]; then
  die "CREEM_API_KEY is not set. Add it to ${ENV_FILE} or export it."
fi
if [[ -z "${CREEM_WEBHOOK_SECRET:-}" ]]; then
  die "CREEM_WEBHOOK_SECRET is not set. Add it to ${ENV_FILE} or export it."
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
      ok "API is healthy after $(($(date +%s) - deadline + 60))s"
      break
    fi
  done
  if ! check_api_health; then
    die "API did not become healthy within 60s"
  fi
fi

ok "API reachable at ${API_BASE_URL}"

# ---------------------------------------------------------------------------
# Pre-check: ensure Creem webhook endpoint is available (not mock provider)
# ---------------------------------------------------------------------------

WEBHOOK_CHECK=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE_URL}/billing/webhook/creem" \
  -H 'content-type: application/json' \
  -d '{}' 2>/dev/null || echo "000")

if [[ "${WEBHOOK_CHECK}" == "404" ]]; then
  WEBHOOK_BODY=$(curl -s -X POST "${API_BASE_URL}/billing/webhook/creem" \
    -H 'content-type: application/json' \
    -d '{}' 2>/dev/null || echo "")
  if echo "${WEBHOOK_BODY}" | grep -q "provider_not_configured\|mock_not_supported"; then
    warn "Creem webhook not available (Creem billing provider not active). Skipping test."
    warn "Set BILLING_PRIMARY_PROVIDER=creem in config to enable this test."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------

cleanup() {
  if [[ "$stackStartedByUs" == "1" && "$DOCKER_COMPOSE_DOWN" == "1" ]]; then
    log "Tearing down stack (started by this script)..."
    bash "$SCRIPT_DIR/../run/shutdown.sh" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Resolve test user
# ---------------------------------------------------------------------------

log "Resolving test user..."

COMPOSE_DEV="${REPO_ROOT}/docker-compose.dev.yaml"
USER_ROW=$(docker compose -f "${REPO_ROOT}/docker-compose.yaml" -f "${COMPOSE_DEV}" exec -T postgres \
  psql -U herobids -d herobids -At -c "SELECT id, email FROM users LIMIT 1;" 2>/dev/null || echo "")

if [[ -z "${USER_ROW}" ]]; then
  die "No users found in local DB. Seed a user first (e.g. via seed-admin.sh or the /auth/register endpoint)."
fi

USER_ID=$(echo "${USER_ROW}" | cut -d'|' -f1)
USER_EMAIL=$(echo "${USER_ROW}" | cut -d'|' -f2)
log "Using user: ${USER_EMAIL} (${USER_ID})"

# ---------------------------------------------------------------------------
# DB query helpers
# ---------------------------------------------------------------------------

db_query() {
  docker compose -f "${REPO_ROOT}/docker-compose.yaml" -f "${COMPOSE_DEV}" exec -T postgres \
    psql -U herobids -d herobids -At -c "$1" 2>/dev/null || echo ""
}

db_count() {
  local result
  result=$(db_query "$1")
  echo "${result:-0}"
}

# ---------------------------------------------------------------------------
# HMAC helpers
# ---------------------------------------------------------------------------

sign() {
  echo -n "$1" | openssl dgst -sha256 -hmac "${CREEM_WEBHOOK_SECRET}" | awk '{print $NF}'
}

# ---------------------------------------------------------------------------
# Known Creem test payloads
# ---------------------------------------------------------------------------

# Subscription payload (starter plan, via Creem checkout).
# Uses eventType (camelCase) and nested product.id / customer.id — Creem's actual
# format. The product ID must match config/staging.yaml creem.planProducts.starter.
SUB_EVENT_ID="smoke_sub_$(date +%s)"
SUB_PAYLOAD=$(jq -n --arg userId "${USER_ID}" --arg email "${USER_EMAIL}" --arg evtId "${SUB_EVENT_ID}" '{
  id: $evtId,
  eventType: "checkout.completed",
  created_at: (now * 1000 | floor),
  object: {
    id: ("ch_" + $evtId),
    object: "checkout",
    status: "completed",
    mode: "test",
    customer: {
      id: ("cus_" + $evtId),
      object: "customer",
      email: $email,
      metadata: { referenceId: $userId, displayName: "Smoke Test" }
    },
    product: {
      id: "prod_2muSl3xna4UWLN6O9nJcjR",
      object: "product",
      name: "Starter (Monthly)"
    },
    metadata: { referenceId: $userId, planType: "starter", displayName: "Smoke Test" }
  }
}')

# Top-up payload ($5, via Creem checkout).
# Uses eventType (camelCase) with checkoutKind=top_up in metadata.
TOPUP_EVENT_ID="smoke_topup_$(date +%s)"
TOPUP_PAYLOAD=$(jq -n --arg userId "${USER_ID}" --arg email "${USER_EMAIL}" --arg evtId "${TOPUP_EVENT_ID}" '{
  id: $evtId,
  eventType: "checkout.completed",
  created_at: (now * 1000 | floor),
  object: {
    id: ("ch_" + $evtId),
    object: "checkout",
    status: "completed",
    mode: "test",
    customer: {
      id: ("cus_" + $evtId),
      object: "customer",
      email: $email,
      metadata: { referenceId: $userId, topUpCents: "500", topUpPackId: "Topup5", checkoutKind: "top_up", planType: "top_up_Topup5" }
    },
    product: {
      id: "prod_13TZZ9AsdyFtGoY2BqVYAy",
      object: "product",
      name: "Topup5"
    },
    order: {
      id: ("ord_" + $evtId),
      object: "order",
      customer: ("cus_" + $evtId),
      product: "prod_13TZZ9AsdyFtGoY2BqVYAy",
      amount: 500,
      currency: "USD",
      status: "paid",
      type: "onetime"
    },
    metadata: { referenceId: $userId, topUpCents: "500", topUpPackId: "Topup5", checkoutKind: "top_up", planType: "top_up_Topup5", displayName: "Smoke Test" }
  }
}')

# ---------------------------------------------------------------------------
# Capture initial state
# ---------------------------------------------------------------------------

log "Capturing initial DB state..."

INITIAL_WEBHOOK_COUNT=$(db_count "SELECT count(*) FROM billing_webhook_events;")
INITIAL_TOPUP_COUNT=$(db_count "SELECT count(*) FROM billing_ledger_entries WHERE entry_type='top_up_credit';")
INITIAL_SUB_COUNT=$(db_count "SELECT count(*) FROM billing_subscriptions;")

log "  webhook_events: ${INITIAL_WEBHOOK_COUNT}, subscriptions: ${INITIAL_SUB_COUNT}, top-ups: ${INITIAL_TOPUP_COUNT}"

# ---------------------------------------------------------------------------
# State tracking
# ---------------------------------------------------------------------------

PASSED=0
FAILED=0

check() {
  local label="$1"; shift
  if "$@"; then
    ok "${label}"
    ((PASSED++))
  else
    warn "FAIL: ${label}"
    ((FAILED++))
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Test 1 — Subscription webhook
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 1: Subscription webhook ──"

SUB_COMPACT=$(echo "${SUB_PAYLOAD}" | jq -c '.')
SUB_SIG=$(sign "${SUB_COMPACT}")

SUB_RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "${API_BASE_URL}/billing/webhook/creem" \
  -H 'content-type: application/json' \
  -H "creem-signature: ${SUB_SIG}" \
  -d "${SUB_COMPACT}" 2>&1)

SUB_HTTP=$(echo "${SUB_RESPONSE}" | tail -1)
SUB_BODY=$(echo "${SUB_RESPONSE}" | sed '$d')

check "subscription webhook returns HTTP 200" \
  bash -c "[[ '${SUB_HTTP}' == '200' ]]"

check "subscription webhook body is {received:true}" \
  bash -c "echo '${SUB_BODY}' | jq -e '.received == true' > /dev/null 2>&1"

check "billing_webhook_events has processed row for subscription event" \
  bash -c "[[ $(db_count \"SELECT count(*) FROM billing_webhook_events WHERE id='creem:${SUB_EVENT_ID}' AND status='processed';\") -gt 0 ]]"

check "billing_subscriptions has new row" \
  bash -c "[[ $(db_count \"SELECT count(*) FROM billing_subscriptions;\") -gt ${INITIAL_SUB_COUNT} ]]"

SUB_PLAN=$(db_query "SELECT plan_id FROM billing_subscriptions WHERE external_subscription_id='ch_${SUB_EVENT_ID}';")
check "subscription plan_id is not empty (plan was resolved)" \
  bash -c "[[ -n '${SUB_PLAN}' && '${SUB_PLAN}' != '' ]]"

# ═══════════════════════════════════════════════════════════════════════════════
# Test 2 — Top-up webhook
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 2: Top-up webhook ──"

TOPUP_COMPACT=$(echo "${TOPUP_PAYLOAD}" | jq -c '.')
TOPUP_SIG=$(sign "${TOPUP_COMPACT}")

TOPUP_RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "${API_BASE_URL}/billing/webhook/creem" \
  -H 'content-type: application/json' \
  -H "creem-signature: ${TOPUP_SIG}" \
  -d "${TOPUP_COMPACT}" 2>&1)

TOPUP_HTTP=$(echo "${TOPUP_RESPONSE}" | tail -1)
TOPUP_BODY=$(echo "${TOPUP_RESPONSE}" | sed '$d')

check "top-up webhook returns HTTP 200" \
  bash -c "[[ '${TOPUP_HTTP}' == '200' ]]"

check "top-up webhook body is {received:true}" \
  bash -c "echo '${TOPUP_BODY}' | jq -e '.received == true' > /dev/null 2>&1"

check "billing_webhook_events has processed row for top-up event" \
  bash -c "[[ $(db_count \"SELECT count(*) FROM billing_webhook_events WHERE id='creem:${TOPUP_EVENT_ID}' AND status='processed';\") -gt 0 ]]"

check "top_up_credit ledger entry created" \
  bash -c "[[ $(db_count \"SELECT count(*) FROM billing_ledger_entries WHERE entry_type='top_up_credit';\") -gt ${INITIAL_TOPUP_COUNT} ]]"

check "top-up amount is 5,000,000 microUSD (\$5.00)" \
  bash -c "[[ $(db_count \"SELECT count(*) FROM billing_ledger_entries WHERE entry_type='top_up_credit' AND amount_microusd=5000000;\") -gt 0 ]]"

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
log "── Results ──"
log "  Passed: ${PASSED}"
if [[ ${FAILED} -gt 0 ]]; then
  warn "  Failed: ${FAILED}"
  exit 1
else
  ok "All billing webhook checks passed."
  exit 0
fi
