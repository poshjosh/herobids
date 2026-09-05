#!/usr/bin/env bash
# sandbox-allowlist-smoke-test.sh — Smoke test for the SANDBOX_ALLOWED_HOSTS
# mechanism in sandbox-exec.sh.
#
# Verifies that the sandbox allowlist correctly punches targeted holes in the
# RFC 1918 block for operator-configured internal services (e.g. Browserless).
#
# Tests:
#   1. Without SANDBOX_ALLOWED_HOSTS, sandbox blocks access to a Docker-network
#      IP (simulated internal service on RFC 1918).
#   2. With SANDBOX_ALLOWED_HOSTS=<target-ip>, sandbox allows access to that IP.
#   3. With SANDBOX_ALLOWED_HOSTS=<target-ip>, other RFC 1918 addresses are
#      still blocked.
#
# Usage:
#   scripts/shell/tests/sandbox-allowlist-smoke-test.sh
#
# Prerequisites:
#   - docker (with compose plugin)
#   - docker-compose.yaml and docker-compose.dev.yaml in project root
#   - browser-pool service running (provides a known RFC 1918 target)
#
# Environment:
#   COMPOSE_DEV_FILE     Path to dev compose file (default: docker-compose.dev.yaml)
#   SKIP_POOL_START      Set to 1 to skip auto-starting browser-pool (assume it's up)
#   AGENT_IMAGE          Agent image to use (default: herobids-agent:latest)
#
# The test runs inside a container with CAP_NET_ADMIN and CAP_SYS_ADMIN
# (required by sandbox-exec.sh for network namespace creation).
#
# Exit code: 0 if all checks pass, 1 if any check fails.

set -euo pipefail

# ─── Resolve project root ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

COMPOSE_BASE="${ROOT}/docker-compose.yaml"
COMPOSE_DEV="${ROOT}/${COMPOSE_DEV_FILE:-docker-compose.dev.yaml}"
AGENT_IMAGE="${AGENT_IMAGE:-herobids-agent:latest}"
BROWSER_POOL_HOST_PORT="${BROWSER_POOL_HOST_PORT:-3001}"

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'
  YELLOW='\033[0;33m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; RED=''; CYAN=''; YELLOW=''; BOLD=''; RESET=''
fi

TAG="sandbox-allowlist"
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

# ─── Preflight: verify agent image exists ─────────────────────────────────────

if ! docker image inspect "${AGENT_IMAGE}" > /dev/null 2>&1; then
  err "Agent image '${AGENT_IMAGE}' not found. Build it first:"
  err "  docker build -f docker/Dockerfile.agent -t herobids-agent:latest ."
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

  retries=30
  while [[ $retries -gt 0 ]]; do
    if pool_healthy; then break; fi
    sleep 2
    (( retries-- ))
  done

  if [[ $retries -eq 0 ]]; then
    err "browser-pool did not become healthy on port ${BROWSER_POOL_HOST_PORT} within 60s"
    exit 1
  fi
fi

# ─── Resolve Docker network and browser-pool IP ─────────────────────────────

COMPOSE_PROJECT=$(docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}" config --format json 2>/dev/null \
  | jq -r '.name // empty' 2>/dev/null || echo "")
if [[ -z "${COMPOSE_PROJECT}" ]]; then
  COMPOSE_PROJECT="$(basename "${ROOT}")"
fi
DOCKER_NETWORK="${COMPOSE_PROJECT}_default"

if ! docker network inspect "${DOCKER_NETWORK}" > /dev/null 2>&1; then
  err "Docker network '${DOCKER_NETWORK}' not found. Is docker compose up?"
  docker network ls --format '  {{.Name}}' 2>/dev/null || true
  exit 1
fi

# Find the browser-pool container IP on the compose network.
BROWSER_POOL_CONTAINER=$(docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}" ps -q browser-pool 2>/dev/null | head -1)
if [[ -z "${BROWSER_POOL_CONTAINER}" ]]; then
  err "browser-pool container not found. Is the service running?"
  exit 1
fi

BROWSER_POOL_IP=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "${BROWSER_POOL_CONTAINER}" 2>/dev/null)
if [[ -z "${BROWSER_POOL_IP}" ]]; then
  err "Could not resolve browser-pool container IP"
  exit 1
fi

log "Docker network: ${DOCKER_NETWORK}"
log "browser-pool IP: ${BROWSER_POOL_IP}"

# Pick a decoy IP that is definitely not assigned to any container on the network.
# Use an address in 172.16.0.0/12 that is far from the Docker-assigned range.
DECOY_IP="172.31.255.254"
log "Decoy (unreachable RFC 1918) IP: ${DECOY_IP}"

# ═══════════════════════════════════════════════════════════════════════════════
# Test 1: Without SANDBOX_ALLOWED_HOSTS, sandbox blocks browser-pool IP
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 1: sandbox blocks RFC 1918 without allowlist ──"

# Run sandbox-exec.sh inside the agent container without SANDBOX_ALLOWED_HOSTS.
# Attempt to curl the browser-pool IP — should be rejected by iptables.
TEST1_OUTPUT=$(docker run --rm \
  --network "${DOCKER_NETWORK}" \
  --cap-add NET_ADMIN \
  --cap-add SYS_ADMIN \
  "${AGENT_IMAGE}" \
  sh -c "sandbox-exec.sh sh -c 'wget -q -T 5 -O - http://${BROWSER_POOL_IP}:3000/json/version 2>&1 || echo BLOCKED'" 2>&1) || true

if echo "${TEST1_OUTPUT}" | grep -qi "BLOCKED\|refused\|reject\|unreachable\|timed out\|can't connect\|bad address\|reset"; then
  check_pass "sandbox blocks browser-pool IP (${BROWSER_POOL_IP}) without SANDBOX_ALLOWED_HOSTS"
else
  check_fail "sandbox did NOT block browser-pool IP without allowlist. Output: $(echo "${TEST1_OUTPUT}" | tail -3)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 2: With SANDBOX_ALLOWED_HOSTS, sandbox allows browser-pool IP
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 2: sandbox allows allowlisted IP ──"

TEST2_OUTPUT=$(docker run --rm \
  --network "${DOCKER_NETWORK}" \
  --cap-add NET_ADMIN \
  --cap-add SYS_ADMIN \
  -e "SANDBOX_ALLOWED_HOSTS=${BROWSER_POOL_IP}" \
  "${AGENT_IMAGE}" \
  sh -c "sandbox-exec.sh sh -c 'wget -q -T 10 -O - http://${BROWSER_POOL_IP}:3000/json/version 2>&1'" 2>&1) || true

if echo "${TEST2_OUTPUT}" | grep -qi "Browser\|webSocketDebuggerUrl\|Chrome"; then
  check_pass "sandbox allows browser-pool IP (${BROWSER_POOL_IP}) when in SANDBOX_ALLOWED_HOSTS"
else
  check_fail "sandbox did NOT allow browser-pool IP with allowlist. Output: $(echo "${TEST2_OUTPUT}" | tail -5)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 3: With SANDBOX_ALLOWED_HOSTS, other RFC 1918 IPs are still blocked
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 3: non-allowlisted RFC 1918 IP still blocked ──"

TEST3_OUTPUT=$(docker run --rm \
  --network "${DOCKER_NETWORK}" \
  --cap-add NET_ADMIN \
  --cap-add SYS_ADMIN \
  -e "SANDBOX_ALLOWED_HOSTS=${BROWSER_POOL_IP}" \
  "${AGENT_IMAGE}" \
  sh -c "sandbox-exec.sh sh -c 'wget -q -T 5 -O - http://${DECOY_IP}:80/ 2>&1 || echo BLOCKED'" 2>&1) || true

if echo "${TEST3_OUTPUT}" | grep -qi "BLOCKED\|refused\|reject\|unreachable\|timed out\|can't connect\|bad address\|reset"; then
  check_pass "sandbox still blocks non-allowlisted RFC 1918 IP (${DECOY_IP})"
else
  check_fail "sandbox did NOT block decoy RFC 1918 IP (${DECOY_IP}). Output: $(echo "${TEST3_OUTPUT}" | tail -3)"
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
