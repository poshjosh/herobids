#!/usr/bin/env bash
# scale-in.sh — Nightly conservative scale-in for Herobids Nomad agent node pool.
#
# Runs nightly (default 3 AM) to drain and remove idle agent nodes, reducing
# operating cost. Uses the same terraform-managed agent pool as scale-out.sh.
#
# Safety rules (from plan):
#   - Never kill active agent allocations to reach the floor.
#   - Mark candidate nodes ineligible for new placements first.
#   - Drain only nodes that are idle or become empty within the drain window.
#   - Stop draining when min_agent_nodes is reached.
#   - Conservative: never evict active agents.
#
# Usage:
#   scale-in.sh [--help] [--dry-run]
#
# Options:
#   --help      Show this help message.
#   --dry-run   Compute candidates and show what would happen without scaling.
#
# Exit codes:
#   0  No action needed, or scale-in completed successfully.
#   1  Configuration or runtime error.
#   2  Scale-in disabled (ENABLE_SCALE_IN != true).
#   3  Already at min_agent_nodes.
#   4  Lock held by another process.
#
# Environment (see scale-common.sh for full list):
#   ENABLE_SCALE_IN                      Feature flag: true to enable (default: false).
#   NOMAD_ADDR                           Nomad server HTTP API base URL.
#   NOMAD_SCALE_IN_MAX_NODES_PER_RUN     Max nodes to drain per scale-in run (default: 1).
#   NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS Max seconds to wait for drain (default: 600).
#   NOMAD_AUTOSCALE_LOCKFILE             Shared lock file with scale-out (default: /var/run/nomad-autoscale.lock).
#   NOMAD_AUTOSCALE_NODE_COUNT_FILE      Node count state file.
#   NOMAD_AUTOSCALE_LOG_FILE             Log file path.
#   TERRAFORM_DIR                        Path to Terraform working directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scale-common.sh"
source "${SCRIPT_DIR}/alert-common.sh"

# ─── Scale-in defaults ────────────────────────────────────────────────────────

ENABLE_SCALE_IN="${ENABLE_SCALE_IN:-false}"
NOMAD_SCALE_IN_MAX_NODES_PER_RUN="${NOMAD_SCALE_IN_MAX_NODES_PER_RUN:-1}"

# ─── Parse arguments ──────────────────────────────────────────────────────────

SHOW_HELP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      SHOW_HELP=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "${SHOW_HELP}" == "true" ]]; then
  cat <<EOF
Usage: $0 [--help] [--dry-run]

Nightly conservative scale-in: drain and remove idle agent nodes to reduce
operating cost. Runs at 3 AM (configurable via systemd timer).

Safety rules:
  - Never kill active agent allocations.
  - Mark candidate nodes ineligible first.
  - Drain only idle nodes; wait for in-flight work to complete.
  - Stop at min_agent_nodes.

Configuration (env vars, see scale-common.sh for shared defaults):
  ENABLE_SCALE_IN                      Feature flag (default: false).
  NOMAD_SCALE_IN_MAX_NODES_PER_RUN     Max nodes per run (default: 1).
  NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS Drain deadline in seconds (default: 600).
  TERRAFORM_DIR                        Terraform working directory.

Exit codes:
  0  Success or no action needed.
  1  Runtime error.
  2  Scale-in disabled.
  3  Already at min_agent_nodes.
  4  Lock held.
EOF
  exit 0
fi

# ─── Feature flag check ───────────────────────────────────────────────────────

if [[ "${ENABLE_SCALE_IN}" != "true" ]]; then
  log "Scale-in is disabled (ENABLE_SCALE_IN=${ENABLE_SCALE_IN}). Set ENABLE_SCALE_IN=true to enable."
  log "Nothing to do."
  exit 2
fi

# ─── Pre-flight checks ────────────────────────────────────────────────────────

log "=== Nomad Scale-In ==="
log "  Environment:       ${HEROBIDS_ENV:-unknown}"
log "  Nomad API:         ${NOMAD_ADDR}"
log "  Terraform dir:     ${TERRAFORM_DIR}"
log "  Max nodes per run: ${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}"
log "  Drain deadline:    ${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}s"
log "  Dry run:           ${DRY_RUN}"
log ""

if ! command -v terraform &>/dev/null; then
  die "terraform not found in PATH." 1
fi

if [[ ! -d "${TERRAFORM_DIR}" ]]; then
  die "TERRAFORM_DIR '${TERRAFORM_DIR}' does not exist." 1
fi

if [[ ! -f "${TERRAFORM_DIR}/terraform.tfstate" ]]; then
  die "No terraform.tfstate found in ${TERRAFORM_DIR}. Run 'terraform init' first." 1
fi

# ─── Get current state ────────────────────────────────────────────────────────

log "Reading current state..."

CURRENT_COUNT="$(current_agent_node_count)"
MIN_COUNT="$(min_agent_nodes)"

log "  Current agent nodes: ${CURRENT_COUNT}"
log "  Min agent nodes:     ${MIN_COUNT}"

if [[ -z "${CURRENT_COUNT}" ]]; then
  die "Could not determine current agent_node_count." 1
fi
if [[ -z "${MIN_COUNT}" ]]; then
  die "Could not determine min_agent_nodes." 1
fi

# ─── Check minimum ────────────────────────────────────────────────────────────

if [[ ${CURRENT_COUNT} -le ${MIN_COUNT} ]]; then
  log "Already at or below min_agent_nodes (${CURRENT_COUNT}/${MIN_COUNT})."
  log "No scale-in possible."
  exit 3
fi

# ─── Identify idle candidates ─────────────────────────────────────────────────

log ""
log "Scanning for idle agent nodes..."

# Get all eligible, ready agent nodes (excludes draining, ineligible, down nodes).
ELIGIBLE_NODES="$(list_eligible_agent_nodes)" || {
  die "Failed to list eligible agent nodes." 1
}

if [[ -z "${ELIGIBLE_NODES}" ]]; then
  log "No eligible agent nodes found — nothing to scale in."
  exit 0
fi

# For each eligible node, check if it is idle (zero running allocations).
# We build an ordered list of idle candidates, preferring nodes with
# the highest index (so we scale in from the top of the index range,
# maintaining contiguous numbering where possible).
declare -a IDLE_NODES=()
while IFS= read -r node_id; do
  if node_is_idle "${node_id}"; then
    log "  Node ${node_id}: IDLE (0 running allocations) — candidate."
    IDLE_NODES+=("${node_id}")
  else
    local running
    running="$(node_running_alloc_count "${node_id}")" || running="?"
    log "  Node ${node_id}: ACTIVE (${running} running allocations) — skipping."
  fi
done <<< "${ELIGIBLE_NODES}"

# H1: Sort IDLE_NODES by node name numeric suffix descending.
# Terraform count-based pools destroy the highest-indexed nodes first when
# count is reduced. We must drain the highest-index idle node to match
# Terraform's destroy order, preventing accidental eviction of active
# allocations on a busy high-index node.
if [[ "${#IDLE_NODES[@]}" -gt 1 ]]; then
  declare -a SORTED_IDLE=()
  while IFS=$'\t' read -r _suffix _node_id; do
    SORTED_IDLE+=("${_node_id}")
  done < <(
    for node_id in "${IDLE_NODES[@]}"; do
      node_name="$(node_name "${node_id}")" || node_name=""
      suffix="$(echo "${node_name}" | grep -oE '[0-9]+$' || echo "0")"
      printf '%s\t%s\n' "${suffix}" "${node_id}"
    done | sort -rn -t$'\t' -k1,1
  )
  IDLE_NODES=("${SORTED_IDLE[@]}")
fi

IDLE_COUNT="${#IDLE_NODES[@]}"
log ""
log "Idle candidates: ${IDLE_COUNT}"
log "Max to drain:    ${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}"

if [[ "${IDLE_COUNT}" -eq 0 ]]; then
  log "No idle nodes to scale in — all eligible nodes have active allocations."
  exit 0
fi

# ─── Determine how many to drain ──────────────────────────────────────────────

# Don't drain more than we can remove while staying at or above min_agent_nodes.
MAX_REMOVABLE=$(( CURRENT_COUNT - MIN_COUNT ))
NODES_TO_DRAIN=${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}
if [[ ${NODES_TO_DRAIN} -gt ${MAX_REMOVABLE} ]]; then
  NODES_TO_DRAIN=${MAX_REMOVABLE}
fi
if [[ ${NODES_TO_DRAIN} -gt ${IDLE_COUNT} ]]; then
  NODES_TO_DRAIN=${IDLE_COUNT}
fi

if [[ ${NODES_TO_DRAIN} -le 0 ]]; then
  log "Cannot drain any nodes without going below min_agent_nodes (${MIN_COUNT})."
  exit 3
fi

log "Nodes to drain this run: ${NODES_TO_DRAIN}"

# ─── Dry-run exit (before lock) ───────────────────────────────────────────────

if is_dry_run; then
  log ""
  log "[DRY-RUN] Would drain and remove:"
  for ((i=0; i<NODES_TO_DRAIN; i++)); do
    log "[DRY-RUN]   Node: ${IDLE_NODES[${i}]}"
  done
  NEW_COUNT=$(( CURRENT_COUNT - NODES_TO_DRAIN ))
  log "[DRY-RUN]   Current agent_node_count: ${CURRENT_COUNT}"
  log "[DRY-RUN]   New agent_node_count:     ${NEW_COUNT}"
  log "[DRY-RUN]   Terraform would run: terraform apply -auto-approve -var agent_node_count=${NEW_COUNT}"
  log "[DRY-RUN] No changes made."
  exit 0
fi

# ─── Acquire lock ─────────────────────────────────────────────────────────────

# Use the same lock as scale-out to prevent concurrent terraform operations.
if ! acquire_lock "${NOMAD_AUTOSCALE_LOCKFILE}" 0; then
  log "Another autoscale operation is in progress — skipping."
  exit 4
fi

trap 'release_lock' EXIT

# ─── Re-read state under lock (defensive) ─────────────────────────────────────

CURRENT_COUNT="$(current_agent_node_count)"
MAX_REMOVABLE=$(( CURRENT_COUNT - MIN_COUNT ))
if [[ ${MAX_REMOVABLE} -le 0 ]]; then
  log "Under lock: already at min_agent_nodes (${CURRENT_COUNT}/${MIN_COUNT}) — skipping."
  exit 3
fi

# Re-evaluate NODES_TO_DRAIN under lock
NODES_TO_DRAIN=${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}
if [[ ${NODES_TO_DRAIN} -gt ${MAX_REMOVABLE} ]]; then
  NODES_TO_DRAIN=${MAX_REMOVABLE}
fi
if [[ ${NODES_TO_DRAIN} -gt ${IDLE_COUNT} ]]; then
  NODES_TO_DRAIN=${IDLE_COUNT}
fi

# Re-verify candidates are still idle (they might have received work while
# we were waiting for the lock).
declare -a VERIFIED_IDLE=()
for ((i=0; i<IDLE_COUNT && ${#VERIFIED_IDLE[@]}<NODES_TO_DRAIN; i++)); do
  candidate_id="${IDLE_NODES[${i}]}"
  if node_is_idle "${candidate_id}"; then
    VERIFIED_IDLE+=("${candidate_id}")
  else
    log "Node ${candidate_id} received allocations while waiting for lock — skipped."
  fi
done

if [[ "${#VERIFIED_IDLE[@]}" -eq 0 ]]; then
  log "Under lock: no verified-idle nodes remain — nothing to drain."
  exit 0
fi

NODES_TO_DRAIN="${#VERIFIED_IDLE[@]}"
log "Under lock: ${NODES_TO_DRAIN} verified-idle node(s) to drain."

# ─── Mark candidates ineligible and drain ─────────────────────────────────────

declare -a DRAIN_OK=()
for node_id in "${VERIFIED_IDLE[@]}"; do
  log ""
  log "--- Processing node ${node_id} ---"

  # Step 1: Mark ineligible (prevent new placements)
  if ! mark_node_ineligible "${node_id}"; then
    log "WARNING: Failed to mark node ${node_id} ineligible — skipping."
    continue
  fi

  # Step 2: Initiate drain (this is a no-op for already-idle nodes, but
  # ensures any system jobs or lingering allocs are cleaned up).
  if ! drain_node "${node_id}" "${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}"; then
    log "WARNING: Failed to initiate drain on node ${node_id} — skipping."
    continue
  fi

  # Step 3: Wait for drain to complete.
  # An idle node should drain immediately (no allocations to migrate).
  if ! wait_for_drain_complete "${node_id}" "${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}"; then
    log "WARNING: Node ${node_id} did not drain completely within deadline."
    log "It will be force-stopped when the server is destroyed — this is acceptable."
  fi

  DRAIN_OK+=("${node_id}")
done

if [[ "${#DRAIN_OK[@]}" -eq 0 ]]; then
  log "No nodes successfully processed — terraform apply skipped."

  if alert_failure; then
    send_alert "scale_in_no_drainable_nodes" "No idle nodes could be successfully marked ineligible and drained. Scale-in aborted."
  fi

  exit 1
fi

# ─── Terraform apply ──────────────────────────────────────────────────────────

NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))
if [[ ${NEW_COUNT} -lt ${MIN_COUNT} ]]; then
  NEW_COUNT=${MIN_COUNT}
fi

log ""
log "=== Scaling in: ${CURRENT_COUNT} → ${NEW_COUNT} agent nodes ==="
log "  Nodes to destroy: ${#DRAIN_OK[@]}"
for node_id in "${DRAIN_OK[@]}"; do
  log "    - ${node_id}"
done

cd "${TERRAFORM_DIR}"

# Build terraform args (same pattern as scale-out.sh)
TF_ARGS="${TF_CLI_ARGS:-}"
if [[ -z "${TF_ARGS}" ]]; then
  case "${HEROBIDS_ENV:-production}" in
    staging)
      if [[ -f "${TERRAFORM_DIR}/staging.tfvars" ]]; then
        TF_ARGS="-var-file=${TERRAFORM_DIR}/staging.tfvars"
      fi
      ;;
    production)
      if [[ -f "${TERRAFORM_DIR}/production.tfvars" ]]; then
        TF_ARGS="-var-file=${TERRAFORM_DIR}/production.tfvars"
      fi
      ;;
  esac
  if [[ -z "${TF_ARGS}" ]] && [[ -f "${TERRAFORM_DIR}/terraform.tfvars" ]]; then
    TF_ARGS="-var-file=${TERRAFORM_DIR}/terraform.tfvars"
  fi
fi

log "Terraform args: ${TF_ARGS} -var agent_node_count=${NEW_COUNT}"

# shellcheck disable=SC2086
if terraform apply -auto-approve ${TF_ARGS} -var "agent_node_count=${NEW_COUNT}"; then
  log ""
  log "=== Scale-in successful ==="
  log "  Agent nodes: ${CURRENT_COUNT} → ${NEW_COUNT}"
  log "  Removed:      ${#DRAIN_OK[@]} node(s)"

  # Persist the new count
  write_node_count "${NEW_COUNT}"

  # Clear failure count — successful scale-in resets the alert streak
  clear_failure_count
else
  log ""
  log "ERROR: Terraform apply failed. Agent node count unchanged at ${CURRENT_COUNT}."
  log "Re-marking drained nodes as eligible so they can receive allocations again..."
  for node_id in "${DRAIN_OK[@]}"; do
    mark_node_eligible "${node_id}" || true
  done
  log "Run scale-in again after resolving the terraform error."

  if alert_failure; then
    send_alert "scale_in_failed" "Terraform apply failed while attempting to scale in from ${CURRENT_COUNT} to ${NEW_COUNT} agent nodes."
  fi

  exit 1
fi

log "Done."
exit 0
