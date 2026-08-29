#!/usr/bin/env bash
# autoscale-capacity-trigger-test.sh — Push cluster below capacity threshold to trigger scale-out.
#
# Submits dummy Nomad jobs to consume free slots, waits for the autoscaler to
# detect low capacity and provision a new node, then cleans up.
#
# Usage:
#   scripts/shell/tests/autoscale-capacity-trigger-test.sh \
#     --env staging --backend-env-file infra/hetzner/.env.backend
#
# Options:
#   --env <name>              Target environment: staging or production (default: staging).
#   --backend-env-file <path> Path to .env.backend file (for resolving server IP via terraform).
#   --skip-cleanup            Leave dummy jobs running for manual inspection.
#   --help                    Show this help message.
#
# Prerequisites:
#   - Server provisioned and deployed (setup-nomad.sh already run).
#   - SSH access to the control plane (herobids_deploy_key).
#   - /etc/herobids/autoscale.env present on the server.
#   - AUTOSCALE_DESTRUCTIVE=true (opt-in, since this creates real cloud resources).
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

log()  { echo -e "${CYAN}[capacity-trigger]${RESET} $*"; }
ok()   { echo -e "${GREEN}[capacity-trigger]${RESET} $*"; }
warn() { echo -e "${YELLOW}[capacity-trigger]${RESET} $*"; }
err()  { echo -e "${RED}[capacity-trigger]${RESET} $*" >&2; }

# ─── State ────────────────────────────────────────────────────────────────────

PASSED=0
FAILED=0
JOBS_SUBMITTED=()
SKIP_CLEANUP=false

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

# Source backend env file if provided
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

# ─── Cleanup trap ─────────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  if [[ "${SKIP_CLEANUP}" == "true" ]]; then
    warn "Skipping cleanup (--skip-cleanup). Dummy jobs left running:"
    for job in "${JOBS_SUBMITTED[@]}"; do
      warn "  ${job}"
    done
    exit $exit_code
  fi
  if [[ ${#JOBS_SUBMITTED[@]} -gt 0 ]]; then
    log "Cleaning up ${#JOBS_SUBMITTED[@]} dummy job(s)..."
    for job in "${JOBS_SUBMITTED[@]}"; do
      remote_with_env "NOMAD_TOKEN=\$NOMAD_TOKEN nomad job stop -purge '${job}'" >/dev/null 2>&1 || true
    done
    ok "Cleanup complete."
  fi
  exit $exit_code
}
trap cleanup EXIT

# ─── Pre-flight ───────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}══ Autoscale Capacity Trigger Test — ${HEROBIDS_ENV} ══${RESET}"
echo ""
log "Server:       ${SERVER_IP}"
log "Environment:  ${HEROBIDS_ENV}"
log "Skip cleanup: ${SKIP_CLEANUP}"
echo ""

# ─── 1. SSH connectivity ─────────────────────────────────────────────────────

echo -e "${BOLD}1. SSH connectivity${RESET}"
SSH_RESULT="$(remote 'echo ok' 2>&1 || true)"
check "SSH to ${SERVER_IP}" \
  bash -c "[[ '${SSH_RESULT}' == *ok* ]]"

if [[ "${SSH_RESULT}" != *ok* ]]; then
  err "Cannot proceed without SSH connectivity."
  exit 1
fi

# ─── 2. Get current capacity ─────────────────────────────────────────────────

echo -e "${BOLD}2. Current cluster capacity${RESET}"

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

# Calculate how many dummy jobs to submit to push below threshold
JOBS_NEEDED=$(( FREE_SLOTS - SCALE_OUT_THRESHOLD + 1 ))
if [[ ${JOBS_NEEDED} -le 0 ]]; then
  warn "Cluster already at or below threshold (free=${FREE_SLOTS}, threshold=${SCALE_OUT_THRESHOLD})."
  warn "No dummy jobs needed — autoscaler should already be triggering."
  JOBS_NEEDED=0
fi

log "Dummy jobs to submit:    ${JOBS_NEEDED}"

# ─── 3. Get current node count ───────────────────────────────────────────────

echo -e "${BOLD}3. Current node count${RESET}"

NODE_COUNT_BEFORE="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
log "Node count before: ${NODE_COUNT_BEFORE}"

# ─── 4. Submit dummy Nomad jobs ──────────────────────────────────────────────

echo -e "${BOLD}4. Submit dummy jobs${RESET}"

for (( i=1; i<=JOBS_NEEDED; i++ )); do
  JOB_NAME="capacity-test-${i}"
  log "Submitting ${JOB_NAME}..."

  JOB_OUTPUT="$(remote_with_env "NOMAD_TOKEN=\$NOMAD_TOKEN nomad job run -<<'JOBEOF'
job \"capacity-test-${i}\" {
  datacenters = [\"dc1\"]
  type = \"service\"
  constraint {
    attribute = \"\${node.class}\"
    value = \"agent\"
  }
  group \"load\" {
    count = 1
    restart {
      attempts = 0
      mode = \"fail\"
    }
    task \"sleep\" {
      driver = \"docker\"
      config {
        image = \"alpine:latest\"
        command = \"sleep\"
        args = [\"3600\"]
      }
      resources {
        cpu = 100
        memory = 256
      }
    }
  }
}
JOBEOF")" || true

  if echo "${JOB_OUTPUT}" | grep -qE 'Evaluation|created|modified'; then
    ok "  ✓ ${JOB_NAME} submitted"
    JOBS_SUBMITTED+=("${JOB_NAME}")
  else
    err "  ✗ ${JOB_NAME} submission failed: ${JOB_OUTPUT}"
    (( FAILED++ )) || true
  fi
done

check "All ${JOBS_NEEDED} dummy jobs submitted" \
  bash -c "[[ ${#JOBS_SUBMITTED[@]} -eq ${JOBS_NEEDED} ]]"

# ─── 5. Wait for jobs to become running ──────────────────────────────────────

echo -e "${BOLD}5. Wait for dummy jobs to start${RESET}"

JOB_TIMEOUT=120
JOB_POLL=10
WAITED=0

while [[ ${WAITED} -lt ${JOB_TIMEOUT} ]]; do
  RUNNING_COUNT=0
  for job in "${JOBS_SUBMITTED[@]}"; do
    STATUS="$(remote_with_env "NOMAD_TOKEN=\$NOMAD_TOKEN nomad job status -short '${job}' 2>/dev/null | grep -oP 'Status\\s+=\\s+\\K\\w+'" || echo "unknown")"
    [[ "${STATUS}" == "running" ]] && (( RUNNING_COUNT++ )) || true
  done
  log "Running: ${RUNNING_COUNT}/${#JOBS_SUBMITTED[@]} (${WAITED}s elapsed)"
  if [[ ${RUNNING_COUNT} -eq ${#JOBS_SUBMITTED[@]} ]]; then
    break
  fi
  sleep ${JOB_POLL}
  (( WAITED += JOB_POLL ))
done

check "All dummy jobs running" \
  bash -c "[[ ${RUNNING_COUNT} -eq ${#JOBS_SUBMITTED[@]} ]]"

# ─── 6. Verify capacity is below threshold ───────────────────────────────────

echo -e "${BOLD}6. Verify capacity below threshold${RESET}"

CAPACITY_AFTER="$(remote_with_env 'NOMAD_TOKEN=$NOMAD_TOKEN /opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh 2>/dev/null')"
FREE_AFTER="$(echo "${CAPACITY_AFTER}" | grep -oP 'free_slots=\K[0-9]+' || echo "0")"
log "Free slots after load: ${FREE_AFTER} (threshold: ${SCALE_OUT_THRESHOLD})"

check "Free slots below threshold (${FREE_AFTER} < ${SCALE_OUT_THRESHOLD})" \
  bash -c "[[ ${FREE_AFTER} -lt ${SCALE_OUT_THRESHOLD} ]]"

# ─── 7. Wait for autoscale timer to trigger scale-out ─────────────────────────

echo -e "${BOLD}7. Wait for autoscaler scale-out${RESET}"

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

# ─── 8. Verify node count increased ──────────────────────────────────────────

echo -e "${BOLD}8. Verify node count${RESET}"

NODE_COUNT_AFTER="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
check "Node count increased (${NODE_COUNT_BEFORE} → ${NODE_COUNT_AFTER})" \
  bash -c "[[ ${NODE_COUNT_AFTER} -gt ${NODE_COUNT_BEFORE} ]]"

# ─── 9. Cleanup (handled by trap, but log intent) ────────────────────────────

echo -e "${BOLD}9. Cleanup${RESET}"
log "Dummy jobs will be stopped by cleanup trap on exit."
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
  err "Autoscale capacity trigger test FAILED (${FAILED} failures)."
  exit 1
fi

ok "Autoscale capacity trigger test PASSED (${PASSED} checks)."
exit 0
