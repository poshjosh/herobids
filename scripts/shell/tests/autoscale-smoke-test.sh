#!/usr/bin/env bash
# autoscale-smoke-test.sh — Validate Nomad autoscale infrastructure is healthy.
#
# Connects to the control-plane server via SSH and verifies that the Nomad
# cluster, autoscale scripts, and credentials are functional. This is the
# automated equivalent of validation plan V1 (baseline checks).
#
# Usage:
#   scripts/shell/tests/autoscale-smoke-test.sh [--env <staging|production>] [--backend-env-file <path>]
#   scripts/shell/tests/autoscale-smoke-test.sh --env staging --backend-env-file infra/hetzner/.env.backend
#   scripts/shell/tests/autoscale-smoke-test.sh --env staging --destructive --backend-env-file infra/hetzner/.env.backend
#
# Options:
#   --env <name>              Target environment: staging or production (default: staging).
#   --backend-env-file <path> Path to .env.backend file (for resolving server IP via terraform).
#   --destructive             Also run a real scale-out + scale-in cycle (costs money, takes ~5 min).
#   --help                    Show this help message.
#
# Prerequisites:
#   - Server provisioned and deployed (setup-nomad.sh already run).
#   - SSH access to the control plane (herobids_deploy_key).
#   - /etc/herobids/autoscale.env present on the server.
#
# Exit code: 0 if all checks pass, 1 if any check fails.

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

log()  { echo -e "${CYAN}[autoscale]${RESET} $*"; }
ok()   { echo -e "${GREEN}[autoscale]${RESET} $*"; }
warn() { echo -e "${YELLOW}[autoscale]${RESET} $*"; }
err()  { echo -e "${RED}[autoscale]${RESET} $*" >&2; }

# ─── State ────────────────────────────────────────────────────────────────────

PASSED=0
FAILED=0

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

DESTRUCTIVE=false
BACKEND_ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --destructive)
      DESTRUCTIVE=true
      shift
      ;;
    --backend-env-file)
      BACKEND_ENV_FILE="${2:-}"
      if [[ -z "${BACKEND_ENV_FILE}" ]]; then
        echo "ERROR: --backend-env-file requires a path argument." >&2
        exit 1
      fi
      shift 2
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

# Source backend env file if provided (for terraform output to get server IP)
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

# ─── Pre-flight ───────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}══ Autoscale Smoke Test — ${HEROBIDS_ENV} ══${RESET}"
echo ""
log "Server:      ${SERVER_IP}"
log "Environment: ${HEROBIDS_ENV}"
log "Destructive: ${DESTRUCTIVE}"
echo ""

# ─── 1. SSH connectivity ─────────────────────────────────────────────────────

echo -e "${BOLD}1. SSH connectivity${RESET}"
check "SSH to ${SERVER_IP}" remote 'echo ok' | grep -q ok

# ─── 2. Autoscale env file ───────────────────────────────────────────────────

echo -e "${BOLD}2. Autoscale credentials${RESET}"
check "/etc/herobids/autoscale.env exists" \
  remote 'test -f /etc/herobids/autoscale.env'
check "TF_BACKEND_BUCKET is set" \
  remote 'grep -q "^TF_BACKEND_BUCKET=.\+" /etc/herobids/autoscale.env'
check "AWS_ACCESS_KEY_ID is set" \
  remote 'grep -q "^AWS_ACCESS_KEY_ID=.\+" /etc/herobids/autoscale.env'
check "NOMAD_TOKEN is set" \
  remote 'grep -q "^NOMAD_TOKEN=.\+" /etc/herobids/autoscale.env'
check "/etc/nomad.d/acl-token exists" \
  remote 'test -f /etc/nomad.d/acl-token'

# ─── 3. Nomad cluster health ─────────────────────────────────────────────────

echo -e "${BOLD}3. Nomad cluster health${RESET}"

NOMAD_OUTPUT="$(remote_with_env 'NOMAD_TOKEN=$NOMAD_TOKEN nomad server members')"
check "Nomad server is alive" \
  bash -c "echo '${NOMAD_OUTPUT}' | grep -q 'alive'"
check "Nomad server is leader" \
  bash -c "echo '${NOMAD_OUTPUT}' | grep -q 'true'"

NODE_OUTPUT="$(remote_with_env 'NOMAD_TOKEN=$NOMAD_TOKEN nomad node status')"
READY_COUNT="$(echo "${NODE_OUTPUT}" | grep -c 'ready' || true)"
check "At least 1 ready agent node (found: ${READY_COUNT})" \
  bash -c "[[ ${READY_COUNT} -ge 1 ]]"

# ─── 4. Worker using Nomad backend ───────────────────────────────────────────

echo -e "${BOLD}4. Worker runtime backend${RESET}"

WORKER_ENV="$(remote 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.*.yaml exec -T worker env 2>/dev/null | grep -E "RUNTIME_BACKEND|NOMAD_ADDR|NOMAD_TOKEN"' || echo "")"
check "RUNTIME_BACKEND=nomad" \
  bash -c "echo '${WORKER_ENV}' | grep -q 'RUNTIME_BACKEND=nomad'"
check "NOMAD_ADDR is configured" \
  bash -c "echo '${WORKER_ENV}' | grep -q 'NOMAD_ADDR='"
check "Worker has NOMAD_TOKEN" \
  bash -c "echo '${WORKER_ENV}' | grep -q 'NOMAD_TOKEN='"

# ─── 5. Capacity check ───────────────────────────────────────────────────────

echo -e "${BOLD}5. Cluster capacity${RESET}"

CAPACITY_OUTPUT="$(remote_with_env 'NOMAD_TOKEN=$NOMAD_TOKEN /opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh 2>/dev/null')"
check "check-nomad-capacity.sh exits 0" \
  bash -c "[[ -n '${CAPACITY_OUTPUT}' ]]"
check "Reports ready_nodes > 0" \
  bash -c "echo '${CAPACITY_OUTPUT}' | grep -q 'ready_nodes=[1-9]'"
check "Reports free_slots > 0" \
  bash -c "echo '${CAPACITY_OUTPUT}' | grep -q 'free_slots=[1-9]'"

# ─── 6. Scale-in dry-run ─────────────────────────────────────────────────────

echo -e "${BOLD}6. Scale-in dry-run${RESET}"

DRYIN_OUTPUT="$(remote_with_env '
  ENABLE_SCALE_IN=true TF_VAR_min_agent_nodes=0 TF_VAR_max_agent_nodes=99 \
  TF_VAR_agent_node_server_type=cx23 TF_VAR_location=fsn1 \
  /opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run
' 2>&1)" || true
check "scale-in.sh --dry-run runs without crash" \
  bash -c "echo '${DRYIN_OUTPUT}' | grep -qE 'DRY-RUN|No idle nodes|Already at or below min|No eligible'"

# ─── 7. Terraform backend connectivity ────────────────────────────────────────

echo -e "${BOLD}7. Terraform backend${RESET}"

TF_OUTPUT="$(remote_with_env '
  TF_VAR_agent_node_server_type=cx23 TF_VAR_location=fsn1 \
  TF_VAR_min_agent_nodes=0 TF_VAR_max_agent_nodes=99 \
  cd /opt/herobids/infra/hetzner && \
  source /etc/herobids/autoscale.env && \
  terraform workspace show 2>&1
')" || true
check "Terraform workspace is ${HEROBIDS_ENV}" \
  bash -c "echo '${TF_OUTPUT}' | grep -q '${HEROBIDS_ENV}'"

# ─── 8. Staging hooks (staging only) ─────────────────────────────────────────

if [[ "${HEROBIDS_ENV}" == "staging" ]]; then
  echo -e "${BOLD}8. Staging failure-injection hooks${RESET}"

  HOOKS_OUTPUT="$(remote 'HEROBIDS_ENV=staging bash -c "source /opt/herobids/infra/hetzner/scripts/tests/staging-hooks.sh"' 2>&1)" || true
  check "staging-hooks.sh loads without error" \
    bash -c "echo '${HOOKS_OUTPUT}' | grep -q 'STAGING-HOOK'"
fi

# ─── 9. Destructive cycle (optional) ─────────────────────────────────────────

if [[ "${DESTRUCTIVE}" == "true" ]]; then
  echo -e "${BOLD}9. Destructive: scale-out + scale-in cycle${RESET}"
  warn "Running real scale-out then scale-in. This creates and destroys a server."

  NODE_COUNT_BEFORE="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
  log "Node count before: ${NODE_COUNT_BEFORE}"

  # Scale out
  log "Scaling out..."
  SCALEOUT_OUTPUT="$(remote_with_env '
    TF_VAR_max_agent_nodes=99 TF_VAR_agent_node_server_type=cx23 TF_VAR_location=fsn1 \
    /opt/herobids/infra/hetzner/scripts/scale-out.sh --force --bypass-cooldown
  ' 2>&1)" || true
  check "scale-out.sh succeeds" \
    bash -c "echo '${SCALEOUT_OUTPUT}' | grep -q 'Scale-out successful'"

  if echo "${SCALEOUT_OUTPUT}" | grep -q 'Scale-out successful'; then
    # Wait for new node to join
    log "Waiting 180s for new agent node to join..."
    sleep 180

    NEW_COUNT="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
    check "Node count increased (${NODE_COUNT_BEFORE} → ${NEW_COUNT})" \
      bash -c "[[ ${NEW_COUNT} -gt ${NODE_COUNT_BEFORE} ]]"

    # Scale in
    log "Scaling in..."
    rm -f /var/run/nomad-autoscale.lock 2>/dev/null || true
    SCALEIN_OUTPUT="$(remote_with_env '
      rm -f /var/run/nomad-autoscale.lock
      ENABLE_SCALE_IN=true TF_VAR_min_agent_nodes=0 TF_VAR_max_agent_nodes=99 \
      TF_VAR_agent_node_server_type=cx23 TF_VAR_location=fsn1 \
      /opt/herobids/infra/hetzner/scripts/scale-in.sh
    ' 2>&1)" || true
    check "scale-in.sh succeeds" \
      bash -c "echo '${SCALEIN_OUTPUT}' | grep -q 'Scale-in successful'"

    FINAL_COUNT="$(remote 'cat /var/run/nomad-autoscale-node-count 2>/dev/null || echo 0')"
    check "Node count returned to ${NODE_COUNT_BEFORE} (got: ${FINAL_COUNT})" \
      bash -c "[[ ${FINAL_COUNT} -eq ${NODE_COUNT_BEFORE} ]]"
  else
    warn "Scale-out did not succeed — skipping scale-in."
  fi
fi

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
  err "Autoscale smoke test FAILED (${FAILED} failures)."
  exit 1
fi

ok "Autoscale smoke test PASSED (${PASSED} checks)."
exit 0
