#!/usr/bin/env bash
# rollout-stage-c.sh — Stage C: Fail-closed verification of recovery, rotation, and reconciliation.
#
# This is a pass/fail verifier, not a best-effort smoke helper.
# It exits non-zero on any blocking condition.
#
# Verifies the following against a running live/shadow instance (from Stage B):
#   1. Actor restart/recovery — forces stop+start and confirms the instance
#      returns to running with fresh reconciliation (timestamp advanced).
#   2. Credential rotation — rotates via POST /credentials/:id/rotate,
#      validates the response structure, and confirms audit trail.
#   3. Reconciliation and audit evidence — time-aware checks that post-rotation
#      credential.decrypted events exist for the exact instance.
#
# Follows the operator checklist:
#   docs/features/2026/05/initial/016-phase-4-stage-c-operator-checklist.md
#
# Prerequisites:
#   - Stage B instance running (or any live/shadow instance in the DB)
#   - API server accessible at $API_URL
#   - Environment vars: CREDENTIAL_ENCRYPTION_KEY
#   - Rotation secrets: ROTATE_API_KEY, ROTATE_SECRET, ROTATE_WALLET_ADDRESS
#     (falls back to HYPERLIQUID_API_KEY, HYPERLIQUID_SECRET, HYPERLIQUID_ACCOUNT_ADDRESS)
#
# Usage:
#   ./scripts/shell/rollout/rollout-stage-c.sh <instance-id>
#   ./scripts/shell/rollout/rollout-stage-c.sh <instance-id> --skip-restart
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$SCRIPT_DIR/../../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

API_PORT="${API_PORT:-3000}"
API_URL="http://localhost:${API_PORT}"
SKIP_RESTART="${2:-}"
POLL_INTERVAL=5
POLL_TIMEOUT=120  # max seconds to wait for readiness

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[stage-c]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓ stage-c]${NC} $1"; }
warn() { echo -e "${YELLOW}[stage-c]${NC} $1"; }
die()  { echo -e "${RED}[✗ stage-c]${NC} $1" >&2; exit 1; }

PASS_COUNT=0
pass() { ok "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }

# --- Validate args ---
INSTANCE_ID="${1:-}"
[[ -z "$INSTANCE_ID" ]] && die "Usage: $0 <instance-id> [--skip-restart]"
[[ -z "${CREDENTIAL_ENCRYPTION_KEY:-}" ]] && die "CREDENTIAL_ENCRYPTION_KEY not set"

# Rotation secrets: prefer ROTATE_* (allows rotating to different keys),
# fall back to HYPERLIQUID_* for same-key rotation testing.
ROTATE_API_KEY="${ROTATE_API_KEY:-${HYPERLIQUID_API_KEY:-}}"
ROTATE_SECRET="${ROTATE_SECRET:-${HYPERLIQUID_SECRET:-}}"
ROTATE_WALLET_ADDRESS="${ROTATE_WALLET_ADDRESS:-${HYPERLIQUID_ACCOUNT_ADDRESS:-}}"
[[ -z "$ROTATE_API_KEY" ]] && die "ROTATE_API_KEY (or HYPERLIQUID_API_KEY) not set"
[[ -z "$ROTATE_SECRET" ]] && die "ROTATE_SECRET (or HYPERLIQUID_SECRET) not set"
[[ -z "$ROTATE_WALLET_ADDRESS" ]] && die "ROTATE_WALLET_ADDRESS (or HYPERLIQUID_ACCOUNT_ADDRESS) not set"

# --- Require jq ---
command -v jq >/dev/null 2>&1 || die "jq is required but not installed"

# --- Check API is up ---
curl -sf "$API_URL/health" >/dev/null 2>&1 || die "API not responding at $API_URL"

# --- Verify instance exists ---
INST_DATA=$(curl -sf "$API_URL/instances/$INSTANCE_ID" 2>/dev/null || echo '')
[[ -z "$INST_DATA" ]] && die "Instance $INSTANCE_ID not found"

INST_STATUS=$(echo "$INST_DATA" | jq -r '.status')
[[ "$INST_STATUS" == "crashed" ]] && die "Instance is in crashed state — cannot proceed"
[[ "$INST_STATUS" != "running" ]] && die "Instance must already be running for Stage C (current status=$INST_STATUS)"
ok "Instance found: $INSTANCE_ID (status=$INST_STATUS)"

echo ""
echo "=== STAGE C — FAIL-CLOSED VERIFICATION ==="
echo ""

# --- Helper: poll until instance is running with reconciliation after a timestamp ---
# Uses status + lastReconciliation.timestamp + reconciliation event count as the
# readiness signal. For restart/rotation flows we require two post-boundary
# reconciliation events because the old actor can still persist one in-flight
# pass after stop; the second event must come from the restarted actor.
wait_for_reconciliation_after() {
  local after_ts="$1"
  local min_recon_events="${2:-1}"
  local elapsed=0
  local last_status="unknown"
  local last_recon="none"
  local fresh_recon_count=0
  while [[ $elapsed -lt $POLL_TIMEOUT ]]; do
    local status_resp
    local recon_resp
    status_resp=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
    recon_resp=$(curl -sf "$API_URL/instances/$INSTANCE_ID/reconciliation-events?limit=10" 2>/dev/null || echo '{"events":[]}')
    last_status=$(curl -sf "$API_URL/instances/$INSTANCE_ID" 2>/dev/null | jq -r '.status // "unknown"')
    last_recon=$(echo "$status_resp" | jq -r '.lastReconciliation.timestamp // "none"')
    fresh_recon_count=$(echo "$recon_resp" | jq -r --arg after "$after_ts" '[.events[] | select(.createdAt > $after)] | length')
    if [[ "$last_status" == "running" && "$last_recon" != "none" && "$last_recon" > "$after_ts" ]]; then
      if [[ "$fresh_recon_count" -ge "$min_recon_events" ]]; then
        return 0
      fi
    fi
    log "  $(date '+%H:%M:%S') waiting for running + fresh recon (status=$last_status, recon=$last_recon, eventsAfter=$fresh_recon_count/$min_recon_events, need>$after_ts, ${elapsed}s)"
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  die "Timed out waiting for instance ready after ${POLL_TIMEOUT}s (status=$last_status, lastRecon=$last_recon, eventsAfter=$fresh_recon_count/$min_recon_events, required after=$after_ts)"
}

# ============================================================
# TEST 1: Actor restart and recovery
# ============================================================
if [[ "$SKIP_RESTART" != "--skip-restart" ]]; then
  log "TEST 1: Actor restart and recovery"
  log "  Capturing pre-restart state..."

  PRE_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
  PRE_FILLS=$(echo "$PRE_STATUS" | jq -r '(.recentFills // []) | length')
  PRE_RECON_TS=$(echo "$PRE_STATUS" | jq -r '.lastReconciliation.timestamp // "none"')

  ok "  Pre-restart: fills=$PRE_FILLS lastRecon=$PRE_RECON_TS"

  log "  Stopping instance..."
  curl -sf -X POST "$API_URL/instances/$INSTANCE_ID/stop" >/dev/null 2>&1
  sleep 3

  # Read the observed lastReconciliation.timestamp AFTER the stop sleep.
  # This is deterministic: whatever the old actor persisted (including any stale
  # in-flight pass that completed during shutdown) IS the boundary. The new actor
  # must produce a reconciliation strictly after this value.
  RESTART_BOUNDARY=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null \
    | jq -r '.lastReconciliation.timestamp // "1970-01-01T00:00:00.000Z"')

  log "  Restarting instance..."
  curl -sf -X POST "$API_URL/instances/$INSTANCE_ID/start" >/dev/null 2>&1

  log "  Polling for running + two post-boundary reconciliation events after $RESTART_BOUNDARY..."
  wait_for_reconciliation_after "$RESTART_BOUNDARY" 2

  # Read post-restart state
  POST_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
  POST_RECON_TS=$(echo "$POST_STATUS" | jq -r '.lastReconciliation.timestamp // "none"')
  POST_MODE=$(echo "$POST_STATUS" | jq -r '.executionMode // "unknown"')

  if [[ "$POST_RECON_TS" == "none" ]]; then
    die "Reconciliation did not run after restart (timestamp is still 'none')"
  fi
  if [[ "$POST_RECON_TS" == "$PRE_RECON_TS" ]]; then
    die "Reconciliation timestamp did not advance after restart (pre=$PRE_RECON_TS post=$POST_RECON_TS)"
  fi
  pass "Reconciliation ran after restart: $POST_RECON_TS"

  # Verify mode preserved
  if [[ "$POST_MODE" == "live" || "$POST_MODE" == "shadow" ]]; then
    pass "Instance resumed in $POST_MODE mode after restart"
  else
    die "Instance mode after restart: $POST_MODE (expected: live or shadow)"
  fi

  # Check journal for recovery events (informational — zero is OK if no pending orders)
  RECOVERY_COUNT=$(curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=order.completion_recovered&limit=5" 2>/dev/null \
    | jq '(.events // []) | length' 2>/dev/null || echo "0")
  log "  Recovery events in journal: $RECOVERY_COUNT (zero is acceptable if no pending orders)"
  echo ""
else
  log "TEST 1: Skipped (--skip-restart)"
  echo ""
fi

# ============================================================
# TEST 2: Resolve credential ID via venue-accounts list
# ============================================================
log "TEST 2: Resolving linked credential"

VENUE_ACCOUNT_ID=$(echo "$INST_DATA" | jq -r '.venueAccountId // empty')
[[ -z "$VENUE_ACCOUNT_ID" ]] && die "Instance has no venueAccountId — cannot resolve credential"

# The API only exposes GET /venue-accounts (list), not GET /venue-accounts/:id
CREDENTIAL_ID=$(curl -sf "$API_URL/venue-accounts" 2>/dev/null \
  | jq -r --arg id "$VENUE_ACCOUNT_ID" '.venueAccounts[] | select(.id == $id) | .credentialId // empty')

[[ -z "$CREDENTIAL_ID" ]] && die "Could not resolve credentialId for venueAccount=$VENUE_ACCOUNT_ID"
pass "Resolved credential: $CREDENTIAL_ID (via venueAccount=$VENUE_ACCOUNT_ID)"
echo ""

# ============================================================
# TEST 3: Credential rotation (POST, fail-closed)
# ============================================================
log "TEST 3: Credential rotation"

# Real millisecond-precision timestamp to match API format and avoid
# lexicographic comparison bugs or same-second false matches.
ROTATION_STARTED_AT=$(python3 -c "from datetime import datetime,timezone;print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]+'Z')" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%S.000Z)
log "  Rotation window starts at: $ROTATION_STARTED_AT"
log "  Rotating credential $CREDENTIAL_ID via POST..."

# Confirm instance is running at rotation time (needed for dependents assertion)
ROT_TIME_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID" 2>/dev/null | jq -r '.status // "unknown"')

ROTATE_BODY=$(jq -n \
  --arg apiKey "$ROTATE_API_KEY" \
  --arg secret "$ROTATE_SECRET" \
  --arg walletAddress "$ROTATE_WALLET_ADDRESS" \
  '{secrets:{apiKey:$apiKey, secret:$secret, walletAddress:$walletAddress}}')

ROTATE_RESPONSE=$(curl -sf -X POST "$API_URL/credentials/$CREDENTIAL_ID/rotate" \
  -H "Content-Type: application/json" \
  -d "$ROTATE_BODY" 2>/dev/null || echo "")

[[ -z "$ROTATE_RESPONSE" ]] && die "Rotation API call returned empty response (is the endpoint accessible?)"

# Parse and validate rotation response
ROTATE_STATUS=$(echo "$ROTATE_RESPONSE" | jq -r '.status // "unknown"')
ROTATE_ERROR_CODE=$(echo "$ROTATE_RESPONSE" | jq -r '.restartErrorCode // empty')
ROTATE_ERROR=$(echo "$ROTATE_RESPONSE" | jq -r '.restartError // empty')
ROTATE_DEPENDENTS=$(echo "$ROTATE_RESPONSE" | jq -r '.dependentTradingInstanceIds // []')
ROTATE_RESTARTED=$(echo "$ROTATE_RESPONSE" | jq -r '.restartedTradingInstanceIds // []')

# Fail-closed: status must be "rotated"
[[ "$ROTATE_STATUS" != "rotated" ]] && die "Rotation failed: status=$ROTATE_STATUS (expected: rotated)"
pass "Credential rotation succeeded (status=rotated)"

# Fail-closed: restartErrorCode must be absent
if [[ -n "$ROTATE_ERROR_CODE" ]]; then
  die "Rotation restart failed: errorCode=$ROTATE_ERROR_CODE error=$ROTATE_ERROR"
fi
pass "No restart error after rotation"

# Verify instance is in dependents and was restarted.
# Fail-closed when the instance was confirmed running at rotation time.
INST_IN_DEPENDENTS=$(echo "$ROTATE_DEPENDENTS" | jq --arg id "$INSTANCE_ID" 'map(select(. == $id)) | length')
if [[ "$INST_IN_DEPENDENTS" -eq 0 ]]; then
  if [[ "$ROT_TIME_STATUS" == "running" ]]; then
    die "Instance $INSTANCE_ID was running but missing from dependentTradingInstanceIds"
  else
    warn "  Instance $INSTANCE_ID not in dependentTradingInstanceIds (status=$ROT_TIME_STATUS at rotation time)"
  fi
else
  pass "Instance is in dependentTradingInstanceIds"
fi

# Verify instance was restarted
INST_IN_RESTARTED=$(echo "$ROTATE_RESTARTED" | jq --arg id "$INSTANCE_ID" 'map(select(. == $id)) | length')
if [[ "$INST_IN_RESTARTED" -eq 0 ]]; then
  if [[ "$ROT_TIME_STATUS" == "running" ]]; then
    die "Instance $INSTANCE_ID was running but missing from restartedTradingInstanceIds"
  else
    warn "  Instance $INSTANCE_ID not in restartedTradingInstanceIds (status=$ROT_TIME_STATUS at rotation time)"
  fi
else
  pass "Instance is in restartedTradingInstanceIds"
fi

echo ""

# ============================================================
# TEST 4: Post-rotation readiness (poll, fail-closed)
# ============================================================
log "TEST 4: Post-rotation readiness"

# The rotation route only enqueues restart jobs (BullMQ) and returns immediately.
# The old actor may still be running and reconciling. Sleep to let the old actor
# wind down, then read the observed lastReconciliation.timestamp as the boundary.
# This is deterministic: whatever the old actor persisted IS the boundary.
sleep 3
POST_ROT_BOUNDARY=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null \
  | jq -r '.lastReconciliation.timestamp // "1970-01-01T00:00:00.000Z"')

log "  Polling for running + fresh reconciliation after $POST_ROT_BOUNDARY..."

# Poll for a concrete signal: the instance is running AND has reconciled strictly
# after the observed boundary. Require two post-boundary reconciliation events so
# a single stale in-flight pass from the old actor cannot satisfy the verifier.
wait_for_reconciliation_after "$POST_ROT_BOUNDARY" 2

# Read final state and execution mode (needed for verdict logic)
POST_ROT_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
POST_ROT_RECON_TS=$(echo "$POST_ROT_STATUS" | jq -r '.lastReconciliation.timestamp // "none"')
EXECUTION_MODE=$(echo "$POST_ROT_STATUS" | jq -r '.executionMode // "unknown"')
pass "Reconciliation resumed after rotation: $POST_ROT_RECON_TS (mode=$EXECUTION_MODE)"
echo ""

# ============================================================
# TEST 5: Time-aware credential audit trail
# ============================================================
log "TEST 5: Post-rotation audit evidence"

# Check credential.rotated event for this specific credential
ROTATED_EVENTS=$(curl -sf "$API_URL/journal?type=credential.rotated&limit=20" 2>/dev/null || echo '{"events":[]}')
ROTATED_FOR_CRED=$(echo "$ROTATED_EVENTS" | jq --arg cred "$CREDENTIAL_ID" --arg after "$ROTATION_STARTED_AT" \
  '[.events[] | select(.payload.credentialId == $cred and .createdAt >= $after)] | length')

if [[ "$ROTATED_FOR_CRED" -gt 0 ]]; then
  pass "credential.rotated event found for credential $CREDENTIAL_ID after $ROTATION_STARTED_AT"
else
  die "No credential.rotated event found for credential $CREDENTIAL_ID after rotation window"
fi

# Check credential.decrypted event for this instance after rotation.
# Must match the exact credentialId AND outcome=success — a failed decrypt
# (e.g. missing encryption key) must not produce a false pass.
DECRYPTED_EVENTS=$(curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=credential.decrypted&limit=20" 2>/dev/null || echo '{"events":[]}')
DECRYPTED_AFTER_ROT=$(echo "$DECRYPTED_EVENTS" | jq --arg after "$ROTATION_STARTED_AT" --arg cred "$CREDENTIAL_ID" \
  '[.events[] | select(.createdAt >= $after and .payload.credentialId == $cred and .payload.outcome == "success")] | length')

if [[ "$DECRYPTED_AFTER_ROT" -gt 0 ]]; then
  pass "credential.decrypted (outcome=success) for credential $CREDENTIAL_ID after rotation ($DECRYPTED_AFTER_ROT events)"
else
  die "No successful credential.decrypted event for credential $CREDENTIAL_ID on instance $INSTANCE_ID after rotation window — credential may not have been reloaded"
fi

# Check credential.used (informational — market activity dependent)
USED_EVENTS=$(curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=credential.used&limit=20" 2>/dev/null || echo '{"events":[]}')
USED_AFTER_ROT=$(echo "$USED_EVENTS" | jq --arg after "$ROTATION_STARTED_AT" \
  '[.events[] | select(.createdAt >= $after)] | length')

if [[ "$USED_AFTER_ROT" -gt 0 ]]; then
  pass "credential.used event found after rotation ($USED_AFTER_ROT events)"
else
  warn "  No credential.used event after rotation (acceptable if no orders triggered yet)"
fi
echo ""

# ============================================================
# TEST 6: Reconciliation evidence (current route)
# ============================================================
log "TEST 6: Reconciliation evidence"

RECON_EVENTS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/reconciliation-events?limit=10" 2>/dev/null || echo '{"events":[]}')
RECON_COUNT=$(echo "$RECON_EVENTS" | jq '(.events // []) | length')

if [[ "$RECON_COUNT" -gt 0 ]]; then
  pass "Reconciliation events found: $RECON_COUNT"
  LATEST_RECON=$(echo "$RECON_EVENTS" | jq -r '(.events // [])[0] | "\(.result // .payload.status) at \(.createdAt)"')
  log "  Latest: $LATEST_RECON"
else
  die "No reconciliation events found — reconciliation is not running"
fi
echo ""

# ============================================================
# TEST 7: Slippage monitoring (informational)
# ============================================================
log "TEST 7: Slippage monitoring"

LIVE_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
SLIP_ALERTS=$(echo "$LIVE_STATUS" | jq '(.slippageAlerts // []) | length')

if [[ "$SLIP_ALERTS" -gt 0 ]]; then
  warn "  Slippage alerts detected: $SLIP_ALERTS (review needed)"
else
  ok "  No slippage alerts"
fi
echo ""

# ============================================================
# Summary
# ============================================================
echo ""
echo "=== Stage C Verification Summary ==="
echo ""
echo "  Instance:            $INSTANCE_ID"
echo "  Credential:          $CREDENTIAL_ID"
echo "  Rotation window:     $ROTATION_STARTED_AT"
echo "  Restart test:        $(if [[ "$SKIP_RESTART" == "--skip-restart" ]]; then echo "skipped"; else echo "PASS"; fi)"
echo "  Rotation test:       PASS (status=rotated, no restartErrorCode)"
echo "  Post-rotation recon: PASS ($POST_ROT_RECON_TS)"
echo "  Audit trail:         rotated=$ROTATED_FOR_CRED decrypted=$DECRYPTED_AFTER_ROT used=$USED_AFTER_ROT"
echo "  Reconciliation:      $RECON_COUNT events"
echo "  Slippage alerts:     $SLIP_ALERTS"
echo "  Checks passed:       $PASS_COUNT"
echo ""
if [[ "$EXECUTION_MODE" == "shadow" ]]; then
  echo "  Stage C: PASS (shadow mode — credential.used is N/A)"
elif [[ "$USED_AFTER_ROT" -gt 0 ]]; then
  echo "  Stage C: PASS"
else
  echo "  Stage C: INCOMPLETE (restart + rotation verified, but no post-rotation live order observed yet)"
fi
echo ""
echo "Evidence commands:"
echo "  curl -s $API_URL/journal?tradingInstanceId=$INSTANCE_ID | jq"
echo "  curl -s $API_URL/instances/$INSTANCE_ID/live-status | jq"
echo "  curl -s $API_URL/instances/$INSTANCE_ID/reconciliation-events | jq"
echo ""
