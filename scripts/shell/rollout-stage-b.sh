#!/usr/bin/env bash
# rollout-stage-b.sh — Stage B: Production live instance (capped notional, manual monitoring).
#
# Launches one real production trading instance on Hyperliquid with:
#   - Strict operator-level notional cap ($25 USD default)
#   - Single symbol (ETH/USD:USD default)
#   - DB-backed credentials only
#   - Fail-closed reconciliation (driftAlertOnly=false)
#
# This script starts infrastructure and services, launches the instance,
# and then monitors it inline. Ctrl+C stops all services.
# Use rollout-monitor.sh if you need to reconnect to a running instance.
#
# Prerequisites (set in scripts/.env or export directly):
#   export CREDENTIAL_ENCRYPTION_KEY=<64-hex-chars>
#   export HYPERLIQUID_ACCOUNT_ADDRESS=<main-account-0x-address>  # holds funds, shows positions
#   export HYPERLIQUID_API_KEY=<agent-wallet-address>             # agent address from HL dashboard → API
#   export HYPERLIQUID_SECRET=<agent-private-key>                 # agent private key from HL dashboard
#
# Usage:
#   ./scripts/shell/rollout-stage-b.sh --dry-run  # validate config + print plan, no side effects
#   ./scripts/shell/rollout-stage-b.sh --paper     # full pipeline, simulated fills
#   ./scripts/shell/rollout-stage-b.sh             # full pipeline, LIVE (real money)
#
# Credentials:
#   Obtain production credentials at https://app.hyperliquid.xyz
#   → Connect wallet → API → Generate API key
#
set -euo pipefail

# --- Parse flags ---
DRY_RUN=false
PAPER_MODE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --paper)  PAPER_MODE=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$DRY_RUN" == "true" && "$PAPER_MODE" == "true" ]]; then
  echo "Cannot use --dry-run and --paper together" >&2; exit 1
fi

if [[ "$PAPER_MODE" == "true" ]]; then
  EXEC_MODE="paper"
else
  EXEC_MODE="live"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"
export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

API_PORT="${API_PORT:-3000}"
API_URL="http://localhost:${API_PORT}"
SYMBOL="${ROLLOUT_SYMBOL:-ETH/USD:USD}"
MAX_NOTIONAL="${ROLLOUT_MAX_NOTIONAL:-25}"
USER_ID="rollout-operator"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[stage-b]${NC} $1"; }
ok()   { echo -e "${GREEN}[stage-b]${NC} $1"; }
warn() { echo -e "${YELLOW}[stage-b]${NC} $1"; }
die()  { echo -e "${RED}[stage-b]${NC} $1" >&2; exit 1; }

# Explicit production venue URLs — override any testnet values that might leak from .env
HYPERLIQUID_BASE_URL="https://api.hyperliquid.xyz"
HYPERLIQUID_WS_URL="wss://api.hyperliquid.xyz/ws"
export HYPERLIQUID_BASE_URL HYPERLIQUID_WS_URL

# Compute a safe positionSize from notional cap and current ETH price.
# Uses 80% of max notional to leave headroom for price movement.
compute_position_size() {
  local mark_price
  mark_price=$(curl -sf -X POST "https://api.hyperliquid.xyz/info" \
    -H "Content-Type: application/json" \
    -d '{"type":"allMids"}' \
    | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);console.log(o['ETH']||'')})")
  if [[ -z "$mark_price" ]]; then
    die "Cannot fetch ETH mark price from Hyperliquid — needed to compute safe positionSize"
  fi
  # positionSize = floor((maxNotional * 0.8) / markPrice, 4 decimals)
  node -e "const sz=(${MAX_NOTIONAL}*0.8/${mark_price});const r=Math.floor(sz*10000)/10000;if(r<=0){process.exit(1)};console.log(r.toFixed(4))"
}

POSITION_SIZE=$(compute_position_size)
[[ -z "$POSITION_SIZE" ]] && die "Computed positionSize is zero — MAX_NOTIONAL ($MAX_NOTIONAL) is too low for current ETH price"
MAX_POSITION_SIZE=$(node -e "console.log((${POSITION_SIZE}*5).toFixed(4))")

cleanup() {
  log "Stopping..."
  # Gracefully stop the trading instance if it was created
  if [[ -n "${INST_ID:-}" && -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    log "Stopping trading instance $INST_ID..."
    curl -s -X POST "$API_URL/instances/$INST_ID/stop" >/dev/null 2>&1 || true
    sleep 1
  fi
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  log "Services stopped. Instance stopped and state preserved in DB."
}
trap cleanup EXIT

# --- Validate environment ---
log "Checking environment..."
[[ -z "${CREDENTIAL_ENCRYPTION_KEY:-}" ]] && die "CREDENTIAL_ENCRYPTION_KEY not set"
[[ ${#CREDENTIAL_ENCRYPTION_KEY} -ne 64 ]] && die "CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars"
[[ -z "${HYPERLIQUID_API_KEY:-}" ]] && die "HYPERLIQUID_API_KEY not set (agent wallet address from HL dashboard)"
[[ -z "${HYPERLIQUID_SECRET:-}" ]] && die "HYPERLIQUID_SECRET not set (agent wallet private key)"
[[ -z "${HYPERLIQUID_ACCOUNT_ADDRESS:-}" ]] && die "HYPERLIQUID_ACCOUNT_ADDRESS not set — your main HL account address (shown top-right on app.hyperliquid.xyz)"
export HYPERLIQUID_ACCOUNT_ADDRESS

# --- Safety confirmation ---
echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${BLUE}=== DRY RUN — STAGE B ===${NC}"
  echo ""
  echo "  Venue:      Hyperliquid (PRODUCTION endpoint)"
  echo "  Symbol:     $SYMBOL"
  echo "  Max notional: \$${MAX_NOTIONAL} USD per order"
  echo "  Position size: $POSITION_SIZE ETH (computed from mark price)"
  echo "  Max position:  $MAX_POSITION_SIZE ETH"
  echo "  Mode:       DRY RUN (validate only, no side effects)"
  echo ""
elif [[ "$PAPER_MODE" == "true" ]]; then
  echo -e "${YELLOW}=== STAGE B — PAPER MODE ===${NC}"
  echo ""
  echo "  Venue:      Hyperliquid (PRODUCTION endpoint, paper execution)"
  echo "  Symbol:     $SYMBOL"
  echo "  Max notional: \$${MAX_NOTIONAL} USD per order"
  echo "  Position size: $POSITION_SIZE ETH (computed from mark price)"
  echo "  Max position:  $MAX_POSITION_SIZE ETH"
  echo "  Mode:       PAPER (full pipeline, simulated fills)"
  echo ""
else
  echo -e "${YELLOW}=== PRODUCTION LIVE ROLLOUT — STAGE B ===${NC}"
  echo ""
  echo "  Venue:      Hyperliquid (PRODUCTION)"
  echo "  Symbol:     $SYMBOL"
  echo "  Max notional: \$${MAX_NOTIONAL} USD per order"
  echo "  Position size: $POSITION_SIZE ETH (computed from mark price)"
  echo "  Max position:  $MAX_POSITION_SIZE ETH"
  echo "  Mode:       LIVE (real money)"
  echo ""
  read -p "Proceed with REAL orders on Hyperliquid mainnet? (type YES to confirm): " CONFIRM
  [[ "$CONFIRM" != "YES" ]] && die "Aborted by operator."
fi
echo ""

# --- Pre-flight: verify API key permissions and account balance ---
log "Pre-flight: checking Hyperliquid account..."
PREFLIGHT_RESPONSE=$(curl -sf -X POST "https://api.hyperliquid.xyz/info" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"clearinghouseState\",\"user\":\"$HYPERLIQUID_ACCOUNT_ADDRESS\"}")

if [[ -z "$PREFLIGHT_RESPONSE" ]]; then
  die "Pre-flight failed: cannot reach Hyperliquid info endpoint or invalid API key address"
fi

ACCOUNT_EQUITY=$(echo "$PREFLIGHT_RESPONSE" | node -e "
  process.stdin.resume();let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const s=JSON.parse(d);
      const eq=s.marginSummary?.accountValue || '0';
      console.log(eq);
    } catch { console.log('0'); }
  })")

if [[ "$ACCOUNT_EQUITY" == "0" || -z "$ACCOUNT_EQUITY" ]]; then
  if [[ "$PAPER_MODE" == "true" ]]; then
    warn "Account equity is $0 — expected for paper mode (no real funds needed)."
  else
    die "Pre-flight failed: account has zero equity or clearinghouse state unavailable. Fund the account first."
  fi
fi

# Check for existing open positions that would trigger reconciliation drift
OPEN_POSITIONS=$(echo "$PREFLIGHT_RESPONSE" | node -e "
  process.stdin.resume();let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const s=JSON.parse(d);
      const pos=s.assetPositions?.filter(p=>parseFloat(p.position?.szi||'0')!==0)||[];
      console.log(pos.length);
    } catch { console.log('0'); }
  })")

if [[ "$OPEN_POSITIONS" -gt 0 ]]; then
  warn "Account has $OPEN_POSITIONS open position(s). Reconciliation (driftAlertOnly=false) will detect drift and block trading."
  warn "Close existing positions or set RECONCILIATION_DRIFT_ALERT_ONLY=true (reduces safety)."
  read -p "Continue anyway? (type YES): " DRIFT_CONFIRM
  [[ "$DRIFT_CONFIRM" != "YES" ]] && die "Aborted — close existing positions first."
fi

ok "Account equity: \$${ACCOUNT_EQUITY} | Open positions: ${OPEN_POSITIONS}"
echo ""

# --- Dry run: print plan and exit ---
if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${GREEN}=== Dry Run Plan ===${NC}"
  echo ""
  echo "  The following would be executed:"
  echo "    1. docker compose up -d --wait"
  echo "    2. pnpm install && pnpm build && db:migrate"
  echo "    3. Start API (port $API_PORT) + Worker (live_rollout=$EXEC_MODE)"
  echo "    4. Create/reuse credential: label=production-rollout-stage-b, venue=hyperliquid"
  echo "    5. Create/reuse venue account + portfolio"
  echo "    6. Create instance: strategy=momentum, positionSize=$POSITION_SIZE, maxOrderNotional=$MAX_NOTIONAL"
  echo "    7. Start instance in $EXEC_MODE mode"
  echo ""
  echo "  Instance config payload:"
  echo "    {\"strategy\":{\"type\":\"momentum\",\"params\":{\"lookbackPeriod\":5,\"threshold\":0.02,\"positionSize\":\"$POSITION_SIZE\"}},"
  echo "     \"risk\":{\"maxOrderNotional\":\"$MAX_NOTIONAL\",\"maxPositionSize\":\"$MAX_POSITION_SIZE\"},"
  echo "     \"execution\":{\"mode\":\"$EXEC_MODE\"},\"venue\":\"hyperliquid\",\"symbol\":\"$SYMBOL\",\"venueType\":\"orderbook\"}"
  echo ""
  echo "  Worker env overrides:"
  echo "    LIVE_ROLLOUT_ENABLED=true"
  echo "    LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD=$MAX_NOTIONAL"
  echo "    RECONCILIATION_DRIFT_ALERT_ONLY=false"
  echo "    HYPERLIQUID_BASE_URL=$HYPERLIQUID_BASE_URL"
  echo "    HYPERLIQUID_WS_URL=$HYPERLIQUID_WS_URL"
  echo "    HYPERLIQUID_ACCOUNT_ADDRESS=$HYPERLIQUID_ACCOUNT_ADDRESS"
  echo ""
  ok "Dry run complete. All checks passed. Ready to run without --dry-run."
  exit 0
fi

# --- 1. Infrastructure ---
log "1/6 Starting infrastructure..."
docker compose up -d --wait
sleep 2

# --- 2. Build + migrate ---
log "2/6 Building and migrating..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
pnpm --filter @herobids/db run db:migrate

# --- 3. Start API + Worker ---
# Check for stale processes from a previous killed run
if lsof -i :"$API_PORT" -t >/dev/null 2>&1; then
  STALE_PID=$(lsof -i :"$API_PORT" -t 2>/dev/null | head -1)
  warn "Port $API_PORT is already in use (PID $STALE_PID) — likely a stale process from a previous run."
  read -p "Kill it and continue? (type YES): " KILL_CONFIRM
  if [[ "$KILL_CONFIRM" == "YES" ]]; then
    kill "$STALE_PID" 2>/dev/null || true
    sleep 2
  else
    die "Port $API_PORT occupied. Stop the conflicting process manually."
  fi
fi

log "3/6 Starting API server..."
CREDENTIAL_ENCRYPTION_KEY="$CREDENTIAL_ENCRYPTION_KEY" \
  PORT="$API_PORT" \
  tsx apps/api/src/index.ts > /tmp/herobids-api-stage-b.log 2>&1 &
API_PID=$!

log "Starting worker (production, live rollout enabled)..."
CREDENTIAL_ENCRYPTION_KEY="$CREDENTIAL_ENCRYPTION_KEY" \
  LIVE_ROLLOUT_ENABLED=true \
  LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD="$MAX_NOTIONAL" \
  RECONCILIATION_DRIFT_ALERT_ONLY=false \
  tsx apps/worker/src/index.ts > /tmp/herobids-worker-stage-b.log 2>&1 &
WORKER_PID=$!

# Wait for API
log "Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf "$API_URL/health" >/dev/null 2>&1; then
    ok "API ready"
    break
  fi
  [[ $i -eq 30 ]] && die "API did not start. Check /tmp/herobids-api-stage-b.log"
  sleep 1
done
sleep 3

# --- 4. Create credential (idempotent — reuse if label matches) ---
log "4/6 Creating production credential..."
EXISTING_CRED_ID=$(curl -sf "$API_URL/credentials" | node -e "
  process.stdin.resume();let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    const match=(r.credentials||[]).find(c=>c.label==='production-rollout-stage-b'&&c.venue==='hyperliquid'&&c.userId==='$USER_ID');
    console.log(match?.id||'');
  })" 2>/dev/null || echo "")

if [[ -n "$EXISTING_CRED_ID" ]]; then
  CRED_ID="$EXISTING_CRED_ID"
  ok "Credential (existing): $CRED_ID"
else
  CRED_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/credentials" \
    -H "Content-Type: application/json" \
    -d "{
      \"userId\": \"$USER_ID\",
      \"venue\": \"hyperliquid\",
      \"label\": \"production-rollout-stage-b\",
      \"secrets\": {
        \"apiKey\": \"$HYPERLIQUID_API_KEY\",
        \"secret\": \"$HYPERLIQUID_SECRET\",
        \"walletAddress\": \"$HYPERLIQUID_ACCOUNT_ADDRESS\"
      }
    }")

  CRED_HTTP_CODE=$(echo "$CRED_RESPONSE" | tail -1)
  CRED_BODY=$(echo "$CRED_RESPONSE" | sed '$d')
  if [[ "$CRED_HTTP_CODE" -lt 200 || "$CRED_HTTP_CODE" -ge 300 ]]; then
    die "Failed to create credential (HTTP $CRED_HTTP_CODE): $CRED_BODY"
  fi

  CRED_ID=$(echo "$CRED_BODY" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
  [[ -z "$CRED_ID" || "$CRED_ID" == "undefined" ]] && die "Failed to parse credential ID from response: $CRED_BODY"
  ok "Credential (created): $CRED_ID"
fi

# --- 5. Create venue account + portfolio + instance (idempotent) ---
log "5/6 Creating venue account, portfolio, and instance..."

EXISTING_VA_ID=$(curl -sf "$API_URL/venue-accounts" | node -e "
  process.stdin.resume();let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    const match=(r.venueAccounts||[]).find(a=>a.label==='production-account'&&a.venue==='hyperliquid'&&a.userId==='$USER_ID');
    console.log(match?.id||'');
  })" 2>/dev/null || echo "")

if [[ -n "$EXISTING_VA_ID" ]]; then
  VA_ID="$EXISTING_VA_ID"
  ok "Venue account (existing): $VA_ID"
else
  VA_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/venue-accounts" \
    -H "Content-Type: application/json" \
    -d "{
      \"userId\": \"$USER_ID\",
      \"venue\": \"hyperliquid\",
      \"label\": \"production-account\",
      \"credentialId\": \"$CRED_ID\"
    }")

  VA_HTTP_CODE=$(echo "$VA_RESPONSE" | tail -1)
  VA_BODY=$(echo "$VA_RESPONSE" | sed '$d')
  if [[ "$VA_HTTP_CODE" -lt 200 || "$VA_HTTP_CODE" -ge 300 ]]; then
    die "Failed to create venue account (HTTP $VA_HTTP_CODE): $VA_BODY"
  fi

  VA_ID=$(echo "$VA_BODY" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
  [[ -z "$VA_ID" || "$VA_ID" == "undefined" ]] && die "Failed to parse venue account ID from response: $VA_BODY"
  ok "Venue account (created): $VA_ID"
fi

EXISTING_PF_ID=$(curl -sf "$API_URL/portfolios" | node -e "
  process.stdin.resume();let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    const match=(r.portfolios||[]).find(p=>p.name==='production-portfolio'&&p.userId==='$USER_ID');
    console.log(match?.id||'');
  })" 2>/dev/null || echo "")

if [[ -n "$EXISTING_PF_ID" ]]; then
  PF_ID="$EXISTING_PF_ID"
  ok "Portfolio (existing): $PF_ID"
else
  PF_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/portfolios" \
    -H "Content-Type: application/json" \
    -d "{
      \"userId\": \"$USER_ID\",
      \"name\": \"production-portfolio\"
    }")

  PF_HTTP_CODE=$(echo "$PF_RESPONSE" | tail -1)
  PF_BODY=$(echo "$PF_RESPONSE" | sed '$d')
  if [[ "$PF_HTTP_CODE" -lt 200 || "$PF_HTTP_CODE" -ge 300 ]]; then
    die "Failed to create portfolio (HTTP $PF_HTTP_CODE): $PF_BODY"
  fi

  PF_ID=$(echo "$PF_BODY" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
  [[ -z "$PF_ID" || "$PF_ID" == "undefined" ]] && die "Failed to parse portfolio ID from response: $PF_BODY"
  ok "Portfolio (created): $PF_ID"
fi

# Check for existing non-stopped instance on this venue account (DB has a partial unique index)
EXISTING_INST_ID=$(curl -sf "$API_URL/instances" | node -e "
  process.stdin.resume();let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    const match=(r.instances||[]).find(i=>i.venueAccountId==='$VA_ID'&&i.status!=='stopped');
    console.log(match?.id||'');
  })" 2>/dev/null || echo "")

if [[ -n "$EXISTING_INST_ID" ]]; then
  warn "Found existing non-stopped instance $EXISTING_INST_ID on this venue account. Stopping it..."
  curl -s -X POST "$API_URL/instances/$EXISTING_INST_ID/stop" >/dev/null 2>&1 || true
  sleep 2
fi

INST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/instances" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$USER_ID\",
    \"portfolioId\": \"$PF_ID\",
    \"venueAccountId\": \"$VA_ID\",
    \"strategyId\": \"momentum-prod\",
    \"venue\": \"hyperliquid\",
    \"symbol\": \"$SYMBOL\",
    \"config\": {
      \"strategy\": {
        \"type\": \"momentum\",
        \"params\": {
          \"lookbackPeriod\": 5,
          \"threshold\": 0.02,
          \"positionSize\": \"$POSITION_SIZE\"
        }
      },
      \"risk\": {
        \"maxOrderNotional\": \"$MAX_NOTIONAL\",
        \"maxPositionSize\": \"$MAX_POSITION_SIZE\"
      },
      \"execution\": {
        \"mode\": \"$EXEC_MODE\"
      },
      \"venue\": \"hyperliquid\",
      \"symbol\": \"$SYMBOL\",
      \"venueType\": \"orderbook\"
    }
  }")

INST_HTTP_CODE=$(echo "$INST_RESPONSE" | tail -1)
INST_BODY=$(echo "$INST_RESPONSE" | sed '$d')
if [[ "$INST_HTTP_CODE" -lt 200 || "$INST_HTTP_CODE" -ge 300 ]]; then
  die "Failed to create trading instance (HTTP $INST_HTTP_CODE): $INST_BODY"
fi

INST_ID=$(echo "$INST_BODY" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
[[ -z "$INST_ID" || "$INST_ID" == "undefined" ]] && die "Failed to parse instance ID from response: $INST_BODY"
ok "Trading instance: $INST_ID"

# --- 6. Start and hand off to manual monitoring ---
log "6/6 Starting instance ($EXEC_MODE mode)..."
START_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/instances/$INST_ID/start")
START_HTTP_CODE=$(echo "$START_RESPONSE" | tail -1)
START_BODY=$(echo "$START_RESPONSE" | sed '$d')
if [[ "$START_HTTP_CODE" -lt 200 || "$START_HTTP_CODE" -ge 300 ]]; then
  die "Failed to start instance (HTTP $START_HTTP_CODE): $START_BODY"
fi
echo "  $START_BODY"
echo ""

if [[ "$PAPER_MODE" == "true" ]]; then
  ok "Instance started in PAPER mode. Strategy runs, fills are simulated."
else
  ok "Instance started in LIVE mode on Hyperliquid PRODUCTION."
fi
echo ""
echo "  Instance ID: $INST_ID"
echo "  Live status:  curl $API_URL/instances/$INST_ID/live-status | jq"
echo "  Stop with:    curl -X POST $API_URL/instances/$INST_ID/stop"
echo "  Logs:  API: /tmp/herobids-api-stage-b.log  Worker: /tmp/herobids-worker-stage-b.log"
echo ""
echo "  Press Ctrl+C to stop all services."
echo ""

# --- Inline monitor: watchdog + live-status polling ---
DIM='\033[2m'
MONITOR_INTERVAL=5
LAST_FILL_COUNT=0

echo -e "${BLUE}[monitor]${NC} Polling every ${MONITOR_INTERVAL}s — Ctrl+C to stop"
echo ""

while true; do
  # Watchdog: crash detection
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo ""
    die "Worker process exited unexpectedly! Check /tmp/herobids-worker-stage-b.log"
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo ""
    die "API process exited unexpectedly! Check /tmp/herobids-api-stage-b.log"
  fi

  # Live-status poll
  NOW=$(date '+%H:%M:%S')
  STATUS=$(curl -sf "$API_URL/instances/$INST_ID/live-status" 2>/dev/null || echo '{}')

  PARSE_SCRIPT='
    process.stdin.resume(); let d="";
    process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const j = JSON.parse(d);
        const out = {
          mode: j.executionMode || "unknown",
          status: j.status || "unknown",
          openOrders: (j.openOrders||[]).length,
          fills: (j.recentFills||[]).length,
          slippage: (j.slippageAlerts||[]).length,
          lastRecon: j.lastReconciliation ? j.lastReconciliation.result + " (" + j.lastReconciliation.diffCount + " diffs)" : "none",
        };
        console.log(JSON.stringify(out));
      } catch(e) { console.log("{}"); }
    })
  '
  PARSED=$(echo "$STATUS" | node -e "$PARSE_SCRIPT" 2>/dev/null || echo '{}')

  MODE=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.mode||'?')})")
  INST_STATUS=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.status||'?')})")
  OPEN_ORDERS=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.openOrders||0)})")
  FILLS=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.fills||0)})")
  SLIPPAGE=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.slippage||0)})")
  RECON=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.lastRecon||'none')})")

  MODE_COLOR="$NC"
  [[ "$MODE" == "live" ]] && MODE_COLOR="$GREEN"
  [[ "$MODE" == "paper" ]] && MODE_COLOR="$DIM"

  STATUS_COLOR="$NC"
  [[ "$INST_STATUS" == "running" ]] && STATUS_COLOR="$GREEN"
  [[ "$INST_STATUS" == "crashed" ]] && STATUS_COLOR="$RED"

  FILL_ALERT=""
  if [[ "$FILLS" -gt "$LAST_FILL_COUNT" ]]; then
    FILL_ALERT=" ${GREEN}<- NEW FILL${NC}"
    LAST_FILL_COUNT=$FILLS
  fi

  SLIP_ALERT=""
  [[ "$SLIPPAGE" -gt 0 ]] && SLIP_ALERT=" ${YELLOW}⚠ slippage${NC}"

  echo -e "${DIM}[$NOW]${NC} ${MODE_COLOR}$MODE${NC} | status=${STATUS_COLOR}$INST_STATUS${NC} | orders=$OPEN_ORDERS | fills=$FILLS$FILL_ALERT | recon=$RECON$SLIP_ALERT"

  sleep "$MONITOR_INTERVAL"
done
