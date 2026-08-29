#!/usr/bin/env bash
# scale-common.sh — Shared functions and configuration for Herobids Nomad autoscaling.
#
# Source this file in autoscale scripts to get:
#   - Default config via env vars (with sensible defaults)
#   - log() / die() helpers
#   - nomad_api() — curl wrapper for the Nomad HTTP API
#   - tf_var() — read an autoscale variable from environment (prefers TF_VAR_<name>)
#   - check_cooldown_expired() / touch_cooldown() — cooldown file management
#   - current_agent_node_count() — current count from local state file (with Nomad API fallback)
#   - max_agent_nodes() / min_agent_nodes() — configured limits from env vars
#
# Environment variables (all optional, defaults below):
#   NOMAD_ADDR                          Nomad server HTTP API base URL (default: http://127.0.0.1:4646)
#   NOMAD_AGENT_MEMORY_RESERVATION_MB   Scheduling memory reservation per agent slot (default: 256)
#   NOMAD_SCALE_OUT_COOLDOWN_SECONDS    Minimum seconds between scale-out operations (default: 300)
#   NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT Free memory % below which we scale out (default: 20)
#   NOMAD_SCALE_OUT_SLOT_THRESHOLD      Free slots below which we scale out (default: 3)
#   NOMAD_SCALE_OUT_INCREMENT           Number of nodes to add per scale-out event (default: 1)
#   NOMAD_AUTOSCALE_LOCKFILE            Path to flock lock file (default: /var/run/nomad-autoscale.lock)
#   NOMAD_AUTOSCALE_COOLDOWN_FILE       Path to cooldown timestamp file (default: /var/run/nomad-autoscale-last-scale-out)
#   NOMAD_AUTOSCALE_LOG_FILE            Log file path (default: /var/log/nomad-autoscale.log)
#   NOMAD_AUTOSCALE_NODE_COUNT_FILE     Path to cached agent_node_count file (default: /var/run/nomad-autoscale-node-count)
#   TERRAFORM_DIR                       Path to Terraform working directory (default: /opt/herobids/infra/hetzner)
#
#   TF_VAR_max_agent_nodes              Max agent nodes (also settable as NOMAD_MAX_AGENT_NODES)
#   TF_VAR_min_agent_nodes              Min agent nodes (also settable as NOMAD_MIN_AGENT_NODES)

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────

NOMAD_ADDR="${NOMAD_ADDR:-http://127.0.0.1:4646}"
NOMAD_AGENT_MEMORY_RESERVATION_MB="${NOMAD_AGENT_MEMORY_RESERVATION_MB:-256}"
NOMAD_SCALE_OUT_COOLDOWN_SECONDS="${NOMAD_SCALE_OUT_COOLDOWN_SECONDS:-300}"
NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT="${NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT:-20}"
NOMAD_SCALE_OUT_SLOT_THRESHOLD="${NOMAD_SCALE_OUT_SLOT_THRESHOLD:-3}"
NOMAD_SCALE_OUT_INCREMENT="${NOMAD_SCALE_OUT_INCREMENT:-1}"
NOMAD_AUTOSCALE_LOCKFILE="${NOMAD_AUTOSCALE_LOCKFILE:-/var/run/nomad-autoscale.lock}"
NOMAD_AUTOSCALE_COOLDOWN_FILE="${NOMAD_AUTOSCALE_COOLDOWN_FILE:-/var/run/nomad-autoscale-last-scale-out}"
NOMAD_AUTOSCALE_LOG_FILE="${NOMAD_AUTOSCALE_LOG_FILE:-/var/log/nomad-autoscale.log}"
NOMAD_AUTOSCALE_NODE_COUNT_FILE="${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}"
TERRAFORM_DIR="${TERRAFORM_DIR:-/opt/herobids/infra/hetzner}"

# ─── Logging ──────────────────────────────────────────────────────────────────

_log_ts() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local msg="$1"
  local ts
  ts="$(_log_ts)"
  echo "[${ts}] ${msg}" | tee -a "${NOMAD_AUTOSCALE_LOG_FILE}" >&2
}

die() {
  local msg="$1"
  local code="${2:-1}"
  log "FATAL: ${msg}"
  exit "${code}"
}

# ─── Nomad API ────────────────────────────────────────────────────────────────

# nomad_api <method> <path> [<extra_curl_args>...]
# Makes an HTTP request to the Nomad API and returns the response body.
# Automatically prepends NOMAD_ADDR to the path.
# Sends the X-Nomad-Token header when NOMAD_TOKEN is set (ACL-enabled clusters).
nomad_api() {
  local method="$1"
  local path="$2"
  shift 2

  local url="${NOMAD_ADDR}${path}"
  local response
  local http_code

  # Build auth header if NOMAD_TOKEN is set
  local -a auth_args=()
  if [[ -n "${NOMAD_TOKEN:-}" ]]; then
    auth_args+=(-H "X-Nomad-Token: ${NOMAD_TOKEN}")
  fi

  response="$(curl -s -S --connect-timeout 10 --max-time 30 -w '\n%{http_code}' \
    -X "${method}" \
    ${auth_args[@]+"${auth_args[@]}"} \
    "${url}" \
    "$@" 2>&1)" || {
    log "ERROR: curl failed for ${method} ${url}: ${response}"
    return 1
  }

  # Extract HTTP status code (last line)
  http_code="$(echo "${response}" | tail -n1)"
  # Extract body (all but last line)
  local body
  body="$(echo "${response}" | sed '$d')"

  if [[ "${http_code}" -lt 200 || "${http_code}" -ge 300 ]]; then
    log "ERROR: Nomad API returned HTTP ${http_code} for ${method} ${url}"
    log "Response: ${body}"
    return 1
  fi

  echo "${body}"
}

# ─── Configuration helpers ────────────────────────────────────────────────────

# tf_var <var_name> — read an autoscale variable from environment.
#
# Lookup order:
#   1. TF_VAR_<var_name> (set by systemd Environment= directives, read automatically by terraform)
#   2. NOMAD_<UPPER_SNAKE_CASE> (legacy naming, e.g. NOMAD_MAX_AGENT_NODES)
#
# This avoids depending on 'terraform output' at runtime.
# The scripts read the same env vars that terraform picks up via TF_VAR_*.
tf_var() {
  local var_name="$1"

  # Convert to uppercase for NOMAD_* lookup
  local upper_name
  upper_name="$(echo "${var_name}" | tr '[:lower:]' '[:upper:]')"

  # 1. Try TF_VAR_<var_name>
  local tf_var_name="TF_VAR_${var_name}"
  if [[ -n "${!tf_var_name:-}" ]]; then
    echo "${!tf_var_name}"
    return 0
  fi

  # 2. Try NOMAD_<UPPER_NAME>
  local nomad_var_name="NOMAD_${upper_name}"
  if [[ -n "${!nomad_var_name:-}" ]]; then
    echo "${!nomad_var_name}"
    return 0
  fi

  die "Cannot read variable '${var_name}': neither ${tf_var_name} nor ${nomad_var_name} is set."
}

# current_agent_node_count — returns the current agent_node_count.
#
# Reads from NOMAD_AUTOSCALE_NODE_COUNT_FILE (updated after each successful
# terraform apply). Falls back to counting Nomad client nodes via the API.
current_agent_node_count() {
  # 1. Try the local state file (fastest, no network)
  if [[ -f "${NOMAD_AUTOSCALE_NODE_COUNT_FILE}" ]]; then
    local cached
    cached="$(cat "${NOMAD_AUTOSCALE_NODE_COUNT_FILE}" 2>/dev/null || true)"
    if [[ -n "${cached}" && "${cached}" =~ ^[0-9]+$ ]]; then
      echo "${cached}"
      return 0
    fi
  fi

  # 2. Fall back: count Nomad client nodes (may include initializing nodes)
  if command -v curl &>/dev/null; then
    local nodes_json
    local -a curl_auth=()
    if [[ -n "${NOMAD_TOKEN:-}" ]]; then
      curl_auth+=(-H "X-Nomad-Token: ${NOMAD_TOKEN}")
    fi
    nodes_json="$(curl -s --connect-timeout 10 --max-time 30 ${curl_auth[@]+"${curl_auth[@]}"} "${NOMAD_ADDR}/v1/nodes" 2>/dev/null || true)"
    if [[ -n "${nodes_json}" ]]; then
      local node_count
      node_count="$(echo "${nodes_json}" | jq -r '[.[] | select(.Status != "down")] | length' 2>/dev/null || true)"
      if [[ -n "${node_count}" && "${node_count}" =~ ^[0-9]+$ ]]; then
        log "WARNING: Using Nomad API fallback for agent_node_count (${node_count} nodes). State file missing at ${NOMAD_AUTOSCALE_NODE_COUNT_FILE}."
        echo "${node_count}"
        return 0
      fi
    fi
  fi

  die "Cannot determine current agent_node_count: state file ${NOMAD_AUTOSCALE_NODE_COUNT_FILE} not found and Nomad API unreachable."
}

# write_node_count <count> — persist the agent_node_count after a successful scale operation.
write_node_count() {
  local count="$1"
  local dir
  dir="$(dirname "${NOMAD_AUTOSCALE_NODE_COUNT_FILE}")"
  mkdir -p "${dir}"
  echo "${count}" > "${NOMAD_AUTOSCALE_NODE_COUNT_FILE}"
  log "Node count written: ${count}"
}

# max_agent_nodes — returns the configured max_agent_nodes from env vars.
max_agent_nodes() {
  tf_var "max_agent_nodes"
}

# min_agent_nodes — returns the configured min_agent_nodes from env vars.
min_agent_nodes() {
  tf_var "min_agent_nodes"
}

# ─── Cooldown management ──────────────────────────────────────────────────────

# check_cooldown_expired — returns 0 (true) if cooldown has expired, 1 (false) otherwise.
check_cooldown_expired() {
  local cooldown_seconds="${1:-${NOMAD_SCALE_OUT_COOLDOWN_SECONDS}}"

  if [[ ! -f "${NOMAD_AUTOSCALE_COOLDOWN_FILE}" ]]; then
    # No previous scale-out recorded — cooldown expired
    return 0
  fi

  local last_ts
  last_ts="$(cat "${NOMAD_AUTOSCALE_COOLDOWN_FILE}" 2>/dev/null || echo "0")"
  if [[ -z "${last_ts}" || "${last_ts}" == "0" ]]; then
    return 0
  fi

  local now
  now="$(date +%s)"

  local elapsed=$(( now - last_ts ))
  if [[ ${elapsed} -ge ${cooldown_seconds} ]]; then
    return 0
  fi

  local remaining=$(( cooldown_seconds - elapsed ))
  log "Cooldown active: ${remaining}s remaining (last scale-out at $(date -d "@${last_ts}" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -r "${last_ts}" -u +"%Y-%m-%dT%H:%M:%SZ"))"
  return 1
}

# touch_cooldown — record a scale-out event timestamp.
touch_cooldown() {
  local dir
  dir="$(dirname "${NOMAD_AUTOSCALE_COOLDOWN_FILE}")"
  mkdir -p "${dir}"
  date +%s > "${NOMAD_AUTOSCALE_COOLDOWN_FILE}"
  log "Cooldown timestamp recorded: $(cat "${NOMAD_AUTOSCALE_COOLDOWN_FILE}")"
}

# ─── Lock helpers ─────────────────────────────────────────────────────────────

# acquire_lock <lockfile> [<timeout_seconds>] — acquire an exclusive flock.
# Returns 0 on success, exits with error on timeout.
# The lock fd is stored in NOMAD_AUTOSCALE_LOCK_FD and must be released by the caller.
acquire_lock() {
  local lockfile="${1:-${NOMAD_AUTOSCALE_LOCKFILE}}"
  local timeout="${2:-0}"  # 0 = non-blocking

  local lock_dir
  lock_dir="$(dirname "${lockfile}")"
  mkdir -p "${lock_dir}"

  # Open a new fd for the lock
  exec {NOMAD_AUTOSCALE_LOCK_FD}>"${lockfile}"

  if [[ "${timeout}" -gt 0 ]]; then
    if ! flock -w "${timeout}" "${NOMAD_AUTOSCALE_LOCK_FD}" 2>/dev/null; then
      log "ERROR: Could not acquire lock ${lockfile} within ${timeout}s timeout."
      exec {NOMAD_AUTOSCALE_LOCK_FD}>&-
      return 1
    fi
  else
    if ! flock -n "${NOMAD_AUTOSCALE_LOCK_FD}" 2>/dev/null; then
      log "Lock ${lockfile} is held by another process — skipping."
      exec {NOMAD_AUTOSCALE_LOCK_FD}>&-
      return 1
    fi
  fi

  log "Lock acquired: ${lockfile}"
  return 0
}

# release_lock — release the flock held on NOMAD_AUTOSCALE_LOCK_FD.
release_lock() {
  if [[ -n "${NOMAD_AUTOSCALE_LOCK_FD:-}" ]]; then
    flock -u "${NOMAD_AUTOSCALE_LOCK_FD}" 2>/dev/null || true
    exec {NOMAD_AUTOSCALE_LOCK_FD}>&- 2>/dev/null || true
    log "Lock released."
  fi
}

# ─── Dry-run helpers ──────────────────────────────────────────────────────────

DRY_RUN="${DRY_RUN:-false}"

dry_run_log() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY-RUN] $*"
  fi
}

is_dry_run() {
  [[ "${DRY_RUN}" == "true" ]]
}

# ─── Terraform Runtime Helpers ────────────────────────────────────────────────
#
# Shared helpers for autoscale-time Terraform operations. These centralize
# environment validation, backend initialization, and workspace selection
# so that scale-in.sh, scale-out.sh, and alert-common.sh are thin consumers.

# tf_ensure_env — fail fast if HEROBIDS_ENV is not set to staging or production.
tf_ensure_env() {
  case "${HEROBIDS_ENV:-}" in
    staging|production) ;;
    *)
      die "HEROBIDS_ENV must be 'staging' or 'production' (got '${HEROBIDS_ENV:-<unset>}'). Cannot determine target environment for Terraform." 1
      ;;
  esac
}

# tf_backend_configured — returns 0 if the S3 backend env vars are set.
tf_backend_configured() {
  local missing=()
  [[ -z "${TF_BACKEND_BUCKET:-}" ]] && missing+=("TF_BACKEND_BUCKET")
  [[ -z "${TF_BACKEND_REGION:-}" ]] && missing+=("TF_BACKEND_REGION")
  [[ -z "${AWS_ACCESS_KEY_ID:-}" ]] && missing+=("AWS_ACCESS_KEY_ID")
  [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]] && missing+=("AWS_SECRET_ACCESS_KEY")

  if [[ ${#missing[@]} -gt 0 ]]; then
    log "ERROR: Missing backend environment variables: ${missing[*]}"
    return 1
  fi
  return 0
}

# tf_init_backend — run terraform init with S3 backend configuration.
# Must be called before any terraform plan/apply in autoscale scripts.
#
# Uses -reconfigure to avoid interactive prompts. This is correct for the
# autoscale use case: systemd services always target the same backend, and
# -reconfigure ensures stale local .terraform state doesn't cause drift.
# Operators should NOT use this function for manual Terraform sessions —
# use provision.sh instead, which handles backend init separately.
#
# Uses HEROBIDS_ENV to derive the state key.
tf_init_backend() {
  tf_ensure_env

  if ! tf_backend_configured; then
    die "S3 backend not configured. Set TF_BACKEND_BUCKET, TF_BACKEND_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY." 1
  fi

  local state_key="herobids/${HEROBIDS_ENV}/terraform.tfstate"
  local -a init_args=(-input=false -reconfigure
    "-backend-config=bucket=${TF_BACKEND_BUCKET}"
    "-backend-config=key=${state_key}"
    "-backend-config=region=${TF_BACKEND_REGION}"
  )

  if [[ -n "${TF_BACKEND_DYNAMODB_TABLE:-}" ]]; then
    init_args+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
  fi

  log "Initializing Terraform backend (bucket=${TF_BACKEND_BUCKET}, key=${state_key}, region=${TF_BACKEND_REGION})..."

  cd "${TERRAFORM_DIR}"

  if ! terraform init "${init_args[@]}"; then
    die "Terraform backend initialization failed. Check AWS credentials and bucket configuration." 1
  fi

  log "Terraform backend initialized (env=${HEROBIDS_ENV})."
}

# tf_select_workspace — select or create the Terraform workspace matching HEROBIDS_ENV.
tf_select_workspace() {
  tf_ensure_env

  cd "${TERRAFORM_DIR}"

  local current_ws
  current_ws="$(terraform workspace show 2>/dev/null || echo "default")"

  if [[ "${current_ws}" == "${HEROBIDS_ENV}" ]]; then
    log "Terraform workspace already set to '${HEROBIDS_ENV}'."
    return 0
  fi

  log "Selecting Terraform workspace '${HEROBIDS_ENV}' (currently: '${current_ws}')..."

  if ! terraform workspace select "${HEROBIDS_ENV}" 2>/dev/null; then
    if ! terraform workspace new "${HEROBIDS_ENV}"; then
      die "Failed to select or create Terraform workspace '${HEROBIDS_ENV}'." 1
    fi
  fi

  log "Terraform workspace set to '${HEROBIDS_ENV}'."
}

# tf_ensure_ready — full pre-flight check for autoscale Terraform operations.
# Validates: env set, terraform binary, terraform dir, backend configured, init + workspace.
tf_ensure_ready() {
  tf_ensure_env

  if ! command -v terraform &>/dev/null; then
    die "terraform not found in PATH." 1
  fi

  if [[ ! -d "${TERRAFORM_DIR}" ]]; then
    die "TERRAFORM_DIR '${TERRAFORM_DIR}' does not exist." 1
  fi

  tf_init_backend
  tf_select_workspace

  log "Terraform ready (env=${HEROBIDS_ENV}, dir=${TERRAFORM_DIR})."
}

# tf_apply_var — execute a terraform apply with the given -var overrides.
# Usage: tf_apply_var "agent_node_count=5"
# Uses the environment-specific tfvars file (e.g., staging.tfvars) if it
# exists in TERRAFORM_DIR, providing required Terraform input variables
# (hcloud_token, deploy_ssh_private_key, etc.). Dynamic overrides are
# passed as -var arguments.
#
# NOTE: Do not pass sensitive values (secrets, API keys, passwords) as -var
# arguments — they appear in process listings and terraform logs. Use TF_VAR_*
# environment variables for sensitive inputs instead.
tf_apply_var() {
  cd "${TERRAFORM_DIR}"

  local -a apply_args=(-auto-approve)

  # Use environment-specific tfvars file if available.
  # This provides required Terraform variables (hcloud_token, deploy_ssh_private_key, etc.)
  # that are not set via TF_VAR_* env vars in the systemd service units.
  local tfvars_file="${TERRAFORM_DIR}/${HEROBIDS_ENV}.tfvars"
  if [[ -f "${tfvars_file}" ]]; then
    apply_args+=("-var-file=${tfvars_file}")
    log "Using var-file: ${tfvars_file}"
  fi

  for var_pair in "$@"; do
    apply_args+=("-var" "${var_pair}")
  done

  log "Terraform apply: terraform apply ${apply_args[*]}"
  terraform apply "${apply_args[@]}"
}

# ─── Nomad node helpers (Phase 7) ─────────────────────────────────────────────
#
# These helpers are used by both check-placement-failures.sh (safety net) and
# scale-in.sh (nightly drain). They provide a shared source of truth for node
# inventory and drain operations, consistent with check-nomad-capacity.sh.

# NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS — max time to wait for drain to complete
NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS="${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS:-600}"

# list_eligible_agent_nodes — returns newline-separated Nomad node IDs for all
# ready, eligible agent nodes (excluding the Nomad server if it runs a client).
# Filters by NodeClass == "agent" so the control-plane client node (which has no
# node_class or a different class) is never a scale-in candidate.
list_eligible_agent_nodes() {
  local nodes_json
  nodes_json="$(nomad_api GET "/v1/nodes" || true)"
  if [[ -z "${nodes_json}" ]]; then
    log "ERROR: Could not fetch node list from Nomad."
    return 1
  fi

  echo "${nodes_json}" | jq -r '.[] | select(.Status == "ready" and .SchedulingEligibility == "eligible" and .NodeClass == "agent") | .ID'
}

# node_is_idle <node_id> — returns 0 if the node has zero non-terminal
# allocations (running or pending), 1 otherwise.
node_is_idle() {
  local node_id="$1"

  local allocs_json
  allocs_json="$(nomad_api GET "/v1/node/${node_id}/allocations" || echo "[]")"

  local running_count
  running_count="$(echo "${allocs_json}" | jq -r '[.[] | select(.ClientStatus == "running" or .ClientStatus == "pending")] | length' 2>/dev/null || echo "0")"

  [[ "${running_count}" -eq 0 ]]
}

# node_running_alloc_count <node_id> — returns the count of non-terminal
# allocations (running or pending) on the given node.
node_running_alloc_count() {
  local node_id="$1"

  local allocs_json
  allocs_json="$(nomad_api GET "/v1/node/${node_id}/allocations" || echo "[]")"

  echo "${allocs_json}" | jq -r '[.[] | select(.ClientStatus == "running" or .ClientStatus == "pending")] | length' 2>/dev/null || echo "0"
}

# mark_node_ineligible <node_id> — set a node's scheduling eligibility to
# "ineligible", preventing new placements on it.
mark_node_ineligible() {
  local node_id="$1"

  if is_dry_run; then
    log "[DRY-RUN] Would mark node ${node_id} ineligible."
    return 0
  fi

  # Nomad expects a JSON body with the Eligibility field.
  # POST /v1/node/{nodeId}/eligibility
  nomad_api POST "/v1/node/${node_id}/eligibility" \
    -H "Content-Type: application/json" \
    -d '{"Eligibility": "ineligible"}' > /dev/null || {
    log "ERROR: Failed to mark node ${node_id} ineligible."
    return 1
  }
  log "Node ${node_id} marked ineligible."
}

# drain_node <node_id> [<deadline_seconds>] — initiate a drain on the given node.
# The drain deadline defaults to NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS.
# A drain tells Nomad to migrate or stop all allocations on the node within the
# deadline. Returns 0 if drain was initiated, 1 on error.
drain_node() {
  local node_id="$1"
  local deadline="${2:-${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}}"

  if is_dry_run; then
    log "[DRY-RUN] Would drain node ${node_id} with deadline ${deadline}s."
    return 0
  fi

  # Convert seconds to nanoseconds (Nomad API uses nanoseconds)
  local deadline_ns=$(( deadline * 1000000000 ))

  # POST /v1/node/{nodeId}/drain
  local body
  body="{\"DrainSpec\": {\"Deadline\": ${deadline_ns}, \"IgnoreSystemJobs\": true}}"
  nomad_api POST "/v1/node/${node_id}/drain" \
    -H "Content-Type: application/json" \
    -d "${body}" > /dev/null || {
    log "ERROR: Failed to initiate drain for node ${node_id}."
    return 1
  }
  log "Drain initiated on node ${node_id} (deadline: ${deadline}s)."
}

# wait_for_drain_complete <node_id> <timeout_seconds> [<poll_interval_seconds>]
# Wait for a draining node to have zero running allocations.
# Returns 0 when the node is fully drained, 1 on timeout.
wait_for_drain_complete() {
  local node_id="$1"
  local timeout_seconds="${2:-${NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS}}"
  local poll_interval="${3:-15}"

  local elapsed=0
  log "Waiting for node ${node_id} to drain (timeout: ${timeout_seconds}s, poll: ${poll_interval}s)..."

  while [[ ${elapsed} -lt ${timeout_seconds} ]]; do
    local running
    running="$(node_running_alloc_count "${node_id}")" || running=0

    if [[ "${running}" -eq 0 ]]; then
      log "Node ${node_id} fully drained after ${elapsed}s."
      return 0
    fi

    log "  Node ${node_id}: ${running} running allocation(s) remaining (${elapsed}s elapsed)..."
    sleep "${poll_interval}"
    elapsed=$(( elapsed + poll_interval ))
  done

  log "WARNING: Node ${node_id} did not drain within ${timeout_seconds}s. Node will be excluded from the destroy set."
  return 1
}

# is_node_draining <node_id> — returns 0 if the node is currently in drain mode.
is_node_draining() {
  local node_id="$1"

  local node_json
  node_json="$(nomad_api GET "/v1/node/${node_id}" || true)"
  if [[ -z "${node_json}" ]]; then
    return 1
  fi

  local drain
  drain="$(echo "${node_json}" | jq -r '.Drain // false' 2>/dev/null || echo "false")"
  [[ "${drain}" == "true" ]]
}

# node_name <node_id> — returns the node's human-readable name (e.g. "herobids-agent-3").
# Returns empty string on error.
node_name() {
  local node_id="$1"

  local node_json
  node_json="$(nomad_api GET "/v1/node/${node_id}" || true)"
  if [[ -z "${node_json}" ]]; then
    return 1
  fi

  echo "${node_json}" | jq -r '.Name // ""' 2>/dev/null || echo ""
}

# mark_node_eligible <node_id> — undo mark_node_ineligible, restoring the node
# so it can receive new placements again.
mark_node_eligible() {
  local node_id="$1"

  if is_dry_run; then
    log "[DRY-RUN] Would mark node ${node_id} eligible."
    return 0
  fi

  nomad_api POST "/v1/node/${node_id}/eligibility" \
    -H "Content-Type: application/json" \
    -d '{"Eligibility": "eligible"}' > /dev/null || {
    log "ERROR: Failed to re-mark node ${node_id} as eligible."
    return 1
  }
  log "Node ${node_id} re-marked eligible (terraform apply failed)."
}
