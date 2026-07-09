#!/usr/bin/env bash
# Test Forex Factory access with different User-Agent strings and headers.
# Goal: find a combination that bypasses Cloudflare 403.
# Run: bash scripts/shell/test-forexfactory-access.sh [--docker]

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

DOCKER_MODE="${1:-}"
CONTAINER="herobids-agent-294ed46b-88fe-40c6-81cd-d5c020d30f21"

FF_URL="https://www.forexfactory.com/calendar"
TIMEOUT=15

echo "══════════════════════════════════════════════════════════════"
echo "Forex Factory Access Test"
[[ "$DOCKER_MODE" == "--docker" ]] && echo "(running inside agent container: $CONTAINER)"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Test runner ──────────────────────────────────────────────────────────

test_ff() {
  local label="$1"; shift
  local status size
  
  if [[ "$DOCKER_MODE" == "--docker" ]]; then
    # Build curl command for inside container (curl not available, use node/wget)
    local cmd="wget -q -O- --timeout=$TIMEOUT"
    for arg in "$@"; do
      cmd="$cmd --header='$arg'"
    done
    cmd="$cmd '$FF_URL'"
    
    local output
    output=$(docker exec "$CONTAINER" sh -c "$cmd" 2>&1) || true
    size=${#output}
    
    # Check HTTP status via wget stderr (if available) or infer from content
    if echo "$output" | grep -qi '<html\|<!DOCTYPE\|<table\|calendar'; then
      status="200"
    elif echo "$output" | grep -qi '403\|Forbidden\|blocked'; then
      status="403"
    else
      status="???"
    fi
  else
    local response
    response=$(curl -s -o /tmp/ff_test_body.txt -w "%{http_code}" --max-time $TIMEOUT "$@" "$FF_URL" 2>/dev/null || echo "000")
    status="$response"
    size=$(wc -c < /tmp/ff_test_body.txt 2>/dev/null || echo 0)
  fi

  if [[ "$status" == "200" ]]; then
    echo -e "  ${GREEN}PASS${NC} $label — HTTP $status ($size bytes)"
    return 0
  elif [[ "$status" == "403" ]]; then
    echo -e "  ${RED}FAIL${NC} $label — HTTP 403 (Cloudflare block)"
    return 1
  elif [[ "$status" == "000" || "$status" == "???" ]]; then
    echo -e "  ${RED}FAIL${NC} $label — unreachable"
    return 1
  else
    echo -e "  ${YELLOW}WARN${NC} $label — HTTP $status ($size bytes)"
    return 1
  fi
}

# ── Common headers ───────────────────────────────────────────────────────

REAL_CHROME="User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
REAL_FIREFOX="User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0"
REAL_SAFARI="User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15"
WGET_UA="User-Agent: Wget/1.21.4"
CURL_UA="User-Agent: curl/8.7.1"
BINGBOT="User-Agent: Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
GOOGLEBOT="User-Agent: Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

# ── Tests ────────────────────────────────────────────────────────────────

echo "━━━ User-Agent only ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
test_ff "Chrome 131 macOS"          -H "$REAL_CHROME"
test_ff "Firefox 133 macOS"         -H "$REAL_FIREFOX"
test_ff "Safari 18 macOS"           -H "$REAL_SAFARI"
test_ff "Wget"                      -H "$WGET_UA"
test_ff "curl"                      -H "$CURL_UA"
test_ff "Bingbot"                   -H "$BINGBOT"
test_ff "Googlebot"                 -H "$GOOGLEBOT"
test_ff "Empty (no UA)"             -H "User-Agent:"
echo ""

echo "━━━ Chrome UA + extra headers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
test_ff "Chrome + Accept-Language"  -H "$REAL_CHROME" -H "Accept-Language: en-US,en;q=0.9"
test_ff "Chrome + Referer Google"   -H "$REAL_CHROME" -H "Referer: https://www.google.com/"
test_ff "Chrome + Accept HTML"      -H "$REAL_CHROME" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
test_ff "Chrome + full set"         -H "$REAL_CHROME" \
  -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Accept-Encoding: gzip, deflate, br" \
  -H "Cache-Control: no-cache" \
  -H "Sec-Ch-Ua: \"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"" \
  -H "Sec-Ch-Ua-Mobile: ?0" \
  -H "Sec-Ch-Ua-Platform: \"macOS\""
echo ""

echo "━━━ With cookies ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
# First request to get cookies
COOKIE_JAR=$(mktemp)
curl -s -o /dev/null -c "$COOKIE_JAR" --max-time $TIMEOUT \
  -H "$REAL_CHROME" \
  -H "Accept: text/html,application/xhtml+xml" \
  -H "Accept-Language: en-US,en;q=0.9" \
  "$FF_URL" 2>/dev/null || true
COOKIE_COUNT=$(wc -l < "$COOKIE_JAR" 2>/dev/null || echo 0)
echo "  Got $COOKIE_COUNT cookies from initial request"

test_ff "Chrome + cookies"          -H "$REAL_CHROME" -b "$COOKIE_JAR"
rm -f "$COOKIE_JAR"
echo ""

echo "━━━ Follow redirects ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
test_ff "Chrome + -L (follow)"      -H "$REAL_CHROME" -L
echo ""

echo "━━━ Direct IP (bypass Cloudflare?) ━━━━━━━━━━━━━━━━━━━━━━━━━━━"
FF_IP="104.18.7.7"
test_ff "Direct IP $FF_IP"          -H "$REAL_CHROME" -H "Host: www.forexfactory.com" --resolve "www.forexfactory.com:443:$FF_IP"
echo ""

echo "━━━ HTTP/1.1 vs HTTP/2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
test_ff "Chrome + HTTP/1.1"         -H "$REAL_CHROME" --http1.1
test_ff "Chrome + HTTP/2"           -H "$REAL_CHROME" --http2
echo ""

echo "══════════════════════════════════════════════════════════════"
echo "Test complete."
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "If all fail: Cloudflare JS challenge likely in play."
echo "Try opening https://www.forexfactory.com/calendar in a real browser"
echo "and check if a CAPTCHA or JS challenge appears."
echo ""
echo "Next: run with --docker to test from inside the agent container"
echo "  bash scripts/shell/test-forexfactory-access.sh --docker"
