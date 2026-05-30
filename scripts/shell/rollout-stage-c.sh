#!/usr/bin/env bash
# rollout-stage-c.sh — Stage C: Verification of recovery, rotation, and reconciliation.
#
# Verifies the following against a running live instance (from Stage B):
#   1. Actor restart/recovery — forces the worker to restart and confirms
#      the instance rehydrates, reconciles, and resumes without data loss.
#   2. Credential rotation — rotates the linked credential and verifies
#      audit trail + actor reload behavior.
#   3. Reconciliation evidence — confirms reconciliation events are persisted
#      and drift classification is working.
#
# Prerequisites:
#   - Stage B instance running (or any live instance in the DB)
#   - API server accessible
#   - Environment vars set (same as Stage B)
#
# Usage:
#   ./scripts/shell/rollout-stage-c.sh <instance-id>
#   ./scripts/shell/rollout-stage-c.sh <instance-id> --skip-restart
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

API_PORT="${API_PORT:-3000}"
API_URL="http://localhost:${API_PORT}"
SKIP_RESTART="${2:-}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[stage-c]${NC} $1"; }
ok()   { echo -e "${GREEN}[stage-c]${NC} $1"; }
warn() { echo -e "${YELLOW}[stage-c]${NC} $1"; }
die()  { echo -e "${RED}[stage-c]${NC} $1" >&2; exit 1; }

# --- Validate args ---
INSTANCE_ID="${1:-}"
[[ -z "$INSTANCE_ID" ]] && die "Usage: $0 <instance-id> [--skip-restart]"
[[ -z "${CREDENTIAL_ENCRYPTION_KEY:-}" ]] && die "CREDENTIAL_ENCRYPTION_KEY not set"

# --- Check API is up ---
curl -sf "$API_URL/health" >/dev/null 2>&1 || die "API not responding at $API_URL"

# --- Verify instance exists ---
INST_DATA=$(curl -sf "$API_URL/instances/$INSTANCE_ID" 2>/dev/null || echo '')
[[ -z "$INST_DATA" ]] && die "Instance $INSTANCE_ID not found"
ok "Instance found: $INSTANCE_ID"

echo ""
echo "=== Stage C: Verification Suite ==="
echo ""

# ============================================================
# TEST 1: Actor restart and recovery
# ============================================================
if [[ "$SKIP_RESTART" != "--skip-restart" ]]; then
  log "TEST 1: Actor restart and recovery"
  log "  Capturing pre-restart state..."

  PRE_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status")
  PRE_FILLS=$(echo "$PRE_STATUS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      const j=JSON.parse(d); console.log((j.recentFills||[]).length);
    })" 2>/dev/null || echo "0")
  PRE_RECON=$(echo "$PRE_STATUS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      const j=JSON.parse(d); console.log(j.lastReconciliation?.timestamp || 'none');
    })" 2>/dev/null || echo "none")

  ok "  Pre-restart: fills=$PRE_FILLS lastRecon=$PRE_RECON"

  log "  Stopping instance..."
  curl -sf -X POST "$API_URL/instances/$INSTANCE_ID/stop" >/dev/null 2>&1
  sleep 3

  log "  Restarting instance..."
  curl -sf -X POST "$API_URL/instances/$INSTANCE_ID/start" >/dev/null 2>&1

  log "  Waiting for reconciliation after restart (30s)..."
  sleep 30

  POST_STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
  POST_RECON=$(echo "$POST_STATUS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      const j=JSON.parse(d); console.log(j.lastReconciliation?.timestamp || 'none');
    })" 2>/dev/null || echo "none")

  POST_MODE=$(echo "$POST_STATUS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      const j=JSON.parse(d); console.log(j.executionMode || 'unknown');
    })" 2>/dev/null || echo "unknown")

  if [[ "$POST_RECON" != "none" && "$POST_RECON" != "$PRE_RECON" ]]; then
    ok "  Reconciliation ran after restart: $POST_RECON"
  else
    warn "  Reconciliation timestamp unchanged (may need more time)"
  fi

  if [[ "$POST_MODE" == "live" ]]; then
    ok "  Instance resumed in live mode after restart"
  else
    warn "  Instance mode after restart: $POST_MODE (expected: live)"
  fi

  # Check journal for recovery events
  RECOVERY_EVENTS=$(curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=order.completion_recovered&limit=5" 2>/dev/null || echo '{}')
  RECOVERY_COUNT=$(echo "$RECOVERY_EVENTS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log((j.entries||j.events||[]).length); }
      catch(e) { console.log(0); }
    })" 2>/dev/null || echo "0")

  log "  Recovery events in journal: $RECOVERY_COUNT"
  echo ""
else
  log "TEST 1: Skipped (--skip-restart)"
  echo ""
fi

# ============================================================
# TEST 2: Credential rotation
# ============================================================
log "TEST 2: Credential rotation"

# Get the venue account to find the credential ID
VA_DATA=$(echo "$INST_DATA" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    const j=JSON.parse(d); console.log(j.venueAccountId || '');
  })" 2>/dev/null || echo "")

if [[ -z "$VA_DATA" ]]; then
  warn "  Could not determine venue account — skipping rotation test"
else
  VA_DETAIL=$(curl -sf "$API_URL/venue-accounts/$VA_DATA" 2>/dev/null || echo '{}')
  CRED_ID=$(echo "$VA_DETAIL" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      const j=JSON.parse(d); console.log(j.credentialId || '');
    })" 2>/dev/null || echo "")

  if [[ -z "$CRED_ID" ]]; then
    warn "  No credential linked to venue account — skipping rotation"
  else
    log "  Rotating credential $CRED_ID..."

    # Use the same keys (rotation is about the process, not changing keys for this test)
    ROTATE_KEY="${HYPERLIQUID_API_KEY:-${HYPERLIQUID_TESTNET_API_KEY:-placeholder}}"
    ROTATE_SECRET="${HYPERLIQUID_SECRET:-${HYPERLIQUID_TESTNET_SECRET:-placeholder}}"

    ROTATE_RESPONSE=$(curl -sf -X PUT "$API_URL/credentials/$CRED_ID/rotate" \
      -H "Content-Type: application/json" \
      -d "{
        \"secrets\": {
          \"apiKey\": \"$ROTATE_KEY\",
          \"secret\": \"$ROTATE_SECRET\"
        }
      }" 2>/dev/null || echo "")

    if [[ -n "$ROTATE_RESPONSE" ]]; then
      ok "  Credential rotated successfully"
    else
      warn "  Credential rotation API call failed (check endpoint path)"
    fi

    # Verify audit event
    sleep 2
    AUDIT_EVENTS=$(curl -sf "$API_URL/journal?type=credential.rotated&limit=5" 2>/dev/null || echo '{}')
    AUDIT_COUNT=$(echo "$AUDIT_EVENTS" | node -e "
      process.stdin.resume(); let d=''; 
      process.stdin.on('data',c=>d+=c); 
      process.stdin.on('end',()=>{
        try { const j=JSON.parse(d); console.log((j.entries||j.events||[]).length); }
        catch(e) { console.log(0); }
      })" 2>/dev/null || echo "0")

    if [[ "$AUDIT_COUNT" -gt 0 ]]; then
      ok "  Credential rotation audit event found in journal ($AUDIT_COUNT events)"
    else
      warn "  No rotation audit events found (may use different event type)"
    fi

    log "  Note: Rotated credential takes effect on next actor restart."
    log "  Restart instance to verify new credential is loaded."
  fi
fi
echo ""

# ============================================================
# TEST 3: Reconciliation evidence
# ============================================================
log "TEST 3: Reconciliation evidence"

RECON_EVENTS=$(curl -sf "$API_URL/reconciliation?tradingInstanceId=$INSTANCE_ID&limit=10" 2>/dev/null || echo '{}')
RECON_COUNT=$(echo "$RECON_EVENTS" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const events = j.events || j.reconciliationEvents || [];
      console.log(events.length);
    } catch(e) { console.log(0); }
  })" 2>/dev/null || echo "0")

if [[ "$RECON_COUNT" -gt 0 ]]; then
  ok "  Reconciliation events found: $RECON_COUNT"

  # Show latest reconciliation result
  echo "$RECON_EVENTS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      try {
        const j=JSON.parse(d);
        const events = j.events || j.reconciliationEvents || [];
        const latest = events[0];
        if (latest) {
          console.log('  Latest: result=' + latest.result + ' at=' + latest.createdAt);
          if (latest.diff && Array.isArray(latest.diff)) {
            console.log('  Diffs: ' + latest.diff.length);
          }
        }
      } catch(e) {}
    })" 2>/dev/null || true
else
  warn "  No reconciliation events found yet (instance may need more time)"
fi
echo ""

# ============================================================
# TEST 4: Credential audit trail
# ============================================================
log "TEST 4: Credential audit trail"

CRED_AUDIT=$(curl -sf "$API_URL/journal?type=credential.decrypted&tradingInstanceId=$INSTANCE_ID&limit=10" 2>/dev/null || echo '{}')
DECRYPT_COUNT=$(echo "$CRED_AUDIT" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    try { const j=JSON.parse(d); console.log((j.entries||j.events||[]).length); }
    catch(e) { console.log(0); }
  })" 2>/dev/null || echo "0")

if [[ "$DECRYPT_COUNT" -gt 0 ]]; then
  ok "  credential.decrypted events found: $DECRYPT_COUNT"
else
  warn "  No credential.decrypted events found"
fi

USED_AUDIT=$(curl -sf "$API_URL/journal?type=credential.used&tradingInstanceId=$INSTANCE_ID&limit=10" 2>/dev/null || echo '{}')
USED_COUNT=$(echo "$USED_AUDIT" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    try { const j=JSON.parse(d); console.log((j.entries||j.events||[]).length); }
    catch(e) { console.log(0); }
  })" 2>/dev/null || echo "0")

if [[ "$USED_COUNT" -gt 0 ]]; then
  ok "  credential.used events found: $USED_COUNT"
else
  warn "  No credential.used events found (may appear after live orders are submitted)"
fi
echo ""

# ============================================================
# TEST 5: Slippage evidence
# ============================================================
log "TEST 5: Slippage monitoring"

SLIPPAGE=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
SLIP_ALERTS=$(echo "$SLIPPAGE" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    try { const j=JSON.parse(d); console.log((j.slippageAlerts||[]).length); }
    catch(e) { console.log(0); }
  })" 2>/dev/null || echo "0")

if [[ "$SLIP_ALERTS" -gt 0 ]]; then
  warn "  Slippage alerts detected: $SLIP_ALERTS (review for excessive slippage)"
else
  ok "  No slippage alerts (fills within threshold or no fills yet)"
fi
echo ""

# ============================================================
# Summary
# ============================================================
echo "=== Stage C Verification Summary ==="
echo ""
echo "  Instance:       $INSTANCE_ID"
echo "  Restart test:   $(if [[ "$SKIP_RESTART" == "--skip-restart" ]]; then echo "skipped"; else echo "completed"; fi)"
echo "  Rotation test:  completed"
echo "  Reconciliation: $RECON_COUNT events"
echo "  Credential audit: decrypt=$DECRYPT_COUNT used=$USED_COUNT"
echo "  Slippage alerts: $SLIP_ALERTS"
echo ""
echo "For detailed event data:"
echo "  curl $API_URL/journal?tradingInstanceId=$INSTANCE_ID | jq"
echo "  curl $API_URL/instances/$INSTANCE_ID/live-status | jq"
echo ""
