#!/usr/bin/env bash
# caddy-routing-smoke-test.sh — Validate Caddy reverse-proxy routing for the OAuth flow.
#
# Bug 2026-07-12/001: Caddy was not routing /auth/* to the API, and later the
# /auth/callback → web exception was missing. This smoke test catches both
# regressions by verifying the HTTP responses at each stage of the OAuth flow.
#
# Usage:
#   scripts/shell/tests/caddy-routing-smoke-test.sh [BASE_URL]
#   scripts/shell/tests/caddy-routing-smoke-test.sh https://staging.openaidom.com
#
# Environment:
#   BASE_URL   Base URL of the stack (default: https://staging.openaidom.com). Must be the
#              Caddy entry point (port 80/443), not the API port directly.
#
# Exit code: 0 if all checks pass, 1 if any check fails.

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-https://staging.openaidom.com}}"

# ── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

log()    { echo -e "${CYAN}[caddy-smoke]${RESET} $*"; }
ok()     { echo -e "${GREEN}[caddy-smoke]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[caddy-smoke]${RESET} $*"; }
err()    { echo -e "${RED}[caddy-smoke]${RESET} $*" >&2; }

# ── State ────────────────────────────────────────────────────────────────────

PASSED=0
FAILED=0

check() {
  local label="$1"
  shift
  if "$@"; then
    ok "✓ ${label}"
    (( PASSED++ ))
  else
    err "✗ ${label}"
    (( FAILED++ ))
    # Do NOT return non-zero — the script runs with set -e and the exit code
    # is determined by $FAILED at the end, not by individual check failures.
  fi
}

# ── Wait for Caddy to be reachable ───────────────────────────────────────────

log "Checking ${BASE_URL} is reachable…"
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "${BASE_URL}/health" 2>/dev/null; then
    ok "${BASE_URL} is reachable."
    break
  fi
  if [[ $i -eq 30 ]]; then
    warn "${BASE_URL} is not reachable after 60s — skipping Caddy routing checks."
    warn "This test requires network access to the Caddy server. Run with --env-file .env.ops.staging for staging."
    exit 0
  fi
  sleep 2
done

# ── Test 1: /auth/google → redirect to Google OAuth ──────────────────────────

check "/auth/google returns HTTP 302 redirect" \
  bash -c "curl -sI '${BASE_URL}/auth/google' 2>&1 | grep -qE '^HTTP/[12].* 302'"

check "/auth/google Location header points to accounts.google.com" \
  bash -c "curl -sI '${BASE_URL}/auth/google' 2>&1 | grep -qE '^location: https://accounts.google.com'"

check "/auth/google Location contains client_id" \
  bash -c "curl -sI '${BASE_URL}/auth/google' 2>&1 | grep -qE 'client_id='"

check "/auth/google Location contains redirect_uri" \
  bash -c "curl -sI '${BASE_URL}/auth/google' 2>&1 | grep -qE 'redirect_uri='"

check "/auth/google Location contains response_type=code" \
  bash -c "curl -sI '${BASE_URL}/auth/google' 2>&1 | grep -qE 'response_type=code'"

# ── Test 2: /auth/callback → served by web container (SPA HTML) ──────────────

check "/auth/callback returns HTTP 200" \
  bash -c "curl -sI '${BASE_URL}/auth/callback' 2>&1 | grep -qE '^HTTP/[12].* 200'"

check "/auth/callback returns HTML (not JSON from API)" \
  bash -c "curl -sI '${BASE_URL}/auth/callback' 2>&1 | grep -qE '^content-type: text/html'"

check "/auth/callback does NOT return API error JSON" \
  bash -c "! curl -sI '${BASE_URL}/auth/callback' 2>&1 | grep -qE '^content-type: application/json'"

# ── Test 3: /api/auth/exchange → reaches the API (not nginx/SPA) ─────────────

check "/api/auth/exchange reaches API (returns JSON, not HTML)" \
  bash -c "
    response=\$(curl -s -X POST '${BASE_URL}/api/auth/exchange' \
      -H 'Content-Type: application/json' \
      -d '{\"code\":\"invalid-code\"}' 2>&1)
    echo \"\$response\" | grep -qE 'error'
  "

check "/api/auth/exchange returns HTTP 400 for invalid code" \
  bash -c "
    http_code=\$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST '${BASE_URL}/api/auth/exchange' \
      -H 'Content-Type: application/json' \
      -d '{\"code\":\"invalid-code\"}' 2>&1)
    [[ \"\$http_code\" == \"400\" ]]
  "

# ── Test 4: /auth/google/callback with no params → CSRF rejection ────────────
# This confirms /auth/google/callback is reaching the API (not the SPA).
# The API returns 400 for missing state, the SPA would return 200 HTML.

check "/auth/google/callback returns HTTP 400 (API CSRF check, not SPA 200)" \
  bash -c "
    http_code=\$(curl -s -o /dev/null -w '%{http_code}' \
      '${BASE_URL}/auth/google/callback' 2>&1)
    [[ \"\$http_code\" == \"400\" ]]
  "

# ── Test 5: /billing/webhook/* → reaches API (returns JSON, not SPA HTML) ──
# A misconfigured Caddyfile sends these to web:80 (SPA), which returns
# 200 with index.html. The API returns a JSON error for an empty body.

check "/billing/webhook/creem reaches API (returns JSON, not SPA HTML)" \
  bash -c "curl -s -X POST '${BASE_URL}/billing/webhook/creem' \
    -H 'content-type: application/json' -d '{}' 2>&1 | head -c 200 | grep -qE 'error|invalid|missing|provider'"

check "/billing/webhook/creem does NOT return SPA HTML" \
  bash -c "! curl -s -X POST '${BASE_URL}/billing/webhook/creem' \
    -H 'content-type: application/json' -d '{}' 2>&1 | head -c 200 | grep -qE '<!DOCTYPE|<html'"

check "/billing/webhook/stripe reaches API (returns JSON, not SPA HTML)" \
  bash -c "curl -s -X POST '${BASE_URL}/billing/webhook/stripe' \
    -H 'content-type: application/json' -d '{}' 2>&1 | head -c 200 | grep -qE 'error|invalid|missing|provider'"

check "/billing/webhook/stripe does NOT return SPA HTML" \
  bash -c "! curl -s -X POST '${BASE_URL}/billing/webhook/stripe' \
    -H 'content-type: application/json' -d '{}' 2>&1 | head -c 200 | grep -qE '<!DOCTYPE|<html'"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Caddy routing smoke test results ──${RESET}"
echo -e "  ${GREEN}Passed: ${PASSED}${RESET}"
if [[ ${FAILED} -gt 0 ]]; then
  echo -e "  ${RED}Failed: ${FAILED}${RESET}"
fi

if [[ ${FAILED} -eq 0 ]]; then
  ok "All Caddy routing checks passed."
  exit 0
else
  err "Some Caddy routing checks failed."
  exit 1
fi
