#!/usr/bin/env bash
# sandbox-allowlist-smoke-test.sh — Smoke test for the UID-based egress rules
# (scripts/sandbox-egress.sh) and the SANDBOX_ALLOWED_HOSTS allowlist.
#
# The sandbox no longer creates a network namespace. The entrypoint installs iptables
# rules at container start that reject private networks for the agent user only.
# Commands are run the same way the worker runs standard-mode commands:
#   sandbox-exec.sh sudo -u agent sh -c '<command>'
#
# Tests:
#   0. With NET_ADMIN, the entrypoint installs the egress rules (marker present).
#   1. Standard command, no allowlist: the browser-pool IP is rejected.
#   2. Standard command, SANDBOX_ALLOWED_HOSTS=<browser-pool IP>: reachable.
#   3. Standard command, allowlist set: an unlisted RFC 1918 IP is still rejected.
#   4. Root command, no allowlist: the browser-pool IP is reachable. Root is not
#      restricted by these rules. This is intended (full mode, execute_code).
#   5. Without NET_ADMIN: the marker is absent and sandbox-exec.sh refuses with
#      exit 97 ("sandbox egress rules not active in this container").
#
# Not covered: fail-closed boot when a rule fails to install. That needs a container
# where iptables fails on purpose. Check it by hand if the entrypoint changes.
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
# Test containers get CAP_NET_ADMIN only. CAP_SYS_ADMIN is not granted: the
# sandbox no longer needs it.
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

# Decoy: an RFC 1918 address with no container on the network.
DECOY_IP="172.31.255.254"
log "Decoy (unreachable RFC 1918) IP: ${DECOY_IP}"

# Shared pattern for "the connection was refused or blocked".
BLOCKED_PATTERN="BLOCKED|refused|reject|unreachable|timed out|can't connect|bad address|reset"

# Runs a command in a fresh agent container with NET_ADMIN only.
# Usage: run_in_container [-e VAR=value ...] -- <shell command>
run_in_container() {
  local env_args=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    env_args+=(-e "$1")
    shift
  done
  shift # drop --
  docker run --rm \
    --network "${DOCKER_NETWORK}" \
    --cap-add NET_ADMIN \
    "${env_args[@]+"${env_args[@]}"}" \
    "${AGENT_IMAGE}" \
    sh -c "$1" 2>&1 || true
}

# ═══════════════════════════════════════════════════════════════════════════════
# Test 0: NET_ADMIN makes the entrypoint install the egress rules
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 0: entrypoint installs egress rules when NET_ADMIN is granted ──"

TEST0_OUTPUT=$(run_in_container -- 'test -f /run/herobids/sandbox-egress-ready && echo MARKER_OK')

if echo "${TEST0_OUTPUT}" | grep -q "MARKER_OK"; then
  check_pass "egress marker present with NET_ADMIN"
else
  check_fail "egress marker missing with NET_ADMIN. Output: $(echo "${TEST0_OUTPUT}" | tail -3)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 1: standard command, no allowlist: browser-pool IP is rejected
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 1: standard command blocked from RFC 1918 without allowlist ──"

TEST1_OUTPUT=$(run_in_container -- \
  "sandbox-exec.sh sudo -u agent sh -c 'wget -q -T 5 -O - http://${BROWSER_POOL_IP}:3000/json/version 2>&1 || echo BLOCKED'")

if echo "${TEST1_OUTPUT}" | grep -qiE "${BLOCKED_PATTERN}"; then
  check_pass "standard command blocked from browser-pool IP (${BROWSER_POOL_IP}) without allowlist"
else
  check_fail "standard command reached browser-pool IP without allowlist. Output: $(echo "${TEST1_OUTPUT}" | tail -3)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 2: standard command, allowlisted browser-pool IP is reachable
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 2: standard command reaches allowlisted IP ──"

TEST2_OUTPUT=$(run_in_container "SANDBOX_ALLOWED_HOSTS=${BROWSER_POOL_IP}" -- \
  "sandbox-exec.sh sudo -u agent sh -c 'wget -q -T 10 -O - http://${BROWSER_POOL_IP}:3000/json/version 2>&1'")

if echo "${TEST2_OUTPUT}" | grep -qiE "Browser|webSocketDebuggerUrl|Chrome"; then
  check_pass "standard command reaches browser-pool IP (${BROWSER_POOL_IP}) when allowlisted"
else
  check_fail "standard command could not reach allowlisted IP. Output: $(echo "${TEST2_OUTPUT}" | tail -5)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 3: standard command, allowlist set: an unlisted RFC 1918 IP is still rejected
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 3: standard command still blocked from unlisted RFC 1918 IP ──"

TEST3_OUTPUT=$(run_in_container "SANDBOX_ALLOWED_HOSTS=${BROWSER_POOL_IP}" -- \
  "sandbox-exec.sh sudo -u agent sh -c 'wget -q -T 5 -O - http://${DECOY_IP}:80/ 2>&1 || echo BLOCKED'")

if echo "${TEST3_OUTPUT}" | grep -qiE "${BLOCKED_PATTERN}"; then
  check_pass "standard command still blocked from unlisted RFC 1918 IP (${DECOY_IP})"
else
  check_fail "standard command reached unlisted RFC 1918 IP (${DECOY_IP}). Output: $(echo "${TEST3_OUTPUT}" | tail -3)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 4: root command is not restricted (intended; full mode and execute_code)
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 4: root command reaches RFC 1918 (not restricted by design) ──"

TEST4_OUTPUT=$(run_in_container -- \
  "sandbox-exec.sh sh -c 'wget -q -T 10 -O - http://${BROWSER_POOL_IP}:3000/json/version 2>&1'")

if echo "${TEST4_OUTPUT}" | grep -qiE "Browser|webSocketDebuggerUrl|Chrome"; then
  check_pass "root command reaches browser-pool IP (rules are UID-scoped)"
else
  check_fail "root command could not reach browser-pool IP. Output: $(echo "${TEST4_OUTPUT}" | tail -5)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 5: without NET_ADMIN, sandbox-exec.sh refuses to run commands
# ═══════════════════════════════════════════════════════════════════════════════

log "── Test 5: no NET_ADMIN means commands are refused (exit 97) ──"

TEST5_OUTPUT=$(docker run --rm \
  --network "${DOCKER_NETWORK}" \
  "${AGENT_IMAGE}" \
  sh -c "sandbox-exec.sh true; echo EXIT=\$?" 2>&1 || true)

if echo "${TEST5_OUTPUT}" | grep -q "sandbox egress rules not active in this container" \
  && echo "${TEST5_OUTPUT}" | grep -q "EXIT=97"; then
  check_pass "commands refused without NET_ADMIN (exit 97)"
else
  check_fail "commands not refused without NET_ADMIN. Output: $(echo "${TEST5_OUTPUT}" | tail -3)"
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
