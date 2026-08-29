#!/usr/bin/env bash
# autoscale-agent-trigger-test.sh — Trigger autoscale via real agent creation.
#
# Creates enough agents via the API to consume cluster capacity below the
# scale-out threshold, waits for the autoscaler to provision a new node,
# then cleans up. This is a manual-only test — NOT included in run-extra-tests.sh.
#
# Usage:
#   scripts/shell/tests/autoscale-agent-trigger-test.sh \
#     --env staging --backend-env-file infra/hetzner/.env.backend \
#     --env-file .env.ops.staging
#
# Options:
#   --env <name>              Target environment: staging or production (default: staging).
#   --backend-env-file <path> Path to .env.backend file (for resolving server IP via terraform).
#   --env-file <path>         Path to env file with TEST_EMAIL, TEST_PASSWORD, API_BASE_URL.
#   --skip-cleanup            Leave agents running for manual inspection.
#   --help                    Show this help message.
#
# Environment variables:
#   API_BASE_URL          API root (default: from CADDY_BASE_URL or http://localhost:3000)
#   TEST_EMAIL            Test user email
#   TEST_PASSWORD         Test user password
#
# Prerequisites:
#   - API server running and reachable.
#   - SSH access to the control plane (herobids_deploy_key).
#   - /etc/herobids/autoscale.env present on the server.
#
# Exit code: 0 if scale-out triggered and verified, 1 if any check fails.

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
INFRA_DIR="${ROOT}/infra/hetzner"

source "${INFRA_DIR}/scripts/_ssh_opts.sh"

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'
  YELLOW='\033[0;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; CYAN=''; RESET=''
fi

log()  { echo -e "${CYAN}[agent-trigger]${RESET} $*"; }
ok()   { echo -e "${GREEN}[agent-trigger]${RESET} $*"; }
warn() { echo -e "${YELLOW}[agent-trigger]${RESET} $*"; }
err()  { echo -e "${RED}[agent-trigger]${RESET} $*" >&2; }

# ─── State ────────────────────────────────────────────────────────────────────

PASSED=0
FAILED=0
AGENT_IDS=()
SKIP_CLEANUP=false
TOKEN=""

check() {
  local label="$1"
  shift
  if "$@"; then
    ok "  ✓ ${label}"
    (( PASSED++ )) || true
  else
    err "  ✗ ${label}"
    (( FAILED++ )) || true
  fi
}

# ─── Argument parsing ────────────────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

BACKEND_ENV_FILE=""
ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-env-file)
      BACKEND_ENV_FILE="${2:-}"
      if [[ -z "${BACKEND_ENV_FILE}" ]]; then
        echo "ERROR: --backend-env-file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      if [[ -z "${ENV_FILE}" ]]; then
        echo "ERROR: --env-file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      err "Unknown option: $1"
      exit 1
      ;;
    *)
      shift
      ;;
  esac
done

# Source env file if provided (for TEST_EMAIL, TEST_PASSWORD, API_BASE_URL)
if [[ -n "${ENV_FILE}" ]]; then
  if [[ "${ENV_FILE}" != /* ]]; then
    ENV_FILE="${ROOT}/${ENV_FILE}"
  fi
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  else
    warn "Env file not found: ${ENV_FILE}"
  fi
fi

# Source backend env file if provided (for terraform / server IP)
if [[ -n "${BACKEND_ENV_FILE}" ]]; then
  if [[ "${BACKEND_ENV_FILE}" != /* ]]; then
    BACKEND_ENV_FILE="${ROOT}/${BACKEND_ENV_FILE}"
  fi
  if [[ -f "${BACKEND_ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${BACKEND_ENV_FILE}"
    set +a
  fi
fi

# ─── Defaults ─────────────────────────────────────────────────────────────────

API="${API_BASE_URL:-${CADDY_BASE_URL:-http://localhost:3000}}"
TEST_EMAIL="${TEST_EMAIL:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"

if [[ -z "${TEST_EMAIL}" || -z "${TEST_PASSWORD}" ]]; then
  err "TEST_EMAIL and TEST_PASSWORD must be set (via env or --env-file)."
  exit 1
fi

# ─── Resolve server IP ───────────────────────────────────────────────────────

SERVER_IP=""
if command -v terraform &>/dev/null; then
  SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
fi

if [[ -z "${SERVER_IP}" ]]; then
  err "Could not determine server IP from terraform output."
  err "Ensure terraform is installed and the backend is configured."
  err "Try: --backend-env-file infra/hetzner/.env.backend"
  exit 1
fi

# Helper: run a command on the server
remote() {
  ssh ${SSH_OPTS} "root@${SERVER_IP}" "$@" 2>&1
}

# Helper: run a command on the server with autoscale env sourced
remote_with_env() {
  ssh ${SSH_OPTS} "root@${SERVER_IP}" "
    set -a; source /etc/herobids/autoscale.env 2>/dev/null; set +a
    HEROBIDS_ENV=${HEROBIDS_ENV}
    export HEROBIDS_ENV
    $*
  " 2>&1
}

# ─── API helpers ──────────────────────────────────────────────────────────────

api() {
  local method="$1" url="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -s -X "$method" "${API}${url}" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${TOKEN}" \
      -d "$data"
  else
    curl -s -X "$method" "${API}${url}" \
      -H "Authorization: Bearer ${TOKEN}"
  fi
}

# ─── Cleanup trap ─────────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  if [[ "${SKIP_CLEANUP}" == "true" ]]; then
    warn "Skipping cleanup (--skip-cleanup). Agents left running:"
    for agent_id in "${AGENT_IDS[@]}"; do
      warn "  ${agent_id}"
    done
    exit $exit_code
  fi
  if [[ ${#AGENT_IDS[@]} -gt 0 && -n "${TOKEN}" ]]; then
    log "Cleaning up ${#AGENT_IDS[@]} test agent(s)..."
    for agent_id in "${AGENT_IDS[@]}"; do
      api POST "/agents/${agent_id}/stop" >/dev/null 2>&1 || true
      api DELETE "/agents/${agent_id}" >/dev/null 2>&1 || true
    done
    ok "Cleanup complete."
  fi
  exit $exit_code
}
trap cleanup EXIT

# ─── Pre-flight ───────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}══ Autoscale Agent Trigger Test — ${HEROBIDS_ENV} ══${RESET}"
echo ""
log "Server:       ${SERVER_IP}"
log "API:          ${API}"
log "Environment:  ${HEROBIDS_ENV}"
log "Skip cleanup: ${SKIP_CLEANUP}"
echo ""

# ─── 1. Authenticate ─────────────────────────────────────────────────────────

echo -e "${BOLD}1. Authentication${RESET}"

login_payload=$(jq -n --arg email "$TEST_EMAIL" --arg password "$TEST_PASSWORD" \
  '{email: $email, password: $password}')
login_resp=$(curl -s -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$login_payload")
TOKEN=$(echo "$login_resp" | jq -r '.token // empty')

if [[ -z "$TOKEN" ]]; then
  err "Authentication failed. Response: $(echo "$login_resp" | jq -c '.')"
  exit 1
fi
check "Authenticated as ${TEST_EMAIL}" true

# ─── 2. Get current capacity and node count ──────────────────────────────────

echo -e "${BOLD}2. Current cluster capacity${RESET}"

# SSH connectivity check
SSH_RESULT="$(remote 'echo ok' 2>&1 || true)"
check "SSH to ${SERVER_IP}" \
  bash -c "[[ '${SSH_RESULT}' == *ok* ]]"

if [[ "${SSH_RESULT}" != *ok* ]]; then
  err "Cannot proceed without SSH connectivity."
  exit 1
fi

CAPACITY_OUTPUT="$(remote_with_env 'NOMAD_TOKEN=$NOMAD_TOKEN /opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh 2>/dev/null')"
log "Capacity output: ${CAPACITY_OUTPUT}"

FREE_SLOTS="$(echo "${CAPACITY_OUTPUT}" | grep -oP 'free_slots=\K[0-9]+' || echo "0")"
SCALE_OUT_THRESHOLD="$(echo "${CAPACITY_OUTPUT}" | grep -oP 'scale_out_slot_threshold=\K[0-9]+' || echo "0")"

log "Free slots:              ${FREE_SLOTS}"
log "Scale-out threshold:     ${SCALE_OUT_THRESHOLD}"

check "free_slots > 0" \
  bash -c "[[ ${FREE_SLOTS} -gt 0 ]]"
check "scale_out_slot_threshold parsed" \
  bash -c "[[ ${SCALE_OUT_THRESHOLD} -gt 0 ]]"

AGENTS_NEEDED=$(( FREE_SLOTS - SCALE_OUT_THRESHOLD + 1 ))
if [[ ${AGENTS_NEEDED} -le 0 ]]; then
  warn "Cluster already at or below threshold (free=${FREE_SLOTS}, threshold=${SCALE_OUT_THRESHOLD})."
  warn "No agents needed — autoscaler should already be triggering."
  AGENTS_NEEDED=0
fi

log "Agents to create: ${AGENTS_NEEDED}"

NODE_COUNT_BEFORE="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
log "Node count before: ${NODE_COUNT_BEFORE}"

# ─── 3. Create agents ────────────────────────────────────────────────────────

echo -e "${BOLD}3. Create test agents${RESET}"

for (( i=1; i<=AGENTS_NEEDED; i++ )); do
  AGENT_NAME="capacity-test-${i}"
  log "Creating ${AGENT_NAME}..."

  CREATE_RESP=$(api POST /agents "$(jq -n --arg name "$AGENT_NAME" \
    '{name: $name, style: "careful", prompt: "You are a capacity test agent. Stay idle."}')")
  AGENT_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')

  if [[ -n "$AGENT_ID" ]]; then
    ok "  ✓ ${AGENT_NAME} created (${AGENT_ID})"
    AGENT_IDS+=("${AGENT_ID}")
  else
    err "  ✗ ${AGENT_NAME} creation failed: $(echo "$CREATE_RESP" | jq -c '.')"
    (( FAILED++ )) || true
  fi
done

check "All ${AGENTS_NEEDED} agents created" \
  bash -c "[[ ${#AGENT_IDS[@]} -eq ${AGENTS_NEEDED} ]]"

# ─── 4. Start agents ─────────────────────────────────────────────────────────

echo -e "${BOLD}4. Start agents${RESET}"

STARTED_COUNT=0
for agent_id in "${AGENT_IDS[@]}"; do
  START_RESP=$(api POST "/agents/${agent_id}/start")
  STATUS=$(echo "$START_RESP" | jq -r '.status // empty')
  if [[ "${STATUS}" == "starting" || "${STATUS}" == "running" ]]; then
    ok "  ✓ Agent ${agent_id} started"
    (( STARTED_COUNT++ )) || true
  else
    err "  ✗ Agent ${agent_id} start failed: $(echo "$START_RESP" | jq -c '.')"
    (( FAILED++ )) || true
  fi
done

check "All agents started" \
  bash -c "[[ ${STARTED_COUNT} -eq ${#AGENT_IDS[@]} ]]"

# ─── 5. Wait for agents to become running ────────────────────────────────────

echo -e "${BOLD}5. Wait for agents to become running${RESET}"

AGENT_TIMEOUT=120
AGENT_POLL=10
WAITED=0

while [[ ${WAITED} -lt ${AGENT_TIMEOUT} ]]; do
  RUNNING_COUNT=0
  for agent_id in "${AGENT_IDS[@]}"; do
    AGENT_RESP=$(api GET "/agents/${agent_id}")
    AGENT_STATUS=$(echo "$AGENT_RESP" | jq -r '.status // empty')
    [[ "${AGENT_STATUS}" == "running" ]] && (( RUNNING_COUNT++ )) || true
  done
  log "Running: ${RUNNING_COUNT}/${#AGENT_IDS[@]} (${WAITED}s elapsed)"
  if [[ ${RUNNING_COUNT} -eq ${#AGENT_IDS[@]} ]]; then
    break
  fi
  sleep ${AGENT_POLL}
  (( WAITED += AGENT_POLL ))
done

check "All agents running" \
  bash -c "[[ ${RUNNING_COUNT} -eq ${#AGENT_IDS[@]} ]]"

# ─── 6. Wait for autoscale timer to trigger scale-out ─────────────────────────

echo -e "${BOLD}6. Wait for autoscaler scale-out${RESET}"

SCALE_TIMEOUT=300
SCALE_POLL=15
WAITED=0
SCALE_OUT_DETECTED=false

while [[ ${WAITED} -lt ${SCALE_TIMEOUT} ]]; do
  CURRENT_COUNT="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
  log "Node count: ${CURRENT_COUNT} (was: ${NODE_COUNT_BEFORE}, ${WAITED}s elapsed)"
  if [[ ${CURRENT_COUNT} -gt ${NODE_COUNT_BEFORE} ]]; then
    SCALE_OUT_DETECTED=true
    break
  fi
  sleep ${SCALE_POLL}
  (( WAITED += SCALE_POLL ))
done

check "Scale-out triggered (nodes: ${NODE_COUNT_BEFORE} → ${CURRENT_COUNT:-unknown})" \
  bash -c "[[ '${SCALE_OUT_DETECTED}' == 'true' ]]"

# ─── 7. Verify node count increased ──────────────────────────────────────────

echo -e "${BOLD}7. Verify node count${RESET}"

NODE_COUNT_AFTER="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
check "Node count increased (${NODE_COUNT_BEFORE} → ${NODE_COUNT_AFTER})" \
  bash -c "[[ ${NODE_COUNT_AFTER} -gt ${NODE_COUNT_BEFORE} ]]"

# ─── 8. Cleanup (handled by trap, but log intent) ────────────────────────────

echo -e "${BOLD}8. Cleanup${RESET}"
log "Agents will be stopped and deleted by cleanup trap on exit."
log "After cleanup, autoscale timer should eventually trigger scale-in."

# ─── Summary ──────────────────────────────────────────────────────────────────

TOTAL=$(( PASSED + FAILED ))
echo ""
echo -e "${BOLD}── Results ──${RESET}"
echo -e "  Total:  ${TOTAL}"
echo -e "  ${GREEN}Passed: ${PASSED}${RESET}"
if [[ ${FAILED} -gt 0 ]]; then
  echo -e "  ${RED}Failed: ${FAILED}${RESET}"
fi
echo ""

if [[ ${FAILED} -gt 0 ]]; then
  err "Autoscale agent trigger test FAILED (${FAILED} failures)."
  exit 1
fi

ok "Autoscale agent trigger test PASSED (${PASSED} checks)."
exit 0
