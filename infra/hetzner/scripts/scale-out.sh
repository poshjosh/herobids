#!/usr/bin/env bash
# scale-out.sh — Autoscale-out for Herobids Nomad agent node pool.
#
# Polls Nomad cluster capacity and provisions additional agent nodes via
# Terraform when free capacity drops below configured thresholds.
# Uses flock to serialize Terraform operations (only one provision at a time).
#
# Usage:
#   scale-out.sh [--help] [--dry-run] [--force] [--bypass-cooldown]
#
# Options:
#   --help              Show this help message.
#   --dry-run           Compute capacity and show what would happen without scaling.
#   --force             Force a scale-out even if thresholds are not crossed
#                       (still respects max_agent_nodes and cooldown).
#   --bypass-cooldown   Bypass the cooldown check (safety-net escape hatch).
#   --safety-net        Convenience alias for --bypass-cooldown --force.
#                       Used by check-placement-failures.sh (Phase 7).
#
# Exit codes:
#   0  Success (scale-out completed, or no action needed).
#   1  Configuration or runtime error.
#   2  Nomad cluster has no ready nodes (blocking — cannot assess capacity).
#   3  Already at max_agent_nodes.
#   4  Lock held by another process (non-blocking).
#
# The Terraform count is derived under the lock from the capacity guard
# (capacity-inventory.sh: cloud + Nomad reconcile, including down servers).
# The node-count cache is diagnostic only. Any guard blocker refuses the
# scale-out (exit 1). A scale-out still in its readiness window is skipped (exit 0).
#
# Environment (see scale-common.sh for full list and defaults):
#   NOMAD_ADDR                          Nomad server HTTP API base URL.
#   NOMAD_AGENT_MEMORY_RESERVATION_MB   Memory reservation per agent slot.
#   NOMAD_SCALE_OUT_COOLDOWN_SECONDS    Cooldown between scale-out operations.
#   NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT Free memory % below which we scale out.
#   NOMAD_SCALE_OUT_SLOT_THRESHOLD      Free slots below which we scale out.
#   NOMAD_SCALE_OUT_INCREMENT           Nodes to add per scale-out event (default: 1).
#   NOMAD_AUTOSCALE_LOCKFILE            Path to flock lock file.
#   NOMAD_AUTOSCALE_COOLDOWN_FILE       Path to cooldown timestamp file.
#   NOMAD_AUTOSCALE_NODE_POOL           Nomad/Hetzner node pool managed by this autoscaler.
#   NOMAD_AUTOSCALE_INFLIGHT_FILE       In-flight scale-out record (readiness window).
#   NOMAD_SCALE_OUT_READY_TIMEOUT_SECONDS  Readiness window for a scale-out.
#   TERRAFORM_DIR                       Path to Terraform working directory.
#   TF_CLI_ARGS                         Extra args passed to terraform (e.g., -var-file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scale-common.sh"
source "${SCRIPT_DIR}/alert-common.sh"
source "${SCRIPT_DIR}/capacity-inventory.sh"
validate_scale_numeric_env

# ─── Parse arguments ──────────────────────────────────────────────────────────

FORCE=false
BYPASS_COOLDOWN=false
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
    --force)
      FORCE=true
      shift
      ;;
    --bypass-cooldown)
      BYPASS_COOLDOWN=true
      shift
      ;;
    --safety-net)
      # Convenience alias: bypass cooldown and force scale-out.
      # Used by check-placement-failures.sh for the placement-failure safety net (Phase 7).
      BYPASS_COOLDOWN=true
      FORCE=true
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
Usage: $0 [--help] [--dry-run] [--force] [--bypass-cooldown]

Autoscale-out for the Herobids Nomad agent node pool.

Polls Nomad cluster capacity via check-nomad-capacity.sh and provisions
additional agent nodes through Terraform when free capacity is low.

Options:
  --help              Show this help message.
  --dry-run           Compute capacity and show decision without scaling.
  --force             Force scale-out even if thresholds are not crossed
                      (still respects max_agent_nodes and cooldown).
  --bypass-cooldown   Bypass cooldown check (safety-net escape hatch for
                      placement-failure detection in Phase 7).
  --safety-net        Convenience alias for --bypass-cooldown --force.
                      Used by check-placement-failures.sh (Phase 7).

Configuration (env vars, see scale-common.sh for defaults):
  NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT  Free memory % below which we scale out (default: 20).
  NOMAD_SCALE_OUT_SLOT_THRESHOLD        Free slots below which we scale out (default: 3).
  NOMAD_SCALE_OUT_COOLDOWN_SECONDS      Cooldown between scale-out events (default: 300).
  NOMAD_SCALE_OUT_INCREMENT             Nodes to add per event (default: 1).
  TERRAFORM_DIR                         Terraform working directory.

Exit codes:
  0  Success, no action needed, or a scale-out still in its readiness window.
  1  Configuration, runtime, or capacity-guard refusal.
  2  No ready Nomad client nodes.
  3  Already at max_agent_nodes.
  4  Lock held by another process.
EOF
  exit 0
fi

# ─── Pre-flight checks ────────────────────────────────────────────────────────

log "=== Nomad Autoscale-Out ==="
log "  Environment:   ${HEROBIDS_ENV:-unknown}"
log "  Nomad API:     ${NOMAD_ADDR}"
log "  Terraform dir: ${TERRAFORM_DIR}"
log "  Dry run:       ${DRY_RUN}"
log "  Force:         ${FORCE}"
log "  Bypass cooldown: ${BYPASS_COOLDOWN}"
log ""

if [[ ! "${NOMAD_SCALE_OUT_INCREMENT}" =~ ^[1-9][0-9]*$ ]]; then
  die "NOMAD_SCALE_OUT_INCREMENT must be a positive integer (got: '${NOMAD_SCALE_OUT_INCREMENT}')." 1
fi

# Initialize Terraform with S3 backend and select the correct workspace.
# Skipped in dry-run: init and workspace selection are not read-only.
tf_ensure_env

if ! is_dry_run; then
  tf_ensure_ready

  # Take the lock before any count decision (M7). Dry-run takes no lock and
  # creates no lockfile.
  if ! acquire_lock "${NOMAD_AUTOSCALE_LOCKFILE}" 0; then
    log "Another autoscale operation is in progress — skipping."
    exit 4
  fi
  trap 'release_lock' EXIT

  # Cooldown is re-checked under the lock to prevent a TOCTOU race between
  # concurrent scale-out invocations.
  if [[ "${BYPASS_COOLDOWN}" != "true" ]]; then
    if ! check_cooldown_expired "${NOMAD_SCALE_OUT_COOLDOWN_SECONDS}"; then
      log "Cooldown has not expired (checked under lock) — skipping scale-out."
      log "Use --bypass-cooldown to override (safety-net path)."
      exit 0
    fi
  else
    log "Cooldown bypassed (--bypass-cooldown)."
  fi
fi

# ─── Get current state ────────────────────────────────────────────────────────

log "Reading state under the capacity guard (C1)..."

# The count is the reconciled managed count, never the node-count cache or a
# Nomad-only fallback. Any blocker refuses the scale-out.
GATE_MUTATE=true
if is_dry_run; then
  GATE_MUTATE=false
fi

GATE_RC=0
GATE_OUT="$(capacity_scale_gate "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "$(date +%s)" "${GATE_MUTATE}")" || GATE_RC=$?

case "${GATE_RC}" in
  0) ;;
  2)
    log "A scale-out is still in flight (readiness window open) — skipping."
    exit 0
    ;;
  3)
    log "Capacity guard BLOCKED scale-out: $(jq -c '.blockers' <<< "${GATE_OUT}")"
    if is_dry_run; then
      log "[DRY-RUN] Scale-out would be refused."
      exit 0
    fi
    if alert_failure; then
      send_alert "scale_out_capacity_blocked" "Capacity guard refused scale-out for pool ${NOMAD_AUTOSCALE_NODE_POOL}. Blockers: $(jq -c '.blockers' <<< "${GATE_OUT}")"
    fi
    exit 1
    ;;
  *)
    log "Capacity guard could not read state (exit ${GATE_RC}) — refusing scale-out."
    if ! is_dry_run && alert_failure; then
      send_alert "scale_out_capacity_guard_failed" "Capacity guard could not read cloud or Nomad state (exit ${GATE_RC}). Scale-out refused."
    fi
    exit 1
    ;;
esac

CURRENT_COUNT="$(jq -r '.managed_count' <<< "${GATE_OUT}")"
BASELINE_IDS="$(jq -c '[.servers[].id]' <<< "${GATE_OUT}")"
MAX_COUNT="$(max_agent_nodes)"

log "  Managed agent nodes: ${CURRENT_COUNT}"
log "  Max agent nodes:     ${MAX_COUNT}"

if [[ ! "${MAX_COUNT}" =~ ^[0-9]+$ ]]; then
  die "max_agent_nodes is not a number: '${MAX_COUNT}'." 1
fi

# ─── Check max cap ────────────────────────────────────────────────────────────

NEW_COUNT=$(( CURRENT_COUNT + NOMAD_SCALE_OUT_INCREMENT ))
if [[ ${NEW_COUNT} -gt ${MAX_COUNT} ]]; then
  log "Already at or above max_agent_nodes (${CURRENT_COUNT}/${MAX_COUNT})."
  log "No scale-out possible."
  exit 3
fi

# Dry-run stops before the capacity read: live free-capacity values are unknown
# in dry-run, so no threshold decision is claimed.
if is_dry_run; then
  log ""
  log "[DRY-RUN] Candidate scale-out (live capacity thresholds not evaluated):"
  log "[DRY-RUN]   Managed agent_node_count: ${CURRENT_COUNT}"
  log "[DRY-RUN]   Candidate new count:      ${NEW_COUNT}"
  log "[DRY-RUN] No changes made."
  exit 0
fi

# ─── Check Nomad capacity ─────────────────────────────────────────────────────

log ""
log "Checking Nomad cluster capacity..."

# Call check-nomad-capacity.sh once; capture stdout (key=value lines) for parsing,
# and forward stderr (log lines) to our own stderr.
CAPACITY_STDERR="$(mktemp)" || die "Could not create a temp file for capacity output." 1
CAPACITY_EXIT_CODE=0
# The || keeps set -e from aborting before the exit code is captured (H2).
CAPACITY_VARS="$("${SCRIPT_DIR}/check-nomad-capacity.sh" 2>"${CAPACITY_STDERR}")" || CAPACITY_EXIT_CODE=$?
# Forward the capacity script's log output to our log
while IFS= read -r line; do
  [[ -n "${line}" ]] && log "[capacity] ${line}"
done < "${CAPACITY_STDERR}"
rm -f "${CAPACITY_STDERR}"

if [[ ${CAPACITY_EXIT_CODE} -eq 2 ]]; then
  log "No ready Nomad client nodes — cannot assess capacity."
  log "If this is a fresh cluster, at least one agent node must be provisioned manually first."

  # Track failure for alerting — no ready nodes blocks all scaling
  if alert_failure; then
    send_alert "scale_out_no_ready_nodes" "Nomad cluster has no ready client nodes. Cannot assess capacity or scale out. Ensure at least one agent node is provisioned and joined to the cluster."
  fi

  exit 2
elif [[ ${CAPACITY_EXIT_CODE} -ne 0 ]]; then
  log "Capacity check failed with exit code ${CAPACITY_EXIT_CODE}."

  if alert_failure; then
    send_alert "scale_out_capacity_check_failed" "Nomad capacity check (check-nomad-capacity.sh) exited with code ${CAPACITY_EXIT_CODE}. Scale-out cannot proceed."
  fi

  die "Capacity check failed with exit code ${CAPACITY_EXIT_CODE}." 1
fi

# Parse the capacity output strictly. Nothing from it is evaluated; a malformed
# line or a missing key refuses the scale-out.
if ! parse_capacity_output "${CAPACITY_VARS}"; then
  if alert_failure; then
    send_alert "scale_out_capacity_output_malformed" "Nomad capacity output (check-nomad-capacity.sh) was malformed or incomplete. Scale-out refused."
  fi

  die "Capacity output was malformed or incomplete; refusing scale-out." 1
fi

FREE_MEMORY_MB="${CAP_FREE_MEMORY_MB}"
FREE_SLOTS="${CAP_FREE_SLOTS}"
FREE_MEMORY_PCT="${CAP_FREE_MEMORY_PCT}"
READY_NODES="${CAP_READY_NODES}"

log ""
log "Capacity snapshot:"
log "  Free memory:     ${FREE_MEMORY_MB} MB (${FREE_MEMORY_PCT}%)"
log "  Free slots:      ${FREE_SLOTS}"
log "  Ready nodes:     ${READY_NODES}"
log "  Memory threshold: ${NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT}%"
log "  Slot threshold:   ${NOMAD_SCALE_OUT_SLOT_THRESHOLD}"

# ─── Evaluate thresholds ──────────────────────────────────────────────────────

SHOULD_SCALE=false
SCALE_REASON=""

if [[ "${FORCE}" == "true" ]]; then
  SHOULD_SCALE=true
  SCALE_REASON="forced scale-out"
else
  # Check memory threshold
  if [[ "${FREE_MEMORY_PCT}" -lt "${NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT}" ]]; then
    SHOULD_SCALE=true
    SCALE_REASON="free memory ${FREE_MEMORY_PCT}% < threshold ${NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT}%"
  fi

  # Check slot threshold
  if [[ "${FREE_SLOTS}" -lt "${NOMAD_SCALE_OUT_SLOT_THRESHOLD}" ]]; then
    SHOULD_SCALE=true
    if [[ -n "${SCALE_REASON}" ]]; then
      SCALE_REASON="${SCALE_REASON}; free slots ${FREE_SLOTS} < threshold ${NOMAD_SCALE_OUT_SLOT_THRESHOLD}"
    else
      SCALE_REASON="free slots ${FREE_SLOTS} < threshold ${NOMAD_SCALE_OUT_SLOT_THRESHOLD}"
    fi
  fi
fi

if [[ "${SHOULD_SCALE}" != "true" ]]; then
  log ""
  log "Capacity sufficient — no scale-out needed."
  log "  Free memory: ${FREE_MEMORY_PCT}% (threshold: ${NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT}%)"
  log "  Free slots:  ${FREE_SLOTS} (threshold: ${NOMAD_SCALE_OUT_SLOT_THRESHOLD})"
  exit 0
fi

log ""
log "Scale-out needed: ${SCALE_REASON}"

# Record the in-flight scale-out before the apply (H5). Only servers observed
# after this point may satisfy its readiness window.
if ! capacity_inflight_begin "${NOMAD_AUTOSCALE_INFLIGHT_FILE}" "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "${NEW_COUNT}" "${CURRENT_COUNT}" "$(date +%s)" "${NOMAD_SCALE_OUT_READY_TIMEOUT_SECONDS}"; then
  die "Could not record the in-flight scale-out; refusing to apply." 1
fi

# ─── Terraform apply ──────────────────────────────────────────────────────────

log ""
log "=== Provisioning agent node ${NEW_COUNT}/${MAX_COUNT} ==="

log "Terraform apply: terraform apply -auto-approve -var agent_node_count=${NEW_COUNT}"

if tf_apply_var "agent_node_count=${NEW_COUNT}"; then
  log ""
  log "=== Scale-out successful ==="
  log "  Agent nodes: ${CURRENT_COUNT} → ${NEW_COUNT}"
  log "  Reason:      ${SCALE_REASON}"

  # Record the observed server IDs so readiness counts only these (H5).
  if ! capacity_observe_after_apply "${NOMAD_AUTOSCALE_INFLIGHT_FILE}" "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "${BASELINE_IDS}"; then
    log "WARNING: could not record the new server IDs; the in-flight record stays pending until it expires."
  fi

  # Diagnostic only: the node-count cache is never read for decisions (C1).
  write_node_count "${NEW_COUNT}"

  # Update cooldown timestamp
  touch_cooldown

  # Clear failure count — successful scale-out resets the alert streak
  clear_failure_count
else
  log ""
  log "ERROR: Terraform apply failed. Agent node count unchanged at ${CURRENT_COUNT}."
  log "Check terraform logs for details."

  # Track failure for alerting
  if alert_failure; then
    send_alert "scale_out_failed" "Terraform apply failed while attempting to scale from ${CURRENT_COUNT} to ${NEW_COUNT} agent nodes. Reason: ${SCALE_REASON}."
  fi

  exit 1
fi

log "Done."
exit 0
