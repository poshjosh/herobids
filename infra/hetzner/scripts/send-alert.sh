#!/usr/bin/env bash
# send-alert.sh — Standalone alert email sender for Herobids autoscaler.
#
# Used for testing alert delivery and as a CLI helper for operators to
# manually trigger test alerts. Sources alert-common.sh for all sending logic.
#
# Usage:
#   send-alert.sh --type <failure_type> --reason "<description>" [--dry-run]
#   send-alert.sh --test                          # Send a test alert
#   send-alert.sh --recovery                      # Send a test recovery alert
#
# Options:
#   --type <type>     Failure type slug (e.g. scale_out_failed).
#   --reason <text>   Human-readable reason for the alert.
#   --test            Send a test alert to verify email delivery.
#   --recovery        Send a test recovery alert.
#   --dry-run         Print the email body to stdout instead of sending.
#   --help            Show this help message.
#
# Environment (see alert-common.sh):
#   ALERT_SMTP_HOST, ALERT_SMTP_PORT, ALERT_FROM, ALERT_TO, HEROBIDS_ENV
#
# Exit codes:
#   0  Alert sent or dry-run completed.
#   1  Configuration or runtime error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source alert-common (which may also source scale-common if needed)
source "${SCRIPT_DIR}/alert-common.sh"

# Source scale-common for log() and other helpers if not already loaded
if ! declare -f nomad_api > /dev/null 2>&1; then
  source "${SCRIPT_DIR}/scale-common.sh"
fi

# ─── Parse arguments ──────────────────────────────────────────────────────────

FAILURE_TYPE=""
REASON=""
TEST_MODE=false
RECOVERY_MODE=false
DRY_RUN="${DRY_RUN:-false}"
SHOW_HELP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      SHOW_HELP=true
      shift
      ;;
    --type)
      FAILURE_TYPE="$2"
      shift 2
      ;;
    --reason)
      REASON="$2"
      shift 2
      ;;
    --test)
      TEST_MODE=true
      shift
      ;;
    --recovery)
      RECOVERY_MODE=true
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
Usage: $0 [--type <type> --reason <text>] [--test] [--recovery] [--dry-run]

Standalone alert sender for the Herobids autoscaler.

Options:
  --type <type>     Failure type slug (e.g. scale_out_failed).
  --reason <text>   Human-readable reason for the alert.
  --test            Send a test alert to verify email delivery.
  --recovery        Send a test recovery alert.
  --dry-run         Print the email body to stdout instead of sending.
  --help            Show this help message.

Environment:
  ALERT_SMTP_HOST   SMTP relay hostname.
  ALERT_SMTP_PORT   SMTP port (default: 587).
  ALERT_FROM        From address for alerts.
  ALERT_TO          To address (default admin).
  HEROBIDS_ENV      Environment name (staging/production).

Exit codes:
  0  Alert sent or dry-run completed.
  1  Configuration or runtime error.
EOF
  exit 0
fi

# ─── Compute action ───────────────────────────────────────────────────────────

if [[ "${DRY_RUN}" == "true" ]]; then
  log "=== Dry-Run Alert ==="

  if [[ "${RECOVERY_MODE}" == "true" ]]; then
    local env="${HEROBIDS_ENV:-unknown}"
    local node_count="unknown"
    if [[ -f "${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}" ]]; then
      node_count="$(cat "${NOMAD_AUTOSCALE_NODE_COUNT_FILE:-/var/run/nomad-autoscale-node-count}" 2>/dev/null || echo "unknown")"
    fi
    echo ""
    echo "=== Would send recovery alert ==="
    echo "Subject: [herobids-${env}] Autoscale RECOVERY: normal operation resumed"
    echo ""
    echo "Herobids Autoscale Recovery"
    echo "=========================="
    echo "Environment:    ${env}"
    echo "Timestamp:      $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "Status:         Normal operation resumed."
    echo "Node Count:     ${node_count}"
    exit 0
  fi

  if [[ "${TEST_MODE}" == "true" ]]; then
    FAILURE_TYPE="test_alert"
    REASON="Manual test alert from send-alert.sh."
  fi

  if [[ -z "${FAILURE_TYPE}" ]]; then
    die "Either --type, --test, or --recovery must be specified. Use --help for usage." 1
  fi

  echo ""
  echo "=== Would send alert ==="
  build_alert_context "${FAILURE_TYPE}" "${REASON:-manual invocation}"
  exit 0
fi

# ─── Send alert ───────────────────────────────────────────────────────────────

if [[ "${RECOVERY_MODE}" == "true" ]]; then
  log "Sending test recovery alert..."
  send_recovery_alert
  log "Done."
  exit 0
fi

if [[ "${TEST_MODE}" == "true" ]]; then
  FAILURE_TYPE="test_alert"
  REASON="Manual test alert from send-alert.sh."
fi

if [[ -z "${FAILURE_TYPE}" ]]; then
  die "Either --type, --test, or --recovery must be specified. Use --help for usage." 1
fi

log "Sending alert: type=${FAILURE_TYPE} reason=${REASON:-none}"
send_alert "${FAILURE_TYPE}" "${REASON:-manual invocation}"
log "Done."
exit 0
