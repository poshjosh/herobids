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
#   --bypass-cooldown   Bypass the cooldown check (legacy policy only). In demand-aware
#                       mode this FAILS (exit 1): the demand controller has one policy.
#   --safety-net        Convenience alias for --bypass-cooldown --force. Legacy policy only;
#                       in demand-aware mode it fails like --bypass-cooldown. The placement
#                       watcher (check-placement-failures.sh) is an observer in demand mode.
#
# Demand-aware mode (NOMAD_AUTOSCALE_DEMAND_ENABLED=true, default false) is the sole
# capacity-increase writer. It takes the lock first, reads the reconciled inventory and
# check-nomad-capacity.sh --bins-json, decides the addition with the floor/backlog/headroom
# simulation (plan 5.6), then plans, validates the saved plan and applies that exact plan
# (plan 5.7). Dry-run (--dry-run) makes no Terraform call and writes no state.
#
# Exit codes:
#   0  Success (scale-out completed, or no action needed).
#   1  Configuration or runtime error, or a capacity-guard, plan-allowlist or apply refusal.
#   2  Nomad cluster has no ready nodes (blocking — cannot assess capacity).
#   3  Already at max_agent_nodes (legacy policy).
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
source "${SCRIPT_DIR}/capacity-demand.sh"
source "${SCRIPT_DIR}/capacity-controller.sh"
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
  --bypass-cooldown   Bypass cooldown check (legacy policy only). In demand-aware
                      mode this fails with exit 1.
  --safety-net        Convenience alias for --bypass-cooldown --force. Legacy policy
                      only; fails in demand-aware mode like --bypass-cooldown.

Configuration (env vars, see scale-common.sh for defaults):
  NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT  Free memory % below which we scale out (default: 20).
  NOMAD_SCALE_OUT_SLOT_THRESHOLD        Free slots below which we scale out (default: 3).
  NOMAD_SCALE_OUT_COOLDOWN_SECONDS      Cooldown between scale-out events (default: 300).
  NOMAD_SCALE_OUT_INCREMENT             Nodes to add per event, legacy policy (default: 1).
  NOMAD_SCALE_OUT_INCREMENT_MAX         Batch cap per event, demand-aware mode (1 or 2; default: 2).
  NOMAD_AUTOSCALE_DEMAND_ENABLED        true enables demand-aware mode (default: false).
  NOMAD_NODE_TEMPLATE_MEMORY_MB         Demand mode: memory of one agent node (required).
  NOMAD_NODE_TEMPLATE_CPU_MHZ           Demand mode: CPU of one agent node (required).
  NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS Demand mode: capacity-blocked observations before backlog counts (default: 2).
  NOMAD_SCALE_OUT_FAILURE_BACKOFF_SECONDS Demand mode: backoff after a failed plan or apply (default: 300).
  TERRAFORM_DIR                         Terraform working directory.

Exit codes:
  0  Success, no action needed, or a scale-out still in its readiness window.
  1  Configuration, runtime, capacity-guard, plan-allowlist or apply refusal.
  2  No ready Nomad client nodes.
  3  Already at max_agent_nodes (legacy policy).
  4  Lock held by another process.
EOF
  exit 0
fi

# ─── Demand-aware controller (plan 5.1, 5.6, 5.7) ─────────────────────────────
#
# Runs only when NOMAD_AUTOSCALE_DEMAND_ENABLED=true; the legacy policy is untouched
# otherwise. demand_scale_out never returns. Dry-run is read-only: no lock, no Terraform
# command, no controller state write and no alert. Every line it logs names the mode.

DEMAND_TMP_DIR=""

demand_log() {
  if is_dry_run; then
    log "[DRY-RUN][demand] $*"
  else
    log "[demand] $*"
  fi
}

# demand_alert TYPE REASON — live mode only; alert_failure rate-limits the send.
demand_alert() {
  if ! is_dry_run && alert_failure; then
    send_alert "$1" "$2"
  fi
}

# demand_attempt_failed STAGE ALERT_TYPE REASON — a failed plan or apply starts the failure
# backoff, which is separate from the success cooldown.
demand_attempt_failed() {
  demand_log "ERROR: ${1} failed; the agent node count was not changed."
  if ! controller_record_failure "$(date +%s)"; then
    demand_log "WARNING: could not record the failed attempt; failure backoff is not active."
  fi
  demand_alert "$2" "$3"
  exit 1
}

demand_cleanup() {
  release_lock
  if [[ -n "${DEMAND_TMP_DIR}" ]]; then
    rm -rf -- "${DEMAND_TMP_DIR}"
  fi
}

demand_scale_out() {
  local now floor cap tmem tcpu slot_threshold gate_mutate
  local gate_out="" gate_rc=0 pending=false
  local managed ready_inv servers_len baseline_ids snap active viable unavailable
  local check_json="" check_rc=0 check_ready free_slots bin_count ready_state
  local cooldown_active=false backoff_active=false
  local demand_json="" classified="" usable=true items_json="[]" unclassified=0
  local blocked_queued=0 status streak mature=false headroom=false
  local bins_json decision_input decision add target remaining reasons
  local plan_file var_file
  local -a plan_args

  if [[ "${BYPASS_COOLDOWN}" == "true" ]]; then
    die "--bypass-cooldown and --safety-net are not supported when NOMAD_AUTOSCALE_DEMAND_ENABLED=true; the demand controller has one policy. Use --force for a minimal addition." 1
  fi

  validate_demand_template_env
  tmem="${NOMAD_NODE_TEMPLATE_MEMORY_MB}"
  tcpu="${NOMAD_NODE_TEMPLATE_CPU_MHZ}"
  floor="$(min_agent_nodes)"
  cap="$(max_agent_nodes)"
  require_uint min_agent_nodes "${floor}" 0 100000
  require_uint max_agent_nodes "${cap}" 1 100000
  (( floor <= cap )) || die "min_agent_nodes (${floor}) exceeds max_agent_nodes (${cap})." 1
  slot_threshold="${NOMAD_SCALE_OUT_SLOT_THRESHOLD}"
  require_uint NOMAD_SCALE_OUT_SLOT_THRESHOLD "${slot_threshold}" 0 100000
  require_uint NOMAD_AGENT_MEMORY_RESERVATION_MB "${NOMAD_AGENT_MEMORY_RESERVATION_MB}" 1 100000
  require_uint NOMAD_AGENT_CPU_RESERVATION_MHZ "${NOMAD_AGENT_CPU_RESERVATION_MHZ}" 1 100000

  demand_log "Mode: demand-aware (floor=${floor}, cap=${cap}, increment_max=${NOMAD_SCALE_OUT_INCREMENT_MAX})."

  tf_ensure_env
  tf_use_env_data_dir

  if is_dry_run; then
    # Read-only: the backend must already be initialised and the workspace state present.
    if [[ ! -f "${TF_DATA_DIR}/terraform.tfstate" ]] \
      || [[ "$(cat "${TF_DATA_DIR}/environment" 2>/dev/null || true)" != "${HEROBIDS_ENV}" ]]; then
      demand_log "Terraform backend is not initialised for ${HEROBIDS_ENV} under ${TF_DATA_DIR}; cannot evaluate read-only."
      exit 1
    fi
  else
    # The lock comes first: backend preparation, state reads and count decisions all run under it.
    if ! acquire_lock "${NOMAD_AUTOSCALE_LOCKFILE}" 0; then
      demand_log "Another autoscale operation is in progress — skipping."
      exit 4
    fi
    trap 'demand_cleanup' EXIT
    [[ -d "${TERRAFORM_DIR}" ]] || die "TERRAFORM_DIR does not exist: ${TERRAFORM_DIR}" 1
    command -v terraform >/dev/null 2>&1 || die "terraform is not on PATH." 1
    tf_init_backend
    # Select only. The workspace must already exist; it is never created here.
    if ! (cd "${TERRAFORM_DIR}" && terraform workspace select "${HEROBIDS_ENV}" >/dev/null); then
      die "Terraform workspace '${HEROBIDS_ENV}' is absent or not selectable; refusing." 1
    fi
  fi

  # ─── Reconciled inventory (capacity guard) ──────────────────────────────────
  now="$(date +%s)"
  gate_mutate=true
  if is_dry_run; then gate_mutate=false; fi
  gate_out="$(capacity_scale_gate "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "${now}" "${gate_mutate}")" || gate_rc=$?
  case "${gate_rc}" in
    0) ;;
    2) pending=true ;;
    3)
      demand_log "Capacity guard BLOCKED scale-out: $(jq -c '.blockers' <<< "${gate_out}" 2>/dev/null || echo unknown)"
      if is_dry_run; then exit 0; fi
      demand_alert "scale_out_capacity_blocked" "Capacity guard refused scale-out for pool ${NOMAD_AUTOSCALE_NODE_POOL}."
      exit 1
      ;;
    *)
      demand_log "Capacity guard could not read state (exit ${gate_rc}) — refusing scale-out."
      demand_alert "scale_out_capacity_guard_failed" "Capacity guard could not read cloud or Nomad state (exit ${gate_rc}). Scale-out refused."
      exit 1
      ;;
  esac

  managed="$(jq -r '.managed_count' <<< "${gate_out}")" || die "Capacity snapshot is unreadable; refusing." 1
  ready_inv="$(jq -r '.ready_count' <<< "${gate_out}")" || die "Capacity snapshot is unreadable; refusing." 1
  require_uint MANAGED_COUNT "${managed}" 0 100000
  require_uint INVENTORY_READY "${ready_inv}" 0 100000
  servers_len="$(jq '.servers | length' <<< "${gate_out}")" || die "Capacity snapshot is unreadable; refusing." 1
  [[ "${servers_len}" == "${managed}" ]] || die "Inventory server list disagrees with managed_count; refusing." 1
  baseline_ids="$(jq -c '[.servers[].id]' <<< "${gate_out}")" || die "Capacity snapshot is unreadable; refusing." 1

  # Classify managed servers: active (Nomad ready), viable in-flight (a pending scale-out
  # server that has not yet joined), and unavailable. Viable servers become template-sized
  # bins so their capacity is not counted twice.
  snap="$(jq -c --argjson tmem "${tmem}" --argjson tcpu "${tcpu}" '
    (.in_flight.state == "pending") as $pending
    | def cls: if .nomad == "ready" then "active"
        elif $pending and ((.nomad == "unjoined") or (.nomad == "joined_not_ready"))
             and (.cloud_status != "deleting") then "viable"
        else "unavailable" end;
    [.servers[] | cls] as $c
    | {
        active: ([$c[] | select(. == "active")] | length),
        viable: ([$c[] | select(. == "viable")] | length),
        unavailable: ([$c[] | select(. == "unavailable")] | length),
        viable_bins: [ .servers[] | select(cls == "viable")
          | { id: ("viable-" + (.id | tostring)), kind: "viable",
              free_memory_mb: $tmem, free_cpu_mhz: $tcpu } ]
      }
  ' <<< "${gate_out}")" || die "Could not classify managed servers; refusing." 1
  active="$(jq -r '.active' <<< "${snap}")"
  viable="$(jq -r '.viable' <<< "${snap}")"
  unavailable="$(jq -r '.unavailable' <<< "${snap}")"

  # ─── Nomad capacity and ready-node cross-check ──────────────────────────────
  check_json="$("${SCRIPT_DIR}/check-nomad-capacity.sh" --bins-json)" || check_rc=$?
  if [[ ${check_rc} -ne 0 && ${check_rc} -ne 2 ]]; then
    demand_log "Capacity check failed with exit code ${check_rc} — refusing scale-out."
    demand_alert "scale_out_capacity_check_failed" "Nomad capacity check (check-nomad-capacity.sh --bins-json) exited with code ${check_rc}. Scale-out cannot proceed."
    exit 1
  fi
  if ! jq -e '(.ready_nodes | type == "number") and (.free_slots | type == "number") and (.bins | type == "array")' \
      <<< "${check_json}" >/dev/null 2>&1; then
    demand_alert "scale_out_capacity_output_malformed" "Nomad capacity output (check-nomad-capacity.sh --bins-json) was malformed. Scale-out refused."
    die "Capacity output was malformed; refusing scale-out." 1
  fi
  check_ready="$(jq -r '.ready_nodes' <<< "${check_json}")"
  free_slots="$(jq -r '.free_slots' <<< "${check_json}")"
  require_uint CHECK_READY "${check_ready}" 0 100000
  require_uint FREE_SLOTS "${free_slots}" 0 100000

  ready_state="$(controller_ready_crosscheck "${check_ready}" "${ready_inv}" "${managed}")" || {
    demand_alert "scale_out_capacity_check_failed" "Ready-node count from check-nomad-capacity.sh disagrees with the reconciled inventory. Scale-out refused."
    die "Ready-node readings disagree; refusing scale-out (fail closed)." 1
  }
  case "${ready_state}" in
    ready) ;;
    dead_pool)
      demand_log "Dead pool: ${managed} managed node(s) exist and none is ready. Only floor recovery is considered."
      demand_alert "scale_out_no_ready_nodes" "Nomad reports no ready client nodes but ${managed} managed node(s) exist. Only floor recovery is considered."
      ;;
    *)
      demand_log "No ready Nomad client nodes — cannot assess capacity."
      demand_alert "scale_out_no_ready_nodes" "Nomad cluster has no ready client nodes. Cannot assess capacity or scale out."
      exit 2
      ;;
  esac

  bin_count="$(jq '.bins | length' <<< "${check_json}")"
  if [[ "${bin_count}" != "${active}" ]]; then
    demand_alert "scale_out_capacity_output_malformed" "Node bins (${bin_count}) disagree with active inventory nodes (${active}). Scale-out refused."
    die "Node bins (${bin_count}) disagree with active inventory nodes (${active}); refusing scale-out." 1
  fi

  if check_cooldown_expired "${NOMAD_SCALE_OUT_COOLDOWN_SECONDS}"; then :; else cooldown_active=true; fi
  if controller_failure_backoff_active "${now}"; then backoff_active=true; fi

  # ─── Demand and streak ──────────────────────────────────────────────────────
  if ! demand_json="$(controller_fetch_demand "${NOMAD_AGENT_NAMESPACE}")"; then
    demand_log "Demand read failed; classification is unusable this tick (floor and recovery only)."
    usable=false
  fi
  # Dead-pool backlog cannot drive growth on a cluster with no ready nodes.
  if [[ "${ready_state}" == "dead_pool" ]]; then usable=false; fi

  if [[ "${usable}" == "true" ]]; then
    if ! classified="$(demand_classify "${NOMAD_AGENT_NAMESPACE}" "${check_ready}" "${tmem}" "${tcpu}" <<< "${demand_json}")"; then
      demand_log "Demand classification failed; classification is unusable this tick."
      usable=false
    fi
  fi
  if [[ "${usable}" == "true" ]]; then
    unclassified="$(jq '[.rows[] | select(.class == "unclassified")] | length' <<< "${classified}")"
    if (( unclassified > 0 )); then
      demand_log "${unclassified} demand row(s) could not be classified; backlog and headroom are withheld this tick."
      usable=false
    fi
  fi

  streak="$(controller_streak_read)" || die "Capacity-blocked streak state is unreadable; refusing scale-out (fail closed)." 1
  if [[ "${usable}" == "true" ]]; then
    blocked_queued="$(jq '.queued_allocs_by_class.capacity_blocked // 0' <<< "${classified}")"
    status="none"
    if jq -e '[.rows[] | select(.class == "capacity_blocked")] | length > 0' <<< "${classified}" >/dev/null; then
      status="capacity_blocked"
    fi
    if [[ "${status}" == "capacity_blocked" ]]; then streak=$(( streak + 1 )); else streak=0; fi
    # The streak advances only from a usable observation. Dry-run projects it without a write.
    if ! is_dry_run; then
      controller_streak_observe "${status}" || die "Could not record the capacity-blocked streak; refusing scale-out." 1
    fi
    if (( streak >= NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS )); then mature=true; fi
    if (( blocked_queued > 0 && free_slots < slot_threshold && check_ready > 0 )); then headroom=true; fi
    items_json="$(jq -c --argjson mature "${mature}" --argjson headroom "${headroom}" \
      --argjson slots "$(( slot_threshold - free_slots ))" \
      --argjson rmem "${NOMAD_AGENT_MEMORY_RESERVATION_MB}" --argjson rcpu "${NOMAD_AGENT_CPU_RESERVATION_MHZ}" '
      [ .rows[] | select(.class == "capacity_blocked" and (.queued // 0) > 0)
        | { key: (.jobId + "/" + .taskGroup), class: "backlog", mature: $mature,
            memory_mb: .memory_mb, cpu_mhz: .cpu_mhz, count: .queued } ]
      + (if $headroom then [ { key: "headroom-slots", class: "headroom", mature: true,
            memory_mb: $rmem, cpu_mhz: $rcpu, count: $slots } ] else [] end)
    ' <<< "${classified}")" || die "Could not build demand items; refusing scale-out." 1
  fi

  # ─── Decision (plan 5.6) ────────────────────────────────────────────────────
  bins_json="$(jq -cn --argjson actual "$(jq -c '.bins' <<< "${check_json}")" \
    --argjson viable "$(jq -c '.viable_bins' <<< "${snap}")" '$actual + $viable')" \
    || die "Could not build node bins; refusing scale-out." 1
  decision_input="$(jq -cn \
    --argjson floor "${floor}" --argjson cap "${cap}" \
    --argjson increment_max "${NOMAD_SCALE_OUT_INCREMENT_MAX}" \
    --argjson managed "${managed}" --argjson active "${active}" \
    --argjson viable "${viable}" --argjson unavailable "${unavailable}" \
    --argjson tmem "${tmem}" --argjson tcpu "${tcpu}" \
    --argjson cooldown "${cooldown_active}" --argjson backoff "${backoff_active}" \
    --argjson headroom "${headroom}" --argjson usable "${usable}" \
    --argjson bins "${bins_json}" --argjson items "${items_json}" '
    { floor: $floor, cap: $cap, increment_max: $increment_max,
      pool_count: $managed, live_managed: $managed, active: $active,
      viable_inflight: $viable, unavailable: $unavailable,
      template: { memory_mb: $tmem, cpu_mhz: $tcpu },
      cooldown_active: $cooldown, failure_backoff_active: $backoff,
      headroom_pressure: $headroom, classification_usable: $usable,
      bins: $bins, items: $items }')" || die "Could not build the decision input; refusing." 1
  decision="$(controller_decide <<< "${decision_input}")" \
    || die "Controller decision failed; refusing scale-out (fail closed)." 1
  add="$(jq -r '.nodes_to_add' <<< "${decision}")"
  target="$(jq -r '.target_count' <<< "${decision}")"
  remaining="$(jq -r '.remaining_headroom' <<< "${decision}")"
  reasons="$(jq -r '.reasons | if length == 0 then "none" else join(", ") end' <<< "${decision}")"

  # --force requests one minimal addition without a threshold. It still obeys the cap, the
  # lock, the inventory gate and the plan allowlist, and never bypasses cooldown or backoff.
  if [[ "${FORCE}" == "true" && "${add}" == "0" && "${remaining}" -gt 0 ]]; then
    if [[ "${cooldown_active}" == "true" || "${backoff_active}" == "true" ]]; then
      demand_log "--force does not bypass cooldown or failure backoff; no forced addition."
    else
      add=1
      target=$(( managed + add ))
      reasons="${reasons}, forced"
    fi
  fi

  demand_log "Managed=${managed} active=${active} viable_inflight=${viable} unavailable=${unavailable} ready=${check_ready} free_slots=${free_slots}"
  demand_log "cooldown_active=${cooldown_active} failure_backoff_active=${backoff_active} classification_usable=${usable} headroom=${headroom}"
  demand_log "Decision: add=${add} target=${target} remaining_headroom=${remaining} reasons: ${reasons}"

  if [[ "${add}" == "0" ]]; then
    demand_log "No scale-out (reasoned no-op)."
    exit 0
  fi
  if [[ "${pending}" == "true" ]]; then
    demand_log "A scale-out is still in its readiness window; deferring the addition of ${add} node(s)."
    exit 0
  fi
  if is_dry_run; then
    demand_log "[DRY-RUN] Would add ${add} node(s) (target ${target}). No plan, apply or state change made."
    exit 0
  fi

  # ─── Saved plan, allowlist and apply (plan 5.7) ─────────────────────────────
  DEMAND_TMP_DIR="$(umask 077; mktemp -d)" || die "Could not create a private temp directory." 1
  plan_file="${DEMAND_TMP_DIR}/plan.tfplan"
  var_file="${TERRAFORM_DIR}/${HEROBIDS_ENV}.tfvars"
  # The four expected Terraform inputs are read BEFORE the plan and the pipeline, never inside
  # the pipeline: a die in a pipeline subshell would not stop this script (H1, plan 5.7).
  # Each value comes from the same source Terraform uses (-var-file literal, then TF_VAR_<name>).
  exp_server_name="$(controller_tf_input server_name "${var_file}")" \
    || die "server_name is not readable from ${var_file} or TF_VAR_server_name; refusing." 1
  exp_server_type="$(controller_tf_input agent_node_server_type "${var_file}")" \
    || die "agent_node_server_type is not readable from ${var_file} or TF_VAR_agent_node_server_type; refusing." 1
  exp_location="$(controller_tf_input location "${var_file}")" \
    || die "location is not readable from ${var_file} or TF_VAR_location; refusing." 1
  exp_environment="$(controller_tf_input environment "${var_file}")" \
    || die "environment is not readable from ${var_file} or TF_VAR_environment; refusing." 1
  if [[ "${exp_environment}" != "${HEROBIDS_ENV}" ]]; then
    die "Terraform environment '${exp_environment}' does not match HEROBIDS_ENV '${HEROBIDS_ENV}'; refusing." 1
  fi
  plan_args=(-input=false "-out=${plan_file}" -var "agent_node_count=${target}")
  if [[ -f "${var_file}" ]]; then
    plan_args+=("-var-file=${var_file}")
  fi

  demand_log "Planning agent_node_count ${managed} -> ${target}."
  if ! (cd "${TERRAFORM_DIR}" && terraform plan "${plan_args[@]}" >/dev/null); then
    demand_attempt_failed "Terraform plan" "scale_out_failed" "Terraform plan failed while planning ${managed} to ${target} agent nodes."
  fi
  # The plan JSON is piped straight into the allowlist and never written to disk or logged.
  if ! (cd "${TERRAFORM_DIR}" && terraform show -json "${plan_file}" 2>/dev/null) \
      | controller_plan_allowlist "${managed}" "${add}" "${cap}" \
        "${exp_server_name}" "${exp_server_type}" "${exp_location}" "${exp_environment}"; then
    demand_attempt_failed "Saved-plan allowlist check" "scale_out_plan_rejected" "Saved plan was rejected by the allowlist (only create actions on hcloud_server.agent and hcloud_server_network.agent within the cap are permitted). No apply was run."
  fi

  # Record the in-flight scale-out before the apply (H5).
  if ! capacity_inflight_begin "${NOMAD_AUTOSCALE_INFLIGHT_FILE}" "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "${target}" "${managed}" "$(date +%s)" "${NOMAD_SCALE_OUT_READY_TIMEOUT_SECONDS}"; then
    die "Could not record the in-flight scale-out; refusing to apply." 1
  fi

  demand_log "Applying the saved plan: agent_node_count ${managed} -> ${target}."
  if ! (cd "${TERRAFORM_DIR}" && terraform apply -input=false "${plan_file}" >/dev/null); then
    demand_attempt_failed "Terraform apply" "scale_out_failed" "Terraform apply of the saved plan failed while scaling from ${managed} to ${target} agent nodes."
  fi

  if ! capacity_observe_after_apply "${NOMAD_AUTOSCALE_INFLIGHT_FILE}" "${HEROBIDS_ENV}" "${NOMAD_AUTOSCALE_NODE_POOL}" "${baseline_ids}"; then
    demand_log "WARNING: could not record the new server IDs; the in-flight record stays pending until it expires."
  fi
  record_scale_success "${target}"
  clear_failure_count
  demand_log "=== Scale-out successful: ${managed} -> ${target} agent nodes (${reasons}) ==="
  exit 0
}

# ─── Pre-flight checks ────────────────────────────────────────────────────────

log "=== Nomad Autoscale-Out ==="
log "  Environment:   ${HEROBIDS_ENV:-unknown}"
log "  Nomad API:     ${NOMAD_ADDR}"
log "  Terraform dir: ${TERRAFORM_DIR}"
log "  Dry run:       ${DRY_RUN}"
log "  Force:         ${FORCE}"
log "  Bypass cooldown: ${BYPASS_COOLDOWN}"
log ""

if demand_mode_enabled; then
  demand_scale_out
fi

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
