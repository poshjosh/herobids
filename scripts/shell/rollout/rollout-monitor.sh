#!/usr/bin/env bash
# rollout-monitor.sh — Continuous live-status monitor for a running trading instance.
#
# Polls the live-status API and displays real-time state.
# Useful during Stage B manual monitoring window.
#
# Usage:
#   ./scripts/shell/rollout/rollout-monitor.sh <instance-id>
#   ./scripts/shell/rollout/rollout-monitor.sh <instance-id> --interval 10
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Load root .env (infrastructure vars), then scripts/.env (operator credentials)
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT_DIR/.env"
  set +a
fi
if [[ -f "$ROOT_DIR/scripts/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT_DIR/scripts/.env"
  set +a
fi

API_PORT="${API_PORT:-3000}"
API_URL="http://localhost:${API_PORT}"
INTERVAL=5

# --- Parse args ---
INSTANCE_ID="${1:-}"
[[ -z "$INSTANCE_ID" ]] && { echo "Usage: $0 <instance-id> [--interval <seconds>]"; exit 1; }
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL="${2:-5}"; shift 2 ;;
    *) shift ;;
  esac
done

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m'

# Check API
curl -sf "$API_URL/health" >/dev/null 2>&1 || { echo "API not responding at $API_URL"; exit 1; }

echo -e "${BLUE}Monitoring instance $INSTANCE_ID (every ${INTERVAL}s, Ctrl+C to stop)${NC}"
echo ""

LAST_FILL_COUNT=0

while true; do
  STATUS=$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status" 2>/dev/null || echo '{}')
  NOW=$(date '+%H:%M:%S')

  # Parse fields
  PARSED=$(echo "$STATUS" | node -e "
    process.stdin.resume(); let d=''; 
    process.stdin.on('data',c=>d+=c); 
    process.stdin.on('end',()=>{
      try {
        const j = JSON.parse(d);
        const out = {
          mode: j.executionMode || 'unknown',
          status: j.status || 'unknown',
          openOrders: (j.openOrders||[]).length,
          fills: (j.recentFills||[]).length,
          slippage: (j.slippageAlerts||[]).length,
          lastRecon: j.lastReconciliation ? j.lastReconciliation.result + ' (' + j.lastReconciliation.diffCount + ' diffs)' : 'none',
          lastReconAt: j.lastReconciliation?.timestamp || '',
          liveEvents: (j.liveEvents||[]).length,
        };
        console.log(JSON.stringify(out));
      } catch(e) { console.log('{}'); }
    })" 2>/dev/null || echo '{}')

  MODE=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.mode||'?')})")
  INST_STATUS=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.status||'?')})")
  OPEN_ORDERS=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.openOrders||0)})")
  FILLS=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.fills||0)})")
  SLIPPAGE=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.slippage||0)})")
  RECON=$(echo "$PARSED" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.lastRecon||'none')})")

  # Color status
  MODE_COLOR="$NC"
  [[ "$MODE" == "live" ]] && MODE_COLOR="$GREEN"
  [[ "$MODE" == "paper" ]] && MODE_COLOR="$DIM"

  STATUS_COLOR="$NC"
  [[ "$INST_STATUS" == "running" ]] && STATUS_COLOR="$GREEN"
  [[ "$INST_STATUS" == "crashed" ]] && STATUS_COLOR="$RED"

  # Alert on new fills
  FILL_ALERT=""
  if [[ "$FILLS" -gt "$LAST_FILL_COUNT" ]]; then
    FILL_ALERT=" ${GREEN}← NEW FILL${NC}"
    LAST_FILL_COUNT=$FILLS
  fi

  # Slippage warning
  SLIP_ALERT=""
  [[ "$SLIPPAGE" -gt 0 ]] && SLIP_ALERT=" ${YELLOW}⚠ slippage${NC}"

  echo -e "${DIM}[$NOW]${NC} ${MODE_COLOR}$MODE${NC} | status=${STATUS_COLOR}$INST_STATUS${NC} | orders=$OPEN_ORDERS | fills=$FILLS$FILL_ALERT | recon=$RECON$SLIP_ALERT"

  sleep "$INTERVAL"
done
