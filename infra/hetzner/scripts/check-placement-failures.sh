#!/usr/bin/env bash
# check-placement-failures.sh — Safety net: detect Nomad placement failures
# caused by exhausted cluster resources and trigger emergency scale-out.
#
# Polls the Nomad evaluations API for recent blocked/failed evaluations that
# indicate resource exhaustion. When repeated failures exceed a threshold
# within a time window, triggers scale-out.sh with --bypass-cooldown --force
# to provision additional capacity immediately.
#
# Usage:
#   check-placement-failures.sh [--help] [--dry-run]
#
# Options:
#   --help      Show this help message.
#   --dry-run   Compute failure count and show what would happen without scaling.
#
# Exit codes:
#   0  No action needed, or safety-net scale-out triggered successfully.
#   1  Configuration or runtime error.
#
# Environment (see scale-common.sh for shared defaults):
#   NOMAD_ADDR                              Nomad server HTTP API base URL.
#   NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS  Time window to look back for blocked evals (default: 300).
#   NOMAD_PLACEMENT_FAILURE_THRESHOLD       Number of blocked evals in window to trigger scale-out (default: 5).
#   NOMAD_PLACEMENT_FAILURE_STATE_FILE      Path to safety-net state file (default: /var/run/nomad-placement-failure-state).
#   NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS Min seconds between safety-net triggers (default: 600).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scale-common.sh"
source "${SCRIPT_DIR}/alert-common.sh"

# ─── Safety-net defaults ──────────────────────────────────────────────────────

NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS="${NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS:-300}"
NOMAD_PLACEMENT_FAILURE_THRESHOLD="${NOMAD_PLACEMENT_FAILURE_THRESHOLD:-5}"
NOMAD_PLACEMENT_FAILURE_STATE_FILE="${NOMAD_PLACEMENT_FAILURE_STATE_FILE:-/var/run/nomad-placement-failure-state}"
NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS="${NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS:-600}"

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

Safety net: detect repeated Nomad placement failures caused by resource
exhaustion and trigger emergency scale-out via scale-out.sh.

Polls the Nomad evaluations API for blocked evaluations indicating the
cluster cannot place new workloads. When the failure count exceeds the
configured threshold within the lookback window, triggers scale-out with
--bypass-cooldown --force to immediately provision additional agent nodes.

Configuration (env vars):
  NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS  Lookback window (default: 300).
  NOMAD_PLACEMENT_FAILURE_THRESHOLD       Blocked evals to trigger (default: 5).
  NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS Min between safety-net triggers (default: 600).
  NOMAD_PLACEMENT_FAILURE_STATE_FILE      State tracking file.

Exit codes:
  0  No action needed, or safety-net triggered successfully.
  1  Runtime error.
EOF
  exit 0
fi

# ─── Pre-flight checks ────────────────────────────────────────────────────────

log "=== Nomad Placement-Failure Safety Net ==="
log "  Environment:       ${HEROBIDS_ENV:-unknown}"
log "  Nomad API:         ${NOMAD_ADDR}"
log "  Failure window:    ${NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS}s"
log "  Failure threshold: ${NOMAD_PLACEMENT_FAILURE_THRESHOLD}"
log "  Safety-net cooldown: ${NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS}s"
log "  Dry run:           ${DRY_RUN}"
log ""

# Verify scale-out.sh exists (we'll trigger it on failure detection)
SCALE_OUT_SCRIPT="${SCRIPT_DIR}/scale-out.sh"
if [[ ! -x "${SCALE_OUT_SCRIPT}" ]]; then
  die "scale-out.sh not found or not executable at ${SCALE_OUT_SCRIPT}." 1
fi

# ─── Check safety-net cooldown ────────────────────────────────────────────────

check_placement_failure_cooldown_expired() {
  if [[ ! -f "${NOMAD_PLACEMENT_FAILURE_STATE_FILE}" ]]; then
    return 0
  fi

  local last_ts
  last_ts="$(cat "${NOMAD_PLACEMENT_FAILURE_STATE_FILE}" 2>/dev/null || echo "0")"
  if [[ -z "${last_ts}" || "${last_ts}" == "0" ]]; then
    return 0
  fi

  local now
  now="$(date +%s)"
  local elapsed=$(( now - last_ts ))

  if [[ ${elapsed} -ge ${NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS} ]]; then
    return 0
  fi

  local remaining=$(( NOMAD_PLACEMENT_FAILURE_COOLDOWN_SECONDS - elapsed ))
  log "Safety-net cooldown active: ${remaining}s remaining (last trigger at ${last_ts})."
  return 1
}

touch_placement_failure_state() {
  local dir
  dir="$(dirname "${NOMAD_PLACEMENT_FAILURE_STATE_FILE}")"
  mkdir -p "${dir}"
  date +%s > "${NOMAD_PLACEMENT_FAILURE_STATE_FILE}"
  log "Safety-net state recorded."
}

# ─── Check Nomad connectivity ─────────────────────────────────────────────────

if ! nomad_api GET "/v1/status/leader" > /dev/null 2>&1; then
  die "Nomad API is unreachable at ${NOMAD_ADDR}. Is the Nomad server running?" 1
fi

# ─── Fetch evaluations ────────────────────────────────────────────────────────

log "Fetching evaluations from Nomad..."

# The evaluations API returns all evaluations. We filter client-side by time
# and status. Use a reasonably large set — Nomad keeps evals for a limited
# time (typically last 1000 or 24h depending on config).
EVALS_JSON="$(nomad_api GET "/v1/evaluations" 2>/dev/null || echo "[]")"
if [[ -z "${EVALS_JSON}" || "${EVALS_JSON}" == "[]" ]]; then
  log "No evaluations returned from Nomad API — cluster may be idle. Nothing to do."
  exit 0
fi

# ─── Filter blocked evaluations in time window ─────────────────────────────────

# Nomad evaluation creation times are in nanoseconds since epoch.
# Convert our window to nanoseconds.
WINDOW_NS=$(( NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS * 1000000000 ))

# Current time in nanoseconds (approximate — use date +%s * 1e9)
NOW_S="$(date +%s)"
NOW_NS=$(( NOW_S * 1000000000 ))
CUTOFF_NS=$(( NOW_NS - WINDOW_NS ))

# Filter evaluations:
#   1. Has a CreateTime (Nomad ≥1.6 required — CreateIndex is NOT a reliable
#      time proxy as it is a global monotonically-increasing counter, not
#      specific to evaluations).
#   2. Within the time window.
#   3. Status is "blocked" (cannot place due to resource constraints).
#   4. BlockedEval reason contains resource-related keywords.

# Detect evals missing CreateTime (pre-Nomad 1.6) and warn once.
MISSING_CREATE_TIME_COUNT="$(echo "${EVALS_JSON}" | jq -r '[.[] | select(.CreateTime == null)] | length' 2>/dev/null || echo "0")"
if [[ "${MISSING_CREATE_TIME_COUNT}" -gt 0 ]]; then
  log "WARNING: ${MISSING_CREATE_TIME_COUNT} evaluation(s) missing CreateTime field."
  log "  These evals will be excluded from the safety-net window check."
  log "  CreateTime is available in Nomad ≥1.6. Upgrade if you are on an older version."
fi

BLOCKED_EVALS="$(echo "${EVALS_JSON}" | jq -r --argjson cutoff "${CUTOFF_NS}" '
  [.[] |
   select(
     .Status == "blocked" and
     .CreateTime != null and
     .CreateTime >= $cutoff and
     (
       (.BlockedEval // "" | test("resource|exhaust|capacity|memory|cpu"; "i")) or
       (.StatusDescription // "" | test("resource|exhaust|capacity|memory|cpu"; "i"))
     )
   )]
  ' 2>/dev/null || echo "[]")"

BLOCKED_COUNT="$(echo "${BLOCKED_EVALS}" | jq -r 'length' 2>/dev/null || echo "0")"

log "  Blocked evaluations (resource-related, last ${NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS}s): ${BLOCKED_COUNT}"

# For diagnostics, log the first few blocked evals
if [[ "${BLOCKED_COUNT}" -gt 0 ]]; then
  log "  Sample blocked evaluations:"
  echo "${BLOCKED_EVALS}" | jq -r '.[:3][] | "    EvalID=\(.ID) JobID=\(.JobID) Reason=\(.BlockedEval // "unknown")"' 2>/dev/null | while IFS= read -r line; do
    log "${line}"
  done
fi

# ─── Evaluate threshold ───────────────────────────────────────────────────────

if [[ "${BLOCKED_COUNT}" -lt "${NOMAD_PLACEMENT_FAILURE_THRESHOLD}" ]]; then
  log ""
  log "Blocked evaluation count (${BLOCKED_COUNT}) below threshold (${NOMAD_PLACEMENT_FAILURE_THRESHOLD}) — no action needed."
  exit 0
fi

log ""
log "ALERT: ${BLOCKED_COUNT} resource-exhaustion placement failures detected in window (threshold: ${NOMAD_PLACEMENT_FAILURE_THRESHOLD})."

# ─── Check safety-net cooldown (prevent multi-trigger) ─────────────────────────

if ! check_placement_failure_cooldown_expired; then
  log "Safety-net cooldown active — skipping trigger. (Use force if needed.)"
  exit 0
fi

# ─── Dry-run exit ─────────────────────────────────────────────────────────────

if is_dry_run; then
  log ""
  log "[DRY-RUN] Would trigger safety-net scale-out:"
  log "[DRY-RUN]   Command: ${SCALE_OUT_SCRIPT} --bypass-cooldown --force"
  log "[DRY-RUN]   Reason:  ${BLOCKED_COUNT} blocked evals in ${NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS}s window"
  log "[DRY-RUN] No changes made."
  exit 0
fi

# ─── Trigger safety-net scale-out ─────────────────────────────────────────────

log ""
log "=== Triggering safety-net scale-out ==="
log "  Reason: ${BLOCKED_COUNT} resource-exhaustion placement failures in ${NOMAD_PLACEMENT_FAILURE_WINDOW_SECONDS}s window."
log "  Command: ${SCALE_OUT_SCRIPT} --bypass-cooldown --force"

# Record the safety-net trigger timestamp before calling scale-out so that
# even if scale-out fails, we don't immediately re-trigger.
touch_placement_failure_state

# Execute scale-out with safety-net flags. scale-out.sh handles its own
# flock, cooldown bypass, and max-node enforcement.
if "${SCALE_OUT_SCRIPT}" --bypass-cooldown --force; then
  log "Safety-net scale-out completed successfully."
  # Successful safety-net scale-out resets the failure streak
  clear_failure_count
  exit 0
else
  local scale_out_exit=$?
  log "WARNING: Safety-net scale-out exited with code ${scale_out_exit}."
  log "Placement failures may persist until additional capacity is provisioned."

  # Track failure for alerting — safety-net failure means the cluster
  # cannot self-heal from resource exhaustion.
  if alert_failure; then
    send_alert "safety_net_scale_out_failed" \
      "Safety-net scale-out (triggered by ${BLOCKED_COUNT} blocked evaluations) failed with exit code ${scale_out_exit}. The cluster may be unable to place new workloads."
  fi

  # Don't clear the state file — let the cooldown prevent spam; operator can
  # intervene manually if needed.
  exit 0
fi
