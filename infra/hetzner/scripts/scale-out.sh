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
#
# Exit codes:
#   0  Success (scale-out completed, or no action needed).
#   1  Configuration or runtime error.
#   2  Nomad cluster has no ready nodes (blocking — cannot assess capacity).
#   3  Already at max_agent_nodes.
#   4  Lock held by another process (non-blocking).
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
#   TERRAFORM_DIR                       Path to Terraform working directory.
#   TF_CLI_ARGS                         Extra args passed to terraform (e.g., -var-file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scale-common.sh"

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

Configuration (env vars, see scale-common.sh for defaults):
  NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT  Free memory % below which we scale out (default: 20).
  NOMAD_SCALE_OUT_SLOT_THRESHOLD        Free slots below which we scale out (default: 3).
  NOMAD_SCALE_OUT_COOLDOWN_SECONDS      Cooldown between scale-out events (default: 300).
  NOMAD_SCALE_OUT_INCREMENT             Nodes to add per event (default: 1).
  TERRAFORM_DIR                         Terraform working directory.

Exit codes:
  0  Success or no action needed.
  1  Configuration or runtime error.
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

# Verify terraform is available (needed for apply step only)
if ! command -v terraform &>/dev/null; then
  die "terraform not found in PATH. Install terraform >= 1.0." 1
fi

# Verify terraform directory exists
if [[ ! -d "${TERRAFORM_DIR}" ]]; then
  die "TERRAFORM_DIR '${TERRAFORM_DIR}' does not exist. Are Nomad and agent pool provisioned for this environment?" 1
fi

# Verify terraform is initialized (state exists)
if [[ ! -f "${TERRAFORM_DIR}/terraform.tfstate" ]]; then
  die "No terraform.tfstate found in ${TERRAFORM_DIR}. Run 'terraform init' first." 1
fi

# ─── Get current state ────────────────────────────────────────────────────────

log "Reading current Terraform state..."

CURRENT_COUNT="$(current_agent_node_count)"
MAX_COUNT="$(max_agent_nodes)"

log "  Current agent nodes: ${CURRENT_COUNT}"
log "  Max agent nodes:     ${MAX_COUNT}"

# Validate the counts are sensible
if [[ -z "${CURRENT_COUNT}" ]]; then
  die "Could not determine current agent_node_count from Terraform state." 1
fi
if [[ -z "${MAX_COUNT}" ]]; then
  die "Could not determine max_agent_nodes from Terraform state." 1
fi

# ─── Check max cap ────────────────────────────────────────────────────────────

NEW_COUNT=$(( CURRENT_COUNT + NOMAD_SCALE_OUT_INCREMENT ))
if [[ ${NEW_COUNT} -gt ${MAX_COUNT} ]]; then
  log "Already at or above max_agent_nodes (${CURRENT_COUNT}/${MAX_COUNT})."
  log "No scale-out possible."
  exit 3
fi

# ─── Check Nomad capacity ─────────────────────────────────────────────────────

log ""
log "Checking Nomad cluster capacity..."

# Call check-nomad-capacity.sh once; capture stdout (key=value lines) for parsing,
# and forward stderr (log lines) to our own stderr.
CAPACITY_STDERR="$(mktemp)"
CAPACITY_VARS="$("${SCRIPT_DIR}/check-nomad-capacity.sh" 2>"${CAPACITY_STDERR}")"
CAPACITY_EXIT_CODE=$?
# Forward the capacity script's log output to our log
while IFS= read -r line; do
  [[ -n "${line}" ]] && log "[capacity] ${line}"
done < "${CAPACITY_STDERR}"
rm -f "${CAPACITY_STDERR}"

if [[ ${CAPACITY_EXIT_CODE} -eq 2 ]]; then
  log "No ready Nomad client nodes — cannot assess capacity."
  log "If this is a fresh cluster, at least one agent node must be provisioned manually first."
  exit 2
elif [[ ${CAPACITY_EXIT_CODE} -ne 0 ]]; then
  die "Capacity check failed with exit code ${CAPACITY_EXIT_CODE}." 1
fi

# Source the capacity variables
eval "${CAPACITY_VARS}"

FREE_MEMORY_MB="${free_memory_mb:-0}"
FREE_SLOTS="${free_slots:-0}"
FREE_MEMORY_PCT="${free_memory_pct:-0}"
READY_NODES="${ready_nodes:-0}"

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

# ─── Dry-run exit ─────────────────────────────────────────────────────────────

if is_dry_run; then
  log ""
  log "[DRY-RUN] Would scale out:"
  log "[DRY-RUN]   Current agent_node_count: ${CURRENT_COUNT}"
  log "[DRY-RUN]   New agent_node_count:     ${NEW_COUNT}"
  log "[DRY-RUN]   Terraform would run: terraform apply -auto-approve -var agent_node_count=${NEW_COUNT}"
  log "[DRY-RUN] No changes made."
  exit 0
fi

# ─── Acquire lock ─────────────────────────────────────────────────────────────

if ! acquire_lock "${NOMAD_AUTOSCALE_LOCKFILE}" 0; then
  log "Another autoscale operation is in progress — skipping."
  exit 4
fi

# Ensure lock is released on exit
trap 'release_lock' EXIT

# ─── Re-check cooldown inside lock (TOCTOU guard) ─────────────────────────────
#
# The cooldown is checked again here after acquiring the lock to prevent a
# TOCTOU race: two concurrent scale-out invocations could both pass the
# initial cooldown check, then one acquires the lock and scales out, and
# the second acquires the lock immediately after and scales out again
# without waiting for the cooldown. Re-checking under the lock prevents this.

if [[ "${BYPASS_COOLDOWN}" != "true" ]]; then
  if ! check_cooldown_expired "${NOMAD_SCALE_OUT_COOLDOWN_SECONDS}"; then
    log "Cooldown has not expired (re-checked under lock) — skipping scale-out."
    log "Use --bypass-cooldown to override (safety-net path)."
    exit 0
  fi
else
  log "Cooldown bypassed (--bypass-cooldown)."
fi

# ─── Re-read current count under lock (defensive) ─────────────────────────────

# Re-read to guard against a stale read from before the lock was acquired.
CURRENT_COUNT="$(current_agent_node_count)"
NEW_COUNT=$(( CURRENT_COUNT + NOMAD_SCALE_OUT_INCREMENT ))
if [[ ${NEW_COUNT} -gt ${MAX_COUNT} ]]; then
  log "Already at or above max_agent_nodes (${CURRENT_COUNT}/${MAX_COUNT}) — skipping."
  exit 3
fi

# ─── Terraform apply ──────────────────────────────────────────────────────────

log ""
log "=== Provisioning agent node ${NEW_COUNT}/${MAX_COUNT} ==="

cd "${TERRAFORM_DIR}"

# Build terraform -var args from env vars.
# TF_VAR_* env vars are automatically read by terraform, so we only need
# to pass the dynamic agent_node_count. The static vars (max, min,
# thresholds, etc.) are set via systemd Environment=TF_VAR_... directives
# and picked up by terraform automatically.
#
# We also pass -var-file if TF_CLI_ARGS or the env-specific tfvars exists,
# as a convenience for the initial provision that may have extra vars.
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
  # If no env-specific tfvars exists, fall back to generic terraform.tfvars
  if [[ -z "${TF_ARGS}" ]] && [[ -f "${TERRAFORM_DIR}/terraform.tfvars" ]]; then
    TF_ARGS="-var-file=${TERRAFORM_DIR}/terraform.tfvars"
  fi
fi

log "Terraform args: ${TF_ARGS} -var agent_node_count=${NEW_COUNT}"

# shellcheck disable=SC2086
if terraform apply -auto-approve ${TF_ARGS} -var "agent_node_count=${NEW_COUNT}"; then
  log ""
  log "=== Scale-out successful ==="
  log "  Agent nodes: ${CURRENT_COUNT} → ${NEW_COUNT}"
  log "  Reason:      ${SCALE_REASON}"

  # Persist the new count so current_agent_node_count() picks it up
  write_node_count "${NEW_COUNT}"

  # Update cooldown timestamp
  touch_cooldown
else
  log ""
  log "ERROR: Terraform apply failed. Agent node count unchanged at ${CURRENT_COUNT}."
  log "Check terraform logs for details."
  exit 1
fi

log "Done."
exit 0
