#!/usr/bin/env bash
# validate-swap-venue.sh — Operator-run platform health + upstream quote reachability check.
#
# This script is NOT part of CI. It validates that the HeroBids API health
# endpoint responds and that upstream venue quote APIs are reachable from the
# host environment running this script. It does NOT check worker process health
# or actual trade-path readiness.
#
# It does NOT validate HeroBids adapter wiring, signer execution, confirmation
# polling, or evidence capture. Those require a dedicated end-to-end swap trade
# test harness (not yet automated).
#
# Usage:
#   VENUE=jupiter ./scripts/shell/tests/validate-swap-venue.sh
#   VENUE=1inch  ./scripts/shell/tests/validate-swap-venue.sh
#
# Prerequisites:
#   Jupiter:
#     - No wallet secrets are required for this script.
#
#   1inch:
#     - ONEINCH_API_KEY: 1inch developer portal API key
#
# Both venues:
#     - API_BASE_URL: HeroBids API (default: http://localhost:3000)
#     - Stack must be running (Docker + API healthy)
#
# What this script validates:
#   1. Required environment variables are present for the upstream API call
#   2. API health check (platform is running)
#   3. Venue API reachable (direct probe)
#   4. Quote request succeeds for a known-safe pair (direct venue API call)
#
# Exit codes:
#   0 = all checks passed
#   1 = validation failed (venue unreachable, probe failed, quote failed)
#   2 = missing prerequisites (env vars not set)

set -euo pipefail

VENUE="${VENUE:-jupiter}"
API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
EXECUTION_MODE="${EXECUTION_MODE:-shadow}"  # retained for operator messaging; does not change validation depth

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[✗]${NC} $*"; exit 1; }
prereq_fail() { echo -e "${RED}[✗]${NC} $*"; exit 2; }

# ─── Prerequisites ───────────────────────────────────────────────────────────

check_common_prereqs() {
  command -v jq >/dev/null 2>&1 || prereq_fail "jq is required to parse venue quote responses"
}

check_jupiter_prereqs() {
  if [[ "${EXECUTION_MODE}" == "live" ]]; then
    warn "EXECUTION_MODE=live does not exercise signer execution in this script; it only checks upstream reachability."
  fi
  log "Jupiter upstream quote check prerequisites present"
}

check_1inch_prereqs() {
  [[ -n "${ONEINCH_API_KEY:-}" ]] || prereq_fail "ONEINCH_API_KEY is required for 1inch validation"
  if [[ "${EXECUTION_MODE}" == "live" ]]; then
    warn "EXECUTION_MODE=live does not exercise signer execution or router filtering in this script; it only checks upstream reachability."
  fi
  log "1inch upstream quote check prerequisites present"
}

# ─── Health Check ────────────────────────────────────────────────────────────

check_api_health() {
  local health_url="${API_BASE_URL}/health"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "${health_url}" 2>/dev/null) || true
  if [[ "${status}" != "200" ]]; then
    fail "API health check failed (${health_url} returned ${status}). Is the stack running?"
  fi
  log "API healthy at ${API_BASE_URL}"
}

# ─── Venue Probe ─────────────────────────────────────────────────────────────

probe_jupiter() {
  # Verify the Jupiter Quote API is reachable by fetching a minimal quote
  local probe_url="https://api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000&slippageBps=100"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "${probe_url}" 2>/dev/null) || true
  if [[ "${http_code}" != "200" ]]; then
    fail "Jupiter API probe failed (HTTP ${http_code}). Is the Jupiter Quote API reachable from this environment?"
  fi
  log "Jupiter API reachable (api.jup.ag)"
}

probe_1inch() {
  # Verify the 1inch API is reachable and the API key is valid
  local probe_url="https://api.1inch.dev/swap/v6.0/8453/tokens"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${ONEINCH_API_KEY}" "${probe_url}" 2>/dev/null) || true
  if [[ "${http_code}" == "401" || "${http_code}" == "403" ]]; then
    fail "1inch API auth failed (HTTP ${http_code}). Is ONEINCH_API_KEY valid?"
  fi
  if [[ "${http_code}" != "200" ]]; then
    fail "1inch API probe failed (HTTP ${http_code}). Is the 1inch API reachable from this environment?"
  fi
  log "1inch API reachable and authenticated (api.1inch.dev)"
}

probe_venue() {
  case "${VENUE}" in
    jupiter) probe_jupiter ;;
    1inch)   probe_1inch ;;
  esac
}

# ─── Quote Validation ────────────────────────────────────────────────────────

validate_jupiter_quote() {
  # Request a real quote from Jupiter for USDC → SOL (known-safe, liquid pair)
  local input_mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  # USDC
  local output_mint="So11111111111111111111111111111111111111112"      # SOL
  local raw_amount="1000000"  # 1 USDC (6 decimals)

  local quote_url="https://api.jup.ag/swap/v1/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${raw_amount}&slippageBps=100"
  local response http_code
  response=$(curl -s -w "\n%{http_code}" "${quote_url}" 2>/dev/null) || fail "Jupiter quote request failed (network error)"
  http_code=$(echo "${response}" | tail -1)
  local body
  body=$(echo "${response}" | sed '$d')

  if [[ "${http_code}" != "200" ]]; then
    fail "Jupiter quote returned HTTP ${http_code}. Body: ${body}"
  fi

  local out_amount
  out_amount=$(echo "${body}" | jq -r '.outAmount // empty' 2>/dev/null) || true
  if [[ -z "${out_amount}" || "${out_amount}" == "null" ]]; then
    fail "Jupiter quote response missing outAmount. Body: ${body}"
  fi

  log "Jupiter quote succeeded: 1 USDC → ${out_amount} lamports SOL"
}

validate_1inch_quote() {
  # Request a real quote from 1inch for USDC → WETH on Base (known-safe, liquid pair)
  local input_token="0x833589fCd6eDb6E08f4C7c32D4f71b54bdA02913"  # USDC on Base
  local output_token="0x4200000000000000000000000000000000000006"    # WETH on Base
  local raw_amount="1000000"  # 1 USDC (6 decimals)

  local quote_url="https://api.1inch.dev/swap/v6.0/8453/quote?src=${input_token}&dst=${output_token}&amount=${raw_amount}"
  local response http_code
  response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer ${ONEINCH_API_KEY}" "${quote_url}" 2>/dev/null) || fail "1inch quote request failed (network error)"
  http_code=$(echo "${response}" | tail -1)
  local body
  body=$(echo "${response}" | sed '$d')

  if [[ "${http_code}" != "200" ]]; then
    fail "1inch quote returned HTTP ${http_code}. Body: ${body}"
  fi

  local dst_amount
  dst_amount=$(echo "${body}" | jq -r '.dstAmount // empty' 2>/dev/null) || true
  if [[ -z "${dst_amount}" || "${dst_amount}" == "null" ]]; then
    fail "1inch quote response missing dstAmount. Body: ${body}"
  fi

  log "1inch quote succeeded: 1 USDC → ${dst_amount} wei WETH"
}

validate_quote() {
  case "${VENUE}" in
    jupiter) validate_jupiter_quote ;;
    1inch)   validate_1inch_quote ;;
    *)       fail "No known-safe quote pair for venue: ${VENUE}" ;;
  esac
}

# ─── Summary ─────────────────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Swap Venue Host Reachability Summary"
  echo "═══════════════════════════════════════════════════════"
  echo "  Venue:           ${VENUE}"
  echo "  Execution Mode:  ${EXECUTION_MODE}"
  echo "  API:             ${API_BASE_URL}"
  echo "  Timestamp:       $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "═══════════════════════════════════════════════════════"
  echo ""
  echo "  Checks completed:"
  echo "    [✓] Prerequisites validated"
  echo "    [✓] API health (platform running)"
  echo "    [✓] Venue API probe (direct connectivity)"
  echo "    [✓] Quote request (real venue response)"
  echo ""
  if [[ "${EXECUTION_MODE}" == "live" ]]; then
    echo "  NOTE: EXECUTION_MODE=live does not add signer or execution checks here."
    echo "  This script still validates only platform health plus upstream quote"
    echo "  reachability. Full live swap execution (submission, confirmation,"
    echo "  evidence capture) requires a dedicated swap trade-test harness."
  else
    echo "  Shadow mode: platform health + host-side upstream quote reachability complete."
    echo "  A separate end-to-end trade harness is still required for live validation."
  fi
  echo ""
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "Validating swap venue: ${VENUE} (mode: ${EXECUTION_MODE})"
  echo "───────────────────────────────────────────────────────"

  case "${VENUE}" in
    jupiter) check_jupiter_prereqs ;;
    1inch)   check_1inch_prereqs ;;
    *)       prereq_fail "Unsupported VENUE: ${VENUE}. Supported: jupiter, 1inch" ;;
  esac

  check_common_prereqs
  check_api_health
  probe_venue
  validate_quote
  print_summary

  log "Swap venue validation passed for ${VENUE}"
}

main "$@"
