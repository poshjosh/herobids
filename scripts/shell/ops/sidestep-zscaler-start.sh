#!/usr/bin/env bash
# sidestep-zscaler-start.sh — Start a local SSH tunnel and open openaidom.com without sudo.
#
# Does NOT touch /etc/hosts and never requires sudo. The SSH tunnel forwards an
# unprivileged local port (default 8443) to the server's 127.0.0.1:443. A dedicated
# Chrome/Edge profile is launched with --host-resolver-rules so it silently maps
# openaidom.com:443 to the local tunnel — the address bar shows a clean
# https://openaidom.com with no port and no cert warning.
#
# The correct deploy key is auto-detected from --ssh-target (167.233.213.107 ->
# ~/.ssh/herobids_deploy_key_prod, 128.140.55.192 -> ~/.ssh/herobids_deploy_key).
# Override with --identity for any other host.
#
# Usage:
#   scripts/shell/ops/sidestep-zscaler-start.sh
#   scripts/shell/ops/sidestep-zscaler-start.sh --domain staging.openaidom.com --ssh-target root@128.140.55.192
#   scripts/shell/ops/sidestep-zscaler-start.sh --ssh-target root@1.2.3.4 --identity ~/.ssh/some_key
#   scripts/shell/ops/sidestep-zscaler-start.sh --browser edge
#   scripts/shell/ops/sidestep-zscaler-start.sh --no-browser
#   scripts/shell/ops/sidestep-zscaler-start.sh --help
#
# After usage, tear down the tunnel and browser profile with:
#   scripts/shell/ops/sidestep-zscaler-stop.sh

set -euo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/herobids/sidestep-zscaler"
STATE_FILE="$STATE_DIR/state.env"
LOG_FILE="$STATE_DIR/tunnel.log"
KNOWN_HOSTS_FILE="$STATE_DIR/known_hosts"

DEFAULT_DOMAIN="openaidom.com"
DEFAULT_SSH_TARGET="root@167.233.213.107"
DEFAULT_LOCAL_PORT="8443"
DEFAULT_BROWSER="chrome"
REMOTE_HOST="127.0.0.1"
REMOTE_PORT="443"

DOMAIN="$DEFAULT_DOMAIN"
SSH_TARGET="$DEFAULT_SSH_TARGET"
LOCAL_PORT="$DEFAULT_LOCAL_PORT"
BROWSER="$DEFAULT_BROWSER"
OPEN_BROWSER=1
IDENTITY_FILE=""

# Known Hetzner hosts each use a different deploy key (see infra/hetzner/*.tfvars).
default_identity_for_target() {
  case "$1" in
    *167.233.213.107) printf '%s' "$HOME/.ssh/herobids_deploy_key_prod" ;;
    *128.140.55.192)  printf '%s' "$HOME/.ssh/herobids_deploy_key" ;;
    *) printf '' ;;
  esac
}

TUNNEL_PID=""
TUNNEL_STARTED=0
PROFILE_DIR=""

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

# Path to the browser executable inside its .app bundle (macOS).
browser_binary_path() {
  case "$1" in
    chrome)
      printf '%s' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ;;
    edge)
      printf '%s' "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      ;;
    *)
      die "Unknown --browser '$1' (expected 'chrome' or 'edge')"
      ;;
  esac
}

state_to_file() {
  cat > "$STATE_FILE" <<STATE_EOF
SIDESTEP_TUNNEL_PID=$(printf '%q' "$TUNNEL_PID")
SIDESTEP_DOMAIN=$(printf '%q' "$DOMAIN")
SIDESTEP_SSH_TARGET=$(printf '%q' "$SSH_TARGET")
SIDESTEP_LOCAL_PORT=$(printf '%q' "$LOCAL_PORT")
SIDESTEP_REMOTE_HOST=$(printf '%q' "$REMOTE_HOST")
SIDESTEP_REMOTE_PORT=$(printf '%q' "$REMOTE_PORT")
SIDESTEP_PROFILE_DIR=$(printf '%q' "$PROFILE_DIR")
STATE_EOF
}

load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
}

# Verify a PID is still an ssh process forwarding the given local port/target,
# guarding against a since-recycled PID matching by coincidence.
tunnel_command_matches() {
  local pid="$1" ssh_target="$2" local_port="$3" remote_host="$4" remote_port="$5"
  local command
  command="$(ps -p "$pid" -ww -o command= 2>/dev/null | tr -d '\n')"
  [[ -n "$command" ]] || return 1
  [[ -n "$ssh_target" && -n "$local_port" && -n "$remote_host" && -n "$remote_port" ]] || return 1
  [[ "$command" == *"ssh"* ]] || return 1
  [[ "$command" == *"-L 127.0.0.1:${local_port}:${remote_host}:${remote_port}"* ]] || return 1
  [[ "$command" == *"${ssh_target}"* ]] || return 1
}

current_request_satisfied_by() {
  local pid="$1"
  tunnel_command_matches "$pid" "$SSH_TARGET" "$LOCAL_PORT" "$REMOTE_HOST" "$REMOTE_PORT"
}

stop_existing_tunnel() {
  local pid="${SIDESTEP_TUNNEL_PID:-}"

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    if tunnel_command_matches "$pid" "${SIDESTEP_SSH_TARGET:-}" "${SIDESTEP_LOCAL_PORT:-}" "${SIDESTEP_REMOTE_HOST:-}" "${SIDESTEP_REMOTE_PORT:-}"; then
      log_info "Stopping existing tunnel (PID ${pid}) before starting the new one ..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    else
      log_warn "State file exists, but PID ${pid} does not look like this tunnel. Removing stale state."
    fi
  fi

  rm -f "$STATE_FILE" "$KNOWN_HOSTS_FILE"
}

cleanup_on_error() {
  local exit_code=$?
  if [[ "$exit_code" -eq 0 ]]; then
    return 0
  fi

  if [[ "$TUNNEL_STARTED" -eq 1 && -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$TUNNEL_PID" 2>/dev/null; then
      kill -9 "$TUNNEL_PID" 2>/dev/null || true
    fi
  fi

  rm -f "$STATE_FILE"
}
trap cleanup_on_error EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-port)
      [[ -z "${2:-}" ]] && die "--local-port requires a port number"
      LOCAL_PORT="$2"
      shift 2
      ;;
    --ssh-target)
      [[ -z "${2:-}" ]] && die "--ssh-target requires a user@host target"
      SSH_TARGET="$2"
      shift 2
      ;;
    --domain)
      [[ -z "${2:-}" ]] && die "--domain requires a hostname"
      DOMAIN="$2"
      shift 2
      ;;
    --browser)
      [[ -z "${2:-}" ]] && die "--browser requires 'chrome' or 'edge'"
      BROWSER="$2"
      shift 2
      ;;
    --identity)
      [[ -z "${2:-}" ]] && die "--identity requires a private key file path"
      IDENTITY_FILE="$2"
      shift 2
      ;;
    --no-browser)
      OPEN_BROWSER=0
      shift
      ;;
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

require_cmd ssh
require_cmd ps
require_cmd lsof

if [[ ! "$LOCAL_PORT" =~ ^[0-9]+$ ]] || (( LOCAL_PORT < 1 || LOCAL_PORT > 65535 )); then
  die "--local-port must be a TCP port number between 1 and 65535"
fi

if [[ -z "$IDENTITY_FILE" ]]; then
  IDENTITY_FILE="$(default_identity_for_target "$SSH_TARGET")"
fi
if [[ -n "$IDENTITY_FILE" ]]; then
  [[ -f "$IDENTITY_FILE" ]] || die "SSH identity file not found: $IDENTITY_FILE"
fi

SANITIZED_DOMAIN="${DOMAIN//[^a-zA-Z0-9._-]/_}"
PROFILE_DIR="$STATE_DIR/${BROWSER}-profile-${SANITIZED_DOMAIN}"

BROWSER_BIN=""
if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  BROWSER_BIN="$(browser_binary_path "$BROWSER")"
  [[ -x "$BROWSER_BIN" ]] || die "Browser executable not found: $BROWSER_BIN (install it, pick --browser edge, or pass --no-browser)"
fi

load_state

if [[ -n "${SIDESTEP_TUNNEL_PID:-}" ]] && kill -0 "$SIDESTEP_TUNNEL_PID" 2>/dev/null && current_request_satisfied_by "$SIDESTEP_TUNNEL_PID"; then
  log_info "A matching tunnel is already running (PID ${SIDESTEP_TUNNEL_PID})."
  TUNNEL_PID="$SIDESTEP_TUNNEL_PID"
else
  if [[ -n "${SIDESTEP_TUNNEL_PID:-}" ]] && kill -0 "$SIDESTEP_TUNNEL_PID" 2>/dev/null; then
    stop_existing_tunnel
  fi

  if lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Local port ${LOCAL_PORT} is already in use"
  fi

  : > "$LOG_FILE"
  log_info "Starting SSH tunnel to ${SSH_TARGET} ..."

  SSH_CMD=(ssh
    -N
    -T
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=3
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
    -L "127.0.0.1:${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}"
    "$SSH_TARGET"
  )
  if [[ -n "$IDENTITY_FILE" ]]; then
    SSH_CMD+=(-i "$IDENTITY_FILE" -o IdentitiesOnly=yes)
    log_info "Using identity: ${IDENTITY_FILE}"
  fi

  nohup "${SSH_CMD[@]}" >> "$LOG_FILE" 2>&1 &
  TUNNEL_PID=$!
  TUNNEL_STARTED=1
  state_to_file

  sleep 1
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    log_error "SSH tunnel exited immediately."
    if [[ -s "$LOG_FILE" ]]; then
      tail -n 20 "$LOG_FILE" >&2 || true
    fi
    exit 1
  fi

  log_info "Tunnel started (PID ${TUNNEL_PID})."
fi

state_to_file

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  mkdir -p "$PROFILE_DIR"
  log_info "Launching ${BROWSER} with a dedicated profile (no sudo, no /etc/hosts changes) ..."
  "$BROWSER_BIN" \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --host-resolver-rules="MAP ${DOMAIN}:443 127.0.0.1:${LOCAL_PORT}" \
    "https://${DOMAIN}" \
    >/dev/null 2>&1 &
  disown
else
  log_info "Skipping browser launch (--no-browser). To open manually:"
  log_info "  \"$(browser_binary_path "$BROWSER")\" --user-data-dir=\"$PROFILE_DIR\" --host-resolver-rules=\"MAP ${DOMAIN}:443 127.0.0.1:${LOCAL_PORT}\" \"https://${DOMAIN}\""
fi

log_info "Stop everything with scripts/shell/ops/sidestep-zscaler-stop.sh"