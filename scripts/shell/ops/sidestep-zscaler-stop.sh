#!/usr/bin/env bash
# sidestep-zscaler-stop.sh — Tear down the SSH tunnel and dedicated browser profile.
#
# Usage:
#   scripts/shell/ops/sidestep-zscaler-stop.sh
#   scripts/shell/ops/sidestep-zscaler-stop.sh --help

set -euo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/herobids/sidestep-zscaler"
STATE_FILE="$STATE_DIR/state.env"
LOG_FILE="$STATE_DIR/tunnel.log"
KNOWN_HOSTS_FILE="$STATE_DIR/known_hosts"

log_info() { echo "[INFO]  $*"; }
log_warn() { echo "[WARN]  $*" >&2; }
log_error() { echo "[ERROR] $*" >&2; }
die() {
  log_error "$*"
  exit 1
}

usage() {
  awk '/^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
}

# Verify a PID is still an ssh process forwarding the recorded local port/target,
# guarding against a since-recycled PID matching by coincidence.
is_expected_tunnel() {
  local pid="$1"
  local command
  command="$(ps -p "$pid" -ww -o command= 2>/dev/null | tr -d '\n')"
  [[ -n "$command" ]] || return 1
  [[ "$command" == *"ssh"* ]] || return 1
  if [[ -n "${SIDESTEP_LOCAL_PORT:-}" && -n "${SIDESTEP_REMOTE_HOST:-}" && -n "${SIDESTEP_REMOTE_PORT:-}" ]]; then
    [[ "$command" == *"-L 127.0.0.1:${SIDESTEP_LOCAL_PORT}:${SIDESTEP_REMOTE_HOST}:${SIDESTEP_REMOTE_PORT}"* ]] || return 1
  fi
  if [[ -n "${SIDESTEP_SSH_TARGET:-}" ]]; then
    [[ "$command" == *"${SIDESTEP_SSH_TARGET}"* ]] || return 1
  fi
  return 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

mkdir -p "$STATE_DIR"

require_cmd ps

load_state

PID="${SIDESTEP_TUNNEL_PID:-}"
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  if is_expected_tunnel "$PID"; then
    log_info "Stopping tunnel (PID ${PID}) ..."
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
  else
    log_warn "PID ${PID} is recorded but no longer looks like the tunnel."
  fi
else
  log_warn "No running tunnel found in state file."
fi

if [[ -n "${SIDESTEP_PROFILE_DIR:-}" ]]; then
  if command -v pkill >/dev/null 2>&1; then
    log_info "Closing browser profile ${SIDESTEP_PROFILE_DIR} ..."
    pkill -f "user-data-dir=${SIDESTEP_PROFILE_DIR}" 2>/dev/null || true
  fi
fi

rm -f "$STATE_FILE" "$LOG_FILE" "$KNOWN_HOSTS_FILE"
rmdir "$STATE_DIR" 2>/dev/null || true

log_info "Tunnel stopped. Browser profile left on disk at the path above (not deleted) so cookies/session persist for next time."