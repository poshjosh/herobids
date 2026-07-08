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
nomad_api() {
  local method="$1"
  local path="$2"
  shift 2

  local url="${NOMAD_ADDR}${path}"
  local response
  local http_code

  response="$(curl -s -S --connect-timeout 10 --max-time 30 -w '\n%{http_code}' \
    -X "${method}" \
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
    nodes_json="$(curl -s --connect-timeout 10 --max-time 30 "${NOMAD_ADDR}/v1/nodes" 2>/dev/null || true)"
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
