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
# The node count comes from the capacity guard (capacity-inventory.sh), read
# under the autoscale lock from cloud and Nomad state. The node-count cache is
# never used for a scale decision. A blocked guard refuses scale-in (exit 1); a
# pending scale-out in flight skips scale-in (exit 0). The count is reduced only
# by a saved plan whose delete set is exactly the drained highest-index suffix
# (scale-in-guard.sh), and that plan is applied only after the check passes.
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
source "${SCRIPT_DIR}/capacity-inventory.sh"
source "${SCRIPT_DIR}/scale-in-guard.sh"

# ─── Staging failure-injection hooks (optional, staging only) ──────────────────
# Setting STAGING_HOOKS=true auto-sources staging-hooks.sh, which overrides
# specific functions to simulate failure scenarios for validation testing.
# The hooks refuse to activate when HEROBIDS_ENV=production.

if [[ "${STAGING_HOOKS:-}" == "true" ]]; then
  if [[ -f "${SCRIPT_DIR}/tests/staging-hooks.sh" ]]; then
    source "${SCRIPT_DIR}/tests/staging-hooks.sh"
  else
    log "WARNING: STAGING_HOOKS=true but staging-hooks.sh not found at ${SCRIPT_DIR}/tests/staging-hooks.sh"
  fi
fi

# ─── Scale-in defaults ────────────────────────────────────────────────────────

ENABLE_SCALE_IN="${ENABLE_SCALE_IN:-false}"
NOMAD_SCALE_IN_MAX_NODES_PER_RUN="${NOMAD_SCALE_IN_MAX_NODES_PER_RUN:-1}"
require_uint NOMAD_SCALE_IN_MAX_NODES_PER_RUN "${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}" 1 10
validate_scale_numeric_env

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
  - Refuse (defer, exit 0) while demand-aware mode is on.
  - Delete only nodes registered longer than NOMAD_SCALE_IN_NODE_GRACE_SECONDS.
  - Bind each deleted server to the Nomad node it was drained as; refuse if unproven.

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

# Demand-aware mode owns capacity decisions, so scale-in must not delete a node
# while it is on. A deferral (exit 0) keeps the nightly timer green.
if demand_mode_enabled; then
  log "Capacity demand mode is on (NOMAD_AUTOSCALE_DEMAND_ENABLED=true) — scale-in deferred, nothing deleted."
  exit 0
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

SCALE_IN_TMP_DIR=""
SCALE_IN_RESTORE_FAILED=0
DEFERRAL_FILE="${NOMAD_AUTOSCALE_STATE_DIR}/scale-in-deferrals"
scale_in_cleanup() {
  if [[ -n "${SCALE_IN_TMP_DIR}" ]]; then
    rm -rf -- "${SCALE_IN_TMP_DIR}"
  fi
  release_lock
}

# scale_in_restore_node <node_id> — clears the drain and re-marks the node eligible.
# A failure is logged, alerted and recorded; the run then exits non-zero at the end
# so the other drained nodes are still restored.
scale_in_restore_node() {
  local node_id="$1"
  if restore_node_schedulable "${node_id}"; then
    return 0
  fi
  SCALE_IN_RESTORE_FAILED=1
  log "WARNING: Node ${node_id} could not be restored to schedulable. Manual check required."
  if alert_failure; then
    send_alert "scale_in_restore_failed" "Node ${node_id} could not be restored to schedulable after a scale-in was aborted. Manual check required."
  fi
}

scale_in_restore_drained() {
  local node_id
  [[ ${#DRAIN_OK[@]} -eq 0 ]] && return 0
  for node_id in "${DRAIN_OK[@]}"; do
    scale_in_restore_node "${node_id}"
  done
}

# M1: consecutive runs with the top node down or unjoined. Dry-run writes nothing.
scale_in_note_deferral() {
  local count
  if is_dry_run; then
    log "[DRY-RUN] Would count a scale-in deferral (top node down or unjoined)."
    return 0
  fi
  count="$(cat "${DEFERRAL_FILE}" 2>/dev/null || echo 0)"
  [[ "${count}" =~ ^[0-9]+$ ]] || count=0
  count=$(( count + 1 ))
  mkdir -p "${NOMAD_AUTOSCALE_STATE_DIR}"
  printf '%s\n' "${count}" > "${DEFERRAL_FILE}"
  log "Scale-in deferral streak: ${count}/${NOMAD_SCALE_IN_DEFERRAL_ALERT_AFTER} (top node down or unjoined)."
  if (( count >= NOMAD_SCALE_IN_DEFERRAL_ALERT_AFTER )); then
    log "ALERT: top agent node down or unjoined for ${count} consecutive scale-in runs."
    if ! send_alert "scale_in_top_node_unjoined" "Top agent node has been down or unjoined for ${count} consecutive scale-in runs in pool ${NOMAD_AUTOSCALE_NODE_POOL}. Scale-in is deferred."; then
      log "WARNING: could not send the scale-in deferral alert."
    fi
  fi
}

scale_in_clear_deferrals() {
  if is_dry_run; then
    return 0
  fi
  rm -f -- "${DEFERRAL_FILE}"
}

if ! is_dry_run; then
  # Take the lock before any Terraform preparation or count decision (M7, plan §8).
  # Dry-run takes no lock and creates no lockfile.
  if ! acquire_lock "${NOMAD_AUTOSCALE_LOCKFILE}" 0; then
    log "Another autoscale operation is in progress — skipping."
    exit 4
  fi
  trap 'scale_in_cleanup' EXIT
fi

# Terraform init and workspace selection run only after the lock is held.
tf_ensure_env
if ! is_dry_run; then
  tf_ensure_ready
fi

# ─── Capacity guard (C1): the count comes from cloud and Nomad state ─────────

log "Reading current state under capacity guard..."

GATE_MUTATE=true
if is_dry_run; then
  GATE_MUTATE=false
fi

GATE_RC=0
GATE_OUT="$(capacity_scale_gate "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "$(date +%s)" "${GATE_MUTATE}")" || GATE_RC=$?

case "${GATE_RC}" in
  0) ;;
  2)
    log "A scale-out is still in flight (readiness window open) — scale-in skipped."
    exit 0
    ;;
  3)
    log "Capacity guard BLOCKED scale-in: $(jq -c '.blockers' <<< "${GATE_OUT}")"
    if is_dry_run; then
      log "[DRY-RUN] Scale-in would be refused."
      exit 0
    fi
    if alert_failure; then
      send_alert "scale_in_capacity_blocked" "Capacity guard refused scale-in for pool ${NOMAD_AUTOSCALE_NODE_POOL}. Blockers: $(jq -c '.blockers' <<< "${GATE_OUT}")"
    fi
    exit 1
    ;;
  *)
    log "ERROR: Capacity guard could not read cloud, Nomad or in-flight state (rc=${GATE_RC}). Scale-in refused."
    exit 1
    ;;
esac

CURRENT_COUNT="$(jq -r '.managed_count' <<< "${GATE_OUT}")"
MIN_COUNT="$(min_agent_nodes)"

log "  Current agent nodes: ${CURRENT_COUNT}"
log "  Min agent nodes:     ${MIN_COUNT}"

if [[ "$(jq -r '.status' <<< "${GATE_OUT}")" != "consistent" ]]; then
  log "Capacity snapshot is not consistent — scale-in deferred, nothing deleted."
  exit 1
fi
if ! [[ "${CURRENT_COUNT}" =~ ^[0-9]+$ ]]; then
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

# ─── Select the drained suffix (top-down) ─────────────────────────────────────
# Terraform count removes the highest TF index first, so the only safe run is a
# contiguous top suffix. Walk the reconciled snapshot from the top and stop at the
# first agent that is not ready, eligible and idle. Snapshot suffix is 1-based;
# the TF index is suffix - 1 (main.tf).

log ""
log "Selecting drainable agent suffix..."

# name|id for each eligible agent node from one node-list read (it carries Name and
# ID), so the snapshot is matched by exact name without a per-node lookup.
NODES_JSON="$(nomad_api GET "/v1/nodes" || true)"
if [[ -z "${NODES_JSON}" ]]; then
  die "Failed to list eligible agent nodes." 1
fi
ELIGIBLE_MAP="$(jq -r '.[] | select(.Status == "ready" and .SchedulingEligibility == "eligible" and .NodeClass == "agent") | "\(.Name)|\(.ID)"' <<< "${NODES_JSON}")" || {
  die "Failed to parse eligible agent nodes." 1
}

# M3: a name must identify one server and one node, or the name match is ambiguous.
if ! { jq -r '.servers[].name' <<< "${GATE_OUT}" | scale_in_names_unique; } \
  || ! { printf '%s' "${ELIGIBLE_MAP}" | cut -d'|' -f1 | scale_in_names_unique; }; then
  die "Duplicate or unreadable agent node names — scale-in refused." 1
fi

LIMIT=$(( CURRENT_COUNT - MIN_COUNT ))
if [[ ${LIMIT} -gt ${NOMAD_SCALE_IN_MAX_NODES_PER_RUN} ]]; then
  LIMIT=${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}
fi
if [[ ${LIMIT} -le 0 ]]; then
  log "Cannot drain any nodes without going below min_agent_nodes (${MIN_COUNT})."
  exit 3
fi

declare -a CAND_SUFFIX=()
declare -a CAND_ID=()
declare -a CAND_NAME=()
NOW="$(date +%s)"
RUN_INPUT=""
for ((s=CURRENT_COUNT; s>CURRENT_COUNT-LIMIT; s--)); do
  row="$(jq -r --argjson s "${s}" \
    '[.servers[] | select(.index == $s)] | if length == 1 then "\(.[0].name)|\(.[0].nomad)" else "|" end' \
    <<< "${GATE_OUT}")"
  snap_name="${row%%|*}"
  snap_nomad="${row#*|}"
  node_id=""
  if [[ "${snap_nomad}" == "ready" && -n "${snap_name}" ]]; then
    while IFS='|' read -r map_name map_id; do
      if [[ "${map_name}" == "${snap_name}" ]]; then
        node_id="${map_id}"
        break
      fi
    done <<< "${ELIGIBLE_MAP}"
  fi
  ok=0
  # H5: a node must be registered longer than the grace window; unknown time defers.
  if [[ -n "${node_id}" ]] && node_is_idle "${node_id}" && node_ready_for_grace "${node_id}" "${NOW}"; then
    ok=1
  fi
  RUN_INPUT+="${s} ${ok}"$'\n'
  CAND_SUFFIX+=("${s}")
  CAND_ID+=("${node_id}")
  CAND_NAME+=("${snap_name}")
  if [[ ${ok} -eq 0 ]]; then
    break
  fi
done

RUN_LEN="$(printf '%s' "${RUN_INPUT}" | scale_in_leading_run)"
if [[ "${RUN_LEN}" -eq 0 ]]; then
  # M1: a top node that is down or unjoined counts toward the alert streak. A joined
  # top node means that condition has cleared.
  if [[ -z "${CAND_ID[0]}" ]]; then
    scale_in_note_deferral
  else
    scale_in_clear_deferrals
  fi
  log "Top agent node (suffix ${CURRENT_COUNT}) is not an idle, ready, eligible node past its grace period — scale-in deferred, nothing deleted."
  exit 0
fi
scale_in_clear_deferrals
log "Nodes to drain this run: ${RUN_LEN} (suffixes ${CURRENT_COUNT} down to $(( CURRENT_COUNT - RUN_LEN + 1 )))."
log "Max to drain:     ${NOMAD_SCALE_IN_MAX_NODES_PER_RUN}"


# ─── Dry-run exit (no lock taken, no Terraform calls) ─────────────────────────

if is_dry_run; then
  log ""
  log "[DRY-RUN] Would drain and remove, top-down:"
  for ((i=0; i<RUN_LEN; i++)); do
    log "[DRY-RUN]   suffix ${CAND_SUFFIX[${i}]}: ${CAND_ID[${i}]}"
  done
  NEW_COUNT=$(( CURRENT_COUNT - RUN_LEN ))
  log "[DRY-RUN]   Current agent_node_count: ${CURRENT_COUNT}"
  log "[DRY-RUN]   New agent_node_count:     ${NEW_COUNT}"
  log "[DRY-RUN] Would validate a saved plan before any apply."
  log "[DRY-RUN] No changes made."
  exit 0
fi

# ─── Drain the selected suffix (top-down) ─────────────────────────────────────
# The lock and the capacity guard were taken before selection, so the walk above
# is already under lock. Each node is re-checked idle right before it is drained.
declare -a DRAIN_OK=()
declare -a DRAIN_IDX=()
declare -a DRAIN_NAME=()
for ((i=0; i<RUN_LEN; i++)); do
  node_id="${CAND_ID[${i}]}"
  suffix="${CAND_SUFFIX[${i}]}"
  cand_name="${CAND_NAME[${i}]}"
  log ""
  log "--- Processing node ${node_id} (suffix ${suffix}) ---"

  # Stop at the first failure so the drained set stays a contiguous top suffix.
  # The node that stopped the run keeps TF index NEW_COUNT-1 and is never deleted.
  if ! node_is_idle "${node_id}"; then
    log "Node ${node_id} received allocations since selection — stopping here."
    break
  fi
  # H1: the node must still be the one the cloud server was matched to.
  if ! live_name="$(node_name "${node_id}")" || [[ "${live_name}" != "${cand_name}" ]]; then
    log "Node ${node_id} no longer matches server ${cand_name} — stopping here."
    break
  fi
  if ! mark_node_ineligible "${node_id}"; then
    log "WARNING: Failed to mark node ${node_id} ineligible — stopping here."
    break
  fi
  if ! drain_node "${node_id}" "${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}"; then
    log "WARNING: Failed to initiate drain on node ${node_id} — stopping here."
    scale_in_restore_node "${node_id}"
    break
  fi
  if ! wait_for_drain_complete "${node_id}" "${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}"; then
    log "WARNING: Node ${node_id} did not drain within ${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}s deadline."
    log "  Node will NOT be destroyed. Clearing drain and re-marking as eligible for investigation."
    scale_in_restore_node "${node_id}"
    break
  fi

  DRAIN_OK+=("${node_id}")
  DRAIN_IDX+=("${suffix}")
  DRAIN_NAME+=("${cand_name}")
done

if [[ "${#DRAIN_OK[@]}" -eq 0 ]]; then
  log "No nodes successfully processed — terraform apply skipped."

  if alert_failure; then
    send_alert "scale_in_no_drainable_nodes" "No idle nodes could be successfully marked ineligible and drained. Scale-in aborted."
  fi

  exit 1
fi

# ─── Saved plan, validated before apply ───────────────────────────────────────

NEW_COUNT=$(( CURRENT_COUNT - ${#DRAIN_OK[@]} ))
# M2: refuse rather than clamp when the planned count leaves [MIN, CURRENT).
if ! scale_in_new_count_ok "${CURRENT_COUNT}" "${NEW_COUNT}" "${MIN_COUNT}"; then
  log "ERROR: planned count ${NEW_COUNT} is outside [${MIN_COUNT}, ${CURRENT_COUNT}) — nothing applied."
  scale_in_restore_drained
  exit 1
fi

# CSV of TF indices to delete, and index=name bindings: suffix N maps to index N-1.
TF_INDICES=""
BINDINGS=""
for i in "${!DRAIN_IDX[@]}"; do
  TF_INDICES="${TF_INDICES:+${TF_INDICES},}$(( DRAIN_IDX[i] - 1 ))"
  BINDINGS="${BINDINGS:+${BINDINGS},}$(( DRAIN_IDX[i] - 1 ))=${DRAIN_NAME[i]}"
done

log ""
log "=== Scaling in: ${CURRENT_COUNT} → ${NEW_COUNT} agent nodes ==="
log "  Nodes to destroy: ${#DRAIN_OK[@]}"
for node_id in "${DRAIN_OK[@]}"; do
  log "    - ${node_id}"
done

SCALE_IN_TMP_DIR="$(umask 077; mktemp -d)"
plan_file="${SCALE_IN_TMP_DIR}/scale-in.tfplan"
plan_args=(-input=false "-out=${plan_file}" -var "agent_node_count=${NEW_COUNT}")
tfvars_file="${TERRAFORM_DIR}/${HEROBIDS_ENV}.tfvars"
if [[ -f "${tfvars_file}" ]]; then
  plan_args+=("-var-file=${tfvars_file}")
fi

if ! (cd "${TERRAFORM_DIR}" && terraform plan "${plan_args[@]}" >/dev/null); then
  log "ERROR: terraform plan failed. Agent node count unchanged at ${CURRENT_COUNT}."
  scale_in_restore_drained
  if alert_failure; then
    send_alert "scale_in_failed" "Terraform plan failed while preparing to scale in from ${CURRENT_COUNT} to ${NEW_COUNT} agent nodes."
  fi
  exit 1
fi

PLAN_JSON="$(cd "${TERRAFORM_DIR}" && terraform show -json "${plan_file}" 2>/dev/null)" || PLAN_JSON=""
if ! printf '%s' "${PLAN_JSON}" | scale_in_plan_validate "${CURRENT_COUNT}" "${NEW_COUNT}" "${TF_INDICES}" "${BINDINGS}"; then
  log "ERROR: saved plan rejected by the scale-in guard. Nothing applied."
  scale_in_restore_drained
  if alert_failure; then
    send_alert "scale_in_plan_rejected" "Scale-in plan from ${CURRENT_COUNT} to ${NEW_COUNT} agent nodes was rejected by the drained-suffix guard. Nothing was applied."
  fi
  exit 1
fi

# ─── Terraform apply ──────────────────────────────────────────────────────────

if tf_apply_plan "${plan_file}"; then
  log ""
  log "=== Scale-in successful ==="
  log "  Agent nodes: ${CURRENT_COUNT} → ${NEW_COUNT}"
  log "  Removed:      ${#DRAIN_OK[@]} node(s)"

  # Diagnostic cache only; the next run reads the count from the capacity guard.
  write_node_count "${NEW_COUNT}"

  # Clear failure count — successful scale-in resets the alert streak
  clear_failure_count
  scale_in_clear_deferrals
else
  log ""
  log "ERROR: Terraform apply failed. Agent node count unchanged at ${CURRENT_COUNT}."
  log "Re-marking drained nodes as eligible so they can receive allocations again..."
  scale_in_restore_drained
  log "Run scale-in again after resolving the terraform error."

  if alert_failure; then
    send_alert "scale_in_failed" "Terraform apply failed while attempting to scale in from ${CURRENT_COUNT} to ${NEW_COUNT} agent nodes."
  fi

  exit 1
fi

if [[ ${SCALE_IN_RESTORE_FAILED} -ne 0 ]]; then
  die "Scale-in applied, but a node that was not removed could not be restored to schedulable. Manual check required." 1
fi

log "Done."
exit 0
