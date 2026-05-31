#!/usr/bin/env bash
# rollout-stage-a.sh — Stage A: Hyperliquid testnet sandbox smoke test.
#
# Validates the live executor code path against non-production credentials.
# This script:
#   1. Starts infrastructure (Postgres + Redis via docker compose)
#   2. Builds packages and runs DB migrations
#   3. Starts API server + worker in background
#   4. Creates DB credential (testnet API key/secret)
#   5. Creates venue account + portfolio + trading instance (live mode)
#   6. Starts the instance and monitors for fills via live-status API
#   7. Stops and reports results
#
# Prerequisites:
#   export CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
#   export HYPERLIQUID_TESTNET_API_KEY=<your-testnet-key>
#   export HYPERLIQUID_TESTNET_SECRET=<your-testnet-secret>
#
# Usage:
#   ./scripts/shell/rollout/rollout-stage-a.sh
#
# Credentials:
#   Obtain testnet credentials at https://app.hyperliquid-testnet.xyz
#   → Connect wallet → API → Generate API key
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
SYMBOL="${ROLLOUT_SYMBOL:-ETH/USD:USD}"
MAX_WAIT_FILLS_SEC="${MAX_WAIT_FILLS_SEC:-120}"
USER_ID="rollout-operator"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[stage-a]${NC} $1"; }
ok()   { echo -e "${GREEN}[stage-a]${NC} $1"; }
warn() { echo -e "${YELLOW}[stage-a]${NC} $1"; }
die()  { echo -e "${RED}[stage-a]${NC} $1" >&2; exit 1; }

cleanup() {
  log "Cleaning up background processes..."
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT

# --- Validate environment ---
log "Checking environment..."
[[ -z "${CREDENTIAL_ENCRYPTION_KEY:-}" ]] && die "CREDENTIAL_ENCRYPTION_KEY not set"
[[ ${#CREDENTIAL_ENCRYPTION_KEY} -ne 64 ]] && die "CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars"
[[ -z "${HYPERLIQUID_TESTNET_API_KEY:-}" ]] && die "HYPERLIQUID_TESTNET_API_KEY not set"
[[ -z "${HYPERLIQUID_TESTNET_SECRET:-}" ]] && die "HYPERLIQUID_TESTNET_SECRET not set"

# --- 1. Infrastructure ---
log "1/7 Starting infrastructure (Postgres + Redis)..."
docker compose up -d --wait
sleep 2

# --- 2. Build + migrate ---
log "2/7 Installing deps and building..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build

log "Running DB migrations..."
pnpm --filter @herobids/db run db:migrate

# --- 3. Start API + Worker ---
log "3/7 Starting API server..."
CREDENTIAL_ENCRYPTION_KEY="$CREDENTIAL_ENCRYPTION_KEY" \
  PORT="$API_PORT" \
  tsx apps/api/src/index.ts > /tmp/herobids-api-stage-a.log 2>&1 &
API_PID=$!

log "Starting worker (live rollout enabled, testnet)..."
CREDENTIAL_ENCRYPTION_KEY="$CREDENTIAL_ENCRYPTION_KEY" \
  LIVE_ROLLOUT_ENABLED=true \
  LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD=25 \
  RECONCILIATION_DRIFT_ALERT_ONLY=false \
  HYPERLIQUID_BASE_URL="https://api.hyperliquid-testnet.xyz" \
  HYPERLIQUID_WS_URL="wss://api.hyperliquid-testnet.xyz/ws" \
  tsx apps/worker/src/index.ts > /tmp/herobids-worker-stage-a.log 2>&1 &
WORKER_PID=$!

# Wait for API to come up
log "Waiting for API to be ready..."
for i in $(seq 1 30); do
  if curl -sf "$API_URL/health" >/dev/null 2>&1; then
    ok "API ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    die "API did not start within 30s. Check /tmp/herobids-api-stage-a.log"
  fi
  sleep 1
done

# Give worker a moment to initialize
sleep 3

# --- 4. Create credential ---
log "4/7 Creating testnet credential in DB..."
CRED_RESPONSE=$(curl -sf -X POST "$API_URL/credentials" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"venue\": \"hyperliquid\",
    \"label\": \"testnet-rollout-stage-a\",
    \"secrets\": {
      \"apiKey\": \"$HYPERLIQUID_TESTNET_API_KEY\",
      \"secret\": \"$HYPERLIQUID_TESTNET_SECRET\",
      \"testnet\": \"true\"
    }
  }")

CRED_ID=$(echo "$CRED_RESPONSE" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
[[ -z "$CRED_ID" ]] && die "Failed to create credential"
ok "Credential created: $CRED_ID"

# --- 5. Create venue account + portfolio + instance ---
log "5/7 Creating venue account..."
VA_RESPONSE=$(curl -sf -X POST "$API_URL/venue-accounts" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"venue\": \"hyperliquid\",
    \"label\": \"testnet-account-stage-a\",
    \"credentialId\": \"$CRED_ID\"
  }")

VA_ID=$(echo "$VA_RESPONSE" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
[[ -z "$VA_ID" ]] && die "Failed to create venue account"
ok "Venue account created: $VA_ID"

log "Creating portfolio..."
PF_RESPONSE=$(curl -sf -X POST "$API_URL/portfolios" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"name\": \"testnet-portfolio-stage-a\"
  }")

PF_ID=$(echo "$PF_RESPONSE" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
[[ -z "$PF_ID" ]] && die "Failed to create portfolio"
ok "Portfolio created: $PF_ID"

log "Creating live trading instance..."
INST_RESPONSE=$(curl -sf -X POST "$API_URL/instances" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"portfolioId\": \"$PF_ID\",
    \"venueAccountId\": \"$VA_ID\",
    \"strategyId\": \"momentum-testnet\",
    \"venue\": \"hyperliquid\",
    \"symbol\": \"$SYMBOL\",
    \"config\": {
      \"strategy\": {
        \"type\": \"momentum\",
        \"params\": {
          \"lookbackPeriod\": 3,
          \"threshold\": 0.001,
          \"positionSize\": \"0.01\"
        }
      },
      \"risk\": {
        \"maxOrderNotional\": \"25\",
        \"maxPositionSize\": \"0.05\"
      },
      \"execution\": {
        \"mode\": \"live\"
      },
      \"venue\": \"hyperliquid\",
      \"symbol\": \"$SYMBOL\",
      \"venueType\": \"orderbook\"
    }
  }")

INST_ID=$(echo "$INST_RESPONSE" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
[[ -z "$INST_ID" ]] && die "Failed to create trading instance"
ok "Trading instance created: $INST_ID"

# --- 6. Start instance and monitor ---
log "6/7 Starting live instance..."
START_RESPONSE=$(curl -sf -X POST "$API_URL/instances/$INST_ID/start")
echo "  Start response: $START_RESPONSE"

log "Monitoring live status for up to ${MAX_WAIT_FILLS_SEC}s..."
FILL_FOUND=false
STARTED_AT=$(date +%s)

while true; do
  ELAPSED=$(($(date +%s) - STARTED_AT))
  if [[ $ELAPSED -ge $MAX_WAIT_FILLS_SEC ]]; then
    break
  fi

  STATUS_RESPONSE=$(curl -sf "$API_URL/instances/$INST_ID/live-status" 2>/dev/null || echo '{}')

  # Check for fills
  FILL_COUNT=$(echo "$STATUS_RESPONSE" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log((j.recentFills||[]).length); }
      catch(e) { console.log(0); }
    })" 2>/dev/null || echo "0")

  EXEC_MODE=$(echo "$STATUS_RESPONSE" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.executionMode||'unknown'); }
      catch(e) { console.log('unknown'); }
    })" 2>/dev/null || echo "unknown")

  OPEN_ORDERS=$(echo "$STATUS_RESPONSE" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log((j.openOrders||[]).length); }
      catch(e) { console.log(0); }
    }}" 2>/dev/null || echo "0")

  echo -ne "\r  [${ELAPSED}s] mode=$EXEC_MODE openOrders=$OPEN_ORDERS fills=$FILL_COUNT   "

  if [[ "$FILL_COUNT" -gt 0 ]]; then
    FILL_FOUND=true
    echo ""
    ok "Fill detected after ${ELAPSED}s!"
    break
  fi

  sleep 5
done
echo ""

# --- 7. Results ---
log "7/7 Collecting final status..."
FINAL_STATUS=$(curl -sf "$API_URL/instances/$INST_ID/live-status" 2>/dev/null || echo '{}')
echo ""
echo "=== Stage A Final Status ==="
echo "$FINAL_STATUS" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    try { console.log(JSON.stringify(JSON.parse(d), null, 2)); }
    catch(e) { console.log(d); }
  })"
echo ""

# Check journal for live events
log "Recent journal events:"
JOURNAL=$(curl -sf "$API_URL/journal?tradingInstanceId=$INST_ID&limit=20" 2>/dev/null || echo '{}')
echo "$JOURNAL" | node -e "
  process.stdin.resume(); let d=''; 
  process.stdin.on('data',c=>d+=c); 
  process.stdin.on('end',()=>{
    try {
      const j = JSON.parse(d);
      const entries = j.entries || j.events || [];
      entries.forEach(e => console.log('  ' + (e.type || e.eventType) + ' @ ' + (e.createdAt || e.timestamp)));
    } catch(e) { console.log('  (could not parse journal)'); }
  })"
echo ""

# Stop instance
log "Stopping instance..."
curl -sf -X POST "$API_URL/instances/$INST_ID/stop" >/dev/null 2>&1 || true

# Summary
echo ""
echo "=== Stage A Summary ==="
if [[ "$FILL_FOUND" == "true" ]]; then
  ok "SUCCESS — Live executor submitted orders on testnet and fill was confirmed."
  ok "The live code path (LiveExecutor → venue submit → private stream/recon fill) works end-to-end."
else
  warn "No fill observed within ${MAX_WAIT_FILLS_SEC}s."
  warn "This may be normal if market conditions didn't trigger the momentum strategy."
  warn "Check logs: /tmp/herobids-worker-stage-a.log"
  warn "Check live-status for order submissions (open orders indicate venue connectivity works)."
fi

echo ""
echo "Logs:"
echo "  API:    /tmp/herobids-api-stage-a.log"
echo "  Worker: /tmp/herobids-worker-stage-a.log"
echo ""
echo "To re-run interactively, keep infrastructure up and use:"
echo "  curl $API_URL/instances/$INST_ID/live-status | jq"
