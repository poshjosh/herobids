#!/usr/bin/env bash
# browser-pool-agent-browser-smoke-test.sh — Smoke test for agent-browser CLI
# connecting to the local Browserless browser-pool.
#
# Verifies the full chain: agent-browser CLI → Browserless CDP → page
# interaction → cleanup. This catches:
#   - Browserless API v1/v2 incompatibility with agent-browser
#   - Network reachability from a Docker container to browser-pool
#   - agent-browser binary compatibility on Alpine (musl libc + gcompat shim)
#   - Session acquire / snapshot / close lifecycle
#
# Tests:
#   1. browser-pool healthcheck (/json/version reachable)
#   2. agent-browser install + version check (binary runs on Alpine with gcompat)
#   3. agent-browser open (acquires CDP session via --cdp flag)
#   4. agent-browser snapshot (DOM snapshot via CDP)
#   5. agent-browser close (session released)
#
# Usage:
#   scripts/shell/tests/browser-pool-agent-browser-smoke-test.sh
#   BROWSER_POOL_HOST=browser-pool:3000 scripts/shell/tests/browser-pool-agent-browser-smoke-test.sh
#
# Prerequisites:
#   - docker (with compose plugin)
#   - browser-pool service running (docker-compose.dev.yaml)
#   - Internet access (to npm install agent-browser inside the test container)
#
# Environment:
#   BROWSER_POOL_HOST    Host:port for browserless (default: browser-pool:3000)
#   COMPOSE_DEV_FILE     Path to dev compose file (default: docker-compose.dev.yaml)
#   SKIP_POOL_START      Set to 1 to skip auto-starting browser-pool (assume it's up)
#
# Exit code: 0 if all checks pass, 1 if any check fails.

set -euo pipefail

# ─── Resolve project root ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

COMPOSE_BASE="${ROOT}/docker-compose.yaml"
COMPOSE_DEV="${ROOT}/${COMPOSE_DEV_FILE:-docker-compose.dev.yaml}"
BROWSER_POOL_HOST="${BROWSER_POOL_HOST:-browser-pool:3000}"
BROWSER_POOL_HOST_PORT="${BROWSER_POOL_HOST_PORT:-3001}"  # host-mapped port

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'
  YELLOW='\033[0;33m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; RED=''; CYAN=''; YELLOW=''; BOLD=''; RESET=''
fi

TAG="browser-smoke"
log()  { echo -e "${CYAN}[${TAG}]${RESET} $*"; }
ok()   { echo -e "${GREEN}[${TAG}]${RESET} ✓ $*"; }
warn() { echo -e "${YELLOW}[${TAG}]${RESET} $*"; }
err()  { echo -e "${RED}[${TAG}]${RESET} ✗ $*" >&2; }

# ─── State ───────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
POOL_STARTED=false

check_pass() { ok "$1"; PASS=$(( PASS + 1 )); }
check_fail() { err "$1"; FAIL=$(( FAIL + 1 )); }

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  if [[ "${POOL_STARTED}" == "true" ]]; then
    warn "Stopping browser-pool (started by this script)…"
    docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}" stop browser-pool 2>/dev/null || true
    docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}" rm -f browser-pool 2>/dev/null || true
  fi
  exit $exit_code
}
trap cleanup EXIT

# ─── Argument parsing ────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ─── Preflight: verify compose files exist ────────────────────────────────────

if [[ ! -f "${COMPOSE_BASE}" ]]; then
  err "Base compose file not found: ${COMPOSE_BASE}"
  exit 1
fi
if [[ ! -f "${COMPOSE_DEV}" ]]; then
  err "Dev compose file not found: ${COMPOSE_DEV}"
  exit 1
fi

# ─── Step 1: Ensure browser-pool is running ──────────────────────────────────

log "Ensuring browser-pool is running…"

pool_healthy() {
  curl -sf -o /dev/null "http://localhost:${BROWSER_POOL_HOST_PORT}/json/version" 2>/dev/null
}

if [[ "${SKIP_POOL_START:-0}" == "1" ]]; then
  log "SKIP_POOL_START=1 — assuming browser-pool is up."
elif pool_healthy; then
  log "browser-pool already healthy on host port ${BROWSER_POOL_HOST_PORT}."
else
  log "Starting browser-pool via docker compose…"
  docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}" up -d browser-pool
  POOL_STARTED=true

  # Wait for healthy (up to 60s — image pull on first run can be slow)
  retries=30
  while [[ $retries -gt 0 ]]; do
    if pool_healthy; then
      break
    fi
    sleep 2
    (( retries-- ))
  done

  if [[ $retries -eq 0 ]]; then
    err "browser-pool did not become healthy on port ${BROWSER_POOL_HOST_PORT} within 60s"
    exit 1
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 1: browser-pool healthcheck
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 1: browser-pool healthcheck ──"

version_json=$(curl -sf "http://localhost:${BROWSER_POOL_HOST_PORT}/json/version" 2>/dev/null || echo "")
if [[ -n "${version_json}" ]]; then
  browser=$(echo "${version_json}" | jq -r '.Browser // "unknown"' 2>/dev/null || echo "unknown")
  ws_url=$(echo "${version_json}" | jq -r '.["webSocketDebuggerUrl"] // "none"' 2>/dev/null || echo "none")
  check_pass "browser-pool reachable — Browser: ${browser}"
else
  check_fail "browser-pool /json/version not reachable on port ${BROWSER_POOL_HOST_PORT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 2–5: agent-browser CLI tests inside a Docker container
#
# We run a disposable node:22-alpine container on the same Docker network as
# browser-pool. This mirrors the production topology: agent container → browser
# pool over Docker network.
# ═══════════════════════════════════════════════════════════════════════════════

log "── Tests 2-5: agent-browser CLI (in Docker container) ──"

# Resolve the Docker network. Compose v2 uses "<project>_default".
# The project name defaults to the directory name of the compose file.
COMPOSE_PROJECT=$(docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}" config --format json 2>/dev/null \
  | jq -r '.name // empty' 2>/dev/null || echo "")
if [[ -z "${COMPOSE_PROJECT}" ]]; then
  # Fallback: derive from directory name
  COMPOSE_PROJECT="$(basename "${ROOT}")"
fi
DOCKER_NETWORK="${COMPOSE_PROJECT}_default"

# Verify network exists
if ! docker network inspect "${DOCKER_NETWORK}" > /dev/null 2>&1; then
  err "Docker network '${DOCKER_NETWORK}' not found. Is docker compose up?"
  err "Available networks:"
  docker network ls --format '  {{.Name}}' 2>/dev/null || true
  exit 1
fi

log "Using Docker network: ${DOCKER_NETWORK}"
log "Browser pool address (in-container): http://${BROWSER_POOL_HOST}"

# Build the test script that runs inside the container.
# agent-browser is installed via npm. It connects to our self-hosted
# Browserless instance via --cdp flag (not -p browserless, which is not
# available in agent-browser v0.14.0).
# gcompat is required because the pre-built Rust binary links against glibc.
CONTAINER_SCRIPT='#!/bin/sh

echo "[container] Installing gcompat (glibc shim for agent-browser)…"
apk add --no-cache gcompat 2>&1 | tail -3

echo "[container] Installing agent-browser…"
npm install -g agent-browser@0.14.0 2>&1 | tail -3
INSTALL_RC=$?
if [ "$INSTALL_RC" -ne 0 ]; then
  echo "INSTALL_FAILED:npm install exited with code $INSTALL_RC"
fi

# CDP URL for connecting to Browserless (not -p browserless which does not
# exist in v0.14.0).
CDP_URL="ws://${BROWSERLESS_HOST}/"

# ── Test 2: version check ──────────────────────────────────────────────────
echo ""
echo "TEST_2_START"
AB_VERSION=$(agent-browser --version 2>&1 || echo "INSTALL_FAILED")
if echo "${AB_VERSION}" | grep -qE "[0-9]+\.[0-9]+"; then
  echo "RESULT:PASS:${AB_VERSION}"
else
  echo "RESULT:FAIL:agent-browser --version failed: ${AB_VERSION}"
fi
echo "TEST_2_END"

# ── Test 3: open page ─────────────────────────────────────────────────────
echo ""
echo "TEST_3_START"
OPEN_OUT=$(agent-browser --cdp "${CDP_URL}" open https://example.com 2>&1) || true
if echo "${OPEN_OUT}" | grep -qi "opened\|navigat\|ready\|success\|example\.com"; then
  echo "RESULT:PASS:agent-browser open succeeded"
else
  echo "RESULT:FAIL:agent-browser open output: ${OPEN_OUT}"
fi
echo "TEST_3_END"

# ── Test 4: snapshot ──────────────────────────────────────────────────────
echo ""
echo "TEST_4_START"
SNAP_OUT=$(agent-browser --cdp "${CDP_URL}" snapshot 2>&1) || true
if echo "${SNAP_OUT}" | grep -qi "example\|domain\|more information\|illustrative\|iana"; then
  echo "RESULT:PASS:snapshot contains expected content from example.com"
else
  echo "RESULT:FAIL:snapshot output unexpected: $(echo "${SNAP_OUT}" | head -5)"
fi
echo "TEST_4_END"

# ── Test 5: close ─────────────────────────────────────────────────────────
echo ""
echo "TEST_5_START"
CLOSE_OUT=$(agent-browser --cdp "${CDP_URL}" close 2>&1) || true
if echo "${CLOSE_OUT}" | grep -qi "close\|stopped\|session\|done\|bye\|success"; then
  echo "RESULT:PASS:agent-browser close succeeded"
else
  # agent-browser close often produces no output on success — that is fine too
  if [ -z "${CLOSE_OUT}" ]; then
    echo "RESULT:PASS:agent-browser close succeeded (silent exit)"
  else
    echo "RESULT:FAIL:agent-browser close output: ${CLOSE_OUT}"
  fi
fi
echo "TEST_5_END"

echo ""
echo "ALL_TESTS_DONE"
'

# Run the container with a 120s watchdog.
# macOS lacks coreutils `timeout`, so we use a background kill approach.
log "Launching test container on network ${DOCKER_NETWORK}…"

CONTAINER_OUTPUT=""
CONTAINER_EXIT=0

# Start docker run in background, capture output to a temp file
TMPOUT=$(mktemp)
docker run --rm \
  --network "${DOCKER_NETWORK}" \
  -e "BROWSERLESS_HOST=${BROWSER_POOL_HOST}" \
  -e "NODE_NO_WARNINGS=1" \
  node:22-alpine \
  sh -c "${CONTAINER_SCRIPT}" > "${TMPOUT}" 2>&1 &
DOCKER_PID=$!

# Watchdog: kill after 120s
( sleep 120 && kill "${DOCKER_PID}" 2>/dev/null ) &
WATCHDOG_PID=$!

# Wait for docker run to finish
wait "${DOCKER_PID}" 2>/dev/null || CONTAINER_EXIT=$?

# Cancel the watchdog if the container finished in time
kill "${WATCHDOG_PID}" 2>/dev/null || true
wait "${WATCHDOG_PID}" 2>/dev/null || true

CONTAINER_OUTPUT=$(cat "${TMPOUT}")
rm -f "${TMPOUT}"

if [[ ${CONTAINER_EXIT} -ne 0 ]]; then
  # Check if it was killed by the watchdog (exit 137 = SIGKILL, 143 = SIGTERM)
  if [[ ${CONTAINER_EXIT} -eq 137 || ${CONTAINER_EXIT} -eq 143 ]]; then
    warn "Test container timed out after 120s (killed by watchdog)"
  else
    warn "Test container exited with code ${CONTAINER_EXIT}"
  fi
  if [[ -n "${CONTAINER_OUTPUT}" ]]; then
    warn "Container output (last 20 lines):"
    echo "${CONTAINER_OUTPUT}" | tail -20
  fi
  # Don't exit — fall through to parse whatever results we got
fi

# Parse results from container output
parse_result() {
  local test_num="$1"
  local block
  block=$(echo "${CONTAINER_OUTPUT}" | sed -n "/TEST_${test_num}_START/,/TEST_${test_num}_END/p")
  local result_line
  result_line=$(echo "${block}" | grep "^RESULT:" | head -1)
  if [[ -z "${result_line}" ]]; then
    check_fail "Test ${test_num}: no result line found"
    return
  fi
  local status
  status=$(echo "${result_line}" | cut -d: -f2)
  local message
  message=$(echo "${result_line}" | cut -d: -f3-)
  if [[ "${status}" == "PASS" ]]; then
    check_pass "${message}"
  else
    check_fail "${message}"
  fi
}

parse_result 2
parse_result 3
parse_result 4
parse_result 5

# Check the container ran to completion
if ! echo "${CONTAINER_OUTPUT}" | grep -q "ALL_TESTS_DONE"; then
  warn "Container did not reach ALL_TESTS_DONE marker. Partial output:"
  echo "${CONTAINER_OUTPUT}" | tail -30
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "──────────────────────────────────────────"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "──────────────────────────────────────────"

if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
