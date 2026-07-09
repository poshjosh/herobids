#!/usr/bin/env bash
# Test candidates for economic calendar data sources.
# Run: bash scripts/shell/test-economic-calendar-sources.sh
# Usage: ./test-economic-calendar-sources.sh [--deep]

set -uo pipefail  # no -e — we handle errors explicitly

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0; FAIL=0; WARN=0

_pass() { PASS=$((PASS+1)); echo -e "${GREEN}PASS${NC} $*"; }
_fail() { FAIL=$((FAIL+1)); echo -e "${RED}FAIL${NC} $*"; }
_warn() { WARN=$((WARN+1)); echo -e "${YELLOW}WARN${NC} $*"; }
_info() { echo -e "${CYAN}INFO${NC} $*"; }

RESP_FILE="/tmp/ecal_test_response.txt"
USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
DEEP_MODE="${1:-}"

test_http() {
  local url="$1" label="$2"
  local status size content_type
  
  status=$(curl -s -o "$RESP_FILE" -w "%{http_code}" \
    --max-time 10 \
    -H "User-Agent: $USER_AGENT" \
    -H "Accept: text/html,application/json,*/*" \
    "$url" 2>/dev/null || echo "000")
  
  size=$(wc -c < "$RESP_FILE" 2>/dev/null || echo 0)
  content_type=$(head -c 1 "$RESP_FILE" 2>/dev/null || echo "?")
  
  if [[ "$status" == "200" ]]; then
    _pass "$label — HTTP 200 ($size bytes)"
    if echo "$content_type" | grep -q '[{\[]'; then
      _info "  → JSON response"
      if [[ "$DEEP_MODE" == "--deep" ]]; then
        python3 -c "
import json,sys
d=json.load(open('$RESP_FILE'))
if isinstance(d,dict):
    print(f'  → top-level keys: {list(d.keys())[:10]}')
    for k,v in d.items():
        if isinstance(v,list) and len(v)>0:
            print(f'  → {k}[0] sample keys: {list(v[0].keys())[:8] if isinstance(v[0],dict) else type(v[0]).__name__}')
            break
elif isinstance(d,list):
    print(f'  → array of {len(d)} items')
    if len(d)>0 and isinstance(d[0],dict):
        print(f'  → item[0] keys: {list(d[0].keys())[:10]}')
" 2>/dev/null || head -c 500 "$RESP_FILE"
      else
        head -c 300 "$RESP_FILE" | tr '\n' ' '
        echo ""
      fi
    elif grep -qi '<table\|<tr\|calendar\|economic\|event' "$RESP_FILE"; then
      _info "  → HTML with table/calendar content (first 200 chars of body)"
      sed -n '/<body/,$p' "$RESP_FILE" | sed 's/<[^>]*>//g' | tr -s ' \n' ' ' | head -c 200
      echo ""
    else
      _info "  → Response (first 200 chars):"
      head -c 200 "$RESP_FILE" | tr '\n' ' '
      echo ""
    fi
    return 0
  elif [[ "$status" == "403" || "$status" == "401" ]]; then
    _fail "$label — HTTP $status (auth/bot-blocked)"
    return 1
  elif [[ "$status" == "000" ]]; then
    _fail "$label — unreachable (timeout/DNS)"
    return 1
  else
    _warn "$label — HTTP $status ($size bytes)"
    return 1
  fi
}

echo "══════════════════════════════════════════════════════════════"
echo "Economic Calendar Source Candidate Test"
echo "══════════════════════════════════════════════════════════════"
[[ "$DEEP_MODE" == "--deep" ]] && echo "(deep mode: inspecting response structure)"
echo ""

# ── JSON API Candidates ─────────────────────────────────────────────────
echo "━━━ JSON APIs (structured, prefer these) ━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

_info "1. Financial Modeling Prep (free tier, needs API key)"
test_http "https://financialmodelingprep.com/api/v3/economic_calendar?from=2026-07-09&to=2026-07-11" "  FMP economic_calendar"
echo ""

_info "2. Tradermade (forex data)"
test_http "https://marketdata.tradermade.com/api/v1/live_currencies" "  Tradermade currencies"
echo ""

_info "3. CurrencyFreaks (forex + economic)"
test_http "https://api.currencyfreaks.com/v2.0/rates/latest" "  CurrencyFreaks"
echo ""

# ── HTML Scraping Candidates ────────────────────────────────────────────
echo "━━━ HTML Scraping (fallback, parse HTML tables) ━━━━━━━━━━━━━━━━━"
echo ""

_info "4. Investing.com economic calendar"
test_http "https://www.investing.com/economic-calendar/" "  Investing.com"
echo ""

_info "5. Myfxbook economic calendar"
test_http "https://www.myfxbook.com/forex-economic-calendar" "  Myfxbook"
echo ""

_info "6. FXStreet economic calendar"
test_http "https://www.fxstreet.com/economic-calendar" "  FXStreet"
echo ""

_info "7. DailyFX economic calendar"
test_http "https://www.dailyfx.com/economic-calendar" "  DailyFX"
echo ""

_info "8. Econoday"
test_http "https://www.econoday.com/economic-calendar.aspx" "  Econoday"
echo ""

_info "9. MarketWatch economy calendar"
test_http "https://www.marketwatch.com/economy-politics/calendar" "  MarketWatch"
echo ""

_info "10. Trading Economics calendar"
test_http "https://tradingeconomics.com/calendar" "  TradingEconomics"
echo ""

echo "══════════════════════════════════════════════════════════════"
echo " RESULTS: ${GREEN}${PASS} pass${NC}  ${RED}${FAIL} fail${NC}  ${YELLOW}${WARN} warn${NC}"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  For PASS candidates: run with --deep to inspect response structure"
echo "  bash scripts/shell/test-economic-calendar-sources.sh --deep"
