#!/usr/bin/env bash
# check-node-type-switch.sh — email reminder when the agent pool is big enough to switch
# node type cx23 -> cx53 (Hetzner scale-path plan §7). Read-only; sends one rate-limited
# email when the pool reaches NODE_SWITCH_THRESHOLD nodes OR AGENT_SWITCH_THRESHOLD active
# agents, whichever first. Intended to run on a timer on the control plane.
#
# Why: on cx23 (~14 agents/node) the pool approaches the 100-server private-network ceiling
# around ~90 nodes. The trigger (default 60 nodes / 750 agents) fires early enough to switch
# to cx53 calmly (see infra/hetzner/docs/runbooks/switch-node-type.md).
#
# It reuses alert-common.sh's SMTP senders but keeps its OWN rate-limit stamp so it never
# collides with the autoscaler's failure alerts. It only fires while the current type is the
# small one (CURRENT_SMALL_TYPE, default cx23); once switched it goes quiet.
#
# Usage: check-node-type-switch.sh [--dry-run] [--help]
#
# Env:
#   NODE_SWITCH_THRESHOLD        node count that triggers the reminder (default 60).
#   AGENT_SWITCH_THRESHOLD       active-agent count that triggers it (default 750).
#   CURRENT_SMALL_TYPE           only alert while agent_node_server_type is this (default cx23).
#   NODE_SWITCH_ALERT_FILE       rate-limit stamp (default /var/run/nomad-node-switch-last-alert).
#   NODE_SWITCH_RATE_LIMIT_SECONDS  min seconds between reminders (default 86400 = daily).
#   NOMAD_ADDR, NOMAD_TOKEN, ALERT_* (SMTP), HEROBIDS_ENV, TERRAFORM_DIR  as for the autoscaler.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

source "${SCRIPT_DIR}/scale-common.sh"
source "${SCRIPT_DIR}/alert-common.sh"

NODE_SWITCH_THRESHOLD="${NODE_SWITCH_THRESHOLD:-60}"
AGENT_SWITCH_THRESHOLD="${AGENT_SWITCH_THRESHOLD:-750}"
CURRENT_SMALL_TYPE="${CURRENT_SMALL_TYPE:-cx23}"
NODE_SWITCH_ALERT_FILE="${NODE_SWITCH_ALERT_FILE:-/var/run/nomad-node-switch-last-alert}"
NODE_SWITCH_RATE_LIMIT_SECONDS="${NODE_SWITCH_RATE_LIMIT_SECONDS:-86400}"
require_uint NODE_SWITCH_THRESHOLD "${NODE_SWITCH_THRESHOLD}" 1 1000
require_uint AGENT_SWITCH_THRESHOLD "${AGENT_SWITCH_THRESHOLD}" 1 1000000

ENV="${HEROBIDS_ENV:-unknown}"

# Current agent node type from tfvars (only remind while still on the small type).
VAR_FILE="${TERRAFORM_DIR:-/opt/herobids/infra/hetzner}/${ENV}.tfvars"
CUR_TYPE="$(grep -E '^agent_node_server_type[[:space:]]*=' "${VAR_FILE}" 2>/dev/null | head -1 | sed -E 's/.*=[[:space:]]*"?([^"# ]+)"?.*/\1/' || true)"
if [[ -n "${CUR_TYPE}" && "${CUR_TYPE}" != "${CURRENT_SMALL_TYPE}" ]]; then
  log "Agent node type is ${CUR_TYPE} (not ${CURRENT_SMALL_TYPE}); switch reminder not applicable."
  exit 0
fi

# ─── Read current node + active-agent counts (read-only) ──────────────────────

nodes_json="$(nomad_api GET "/v1/nodes" 2>/dev/null || true)"
[[ -n "${nodes_json}" ]] || { log "Nomad node list unavailable; skipping switch check."; exit 0; }
NODE_COUNT="$(jq -r '[.[] | select(.NodeClass == "agent" and .Status == "ready")] | length' <<< "${nodes_json}" 2>/dev/null || echo 0)"

jobs_json="$(nomad_api GET "/v1/jobs?namespace=${NOMAD_AGENT_NAMESPACE:-herobids-agents}" 2>/dev/null || true)"
AGENT_COUNT="$(jq -r '[.[] | select((.ID | startswith("agent-")) and .Status == "running")] | length' <<< "${jobs_json}" 2>/dev/null || echo 0)"

[[ "${NODE_COUNT}" =~ ^[0-9]+$ ]] || NODE_COUNT=0
[[ "${AGENT_COUNT}" =~ ^[0-9]+$ ]] || AGENT_COUNT=0
log "Switch check: ${NODE_COUNT} ready agent nodes, ${AGENT_COUNT} running agents (type ${CUR_TYPE:-?}); thresholds ${NODE_SWITCH_THRESHOLD} nodes / ${AGENT_SWITCH_THRESHOLD} agents."

TRIGGER=""
(( NODE_COUNT >= NODE_SWITCH_THRESHOLD )) && TRIGGER="nodes (${NODE_COUNT} >= ${NODE_SWITCH_THRESHOLD})"
if [[ -z "${TRIGGER}" ]] && (( AGENT_COUNT >= AGENT_SWITCH_THRESHOLD )); then
  TRIGGER="agents (${AGENT_COUNT} >= ${AGENT_SWITCH_THRESHOLD})"
fi
if [[ -z "${TRIGGER}" ]]; then
  log "Below the switch threshold; nothing to do."
  exit 0
fi

# ─── Rate-limit on this check's own stamp (not the failure-alert stamp) ───────

now="$(date +%s)"
if [[ -f "${NODE_SWITCH_ALERT_FILE}" ]]; then
  last="$(cat "${NODE_SWITCH_ALERT_FILE}" 2>/dev/null || echo 0)"
  [[ "${last}" =~ ^[0-9]+$ ]] || last=0
  if (( now - last < NODE_SWITCH_RATE_LIMIT_SECONDS )); then
    log "Switch reminder already sent $(( now - last ))s ago (< ${NODE_SWITCH_RATE_LIMIT_SECONDS}s); skipping."
    exit 0
  fi
fi

SUBJECT="[herobids-${ENV}] Node-type switch due: ${TRIGGER}"
BODY="Herobids node-type switch reminder
==================================
Environment:   ${ENV}
Timestamp:     $(date -u +%Y-%m-%dT%H:%M:%SZ)
Trigger:       ${TRIGGER}
Ready agent nodes: ${NODE_COUNT} (threshold ${NODE_SWITCH_THRESHOLD})
Running agents:    ${AGENT_COUNT} (threshold ${AGENT_SWITCH_THRESHOLD})
Current node type: ${CUR_TYPE:-unknown}

The agent pool has reached the point where switching cx23 -> cx53 is recommended
(cx53 holds ~120 agents/node vs ~14, is ~40% cheaper per agent, and keeps 10,000
agents under the 100-server private-network limit at ~85 nodes instead of ~715).

ACTION (raise the Hetzner shared-core limit FIRST, then):
  infra/hetzner/scripts/switch-node-type.sh --env ${ENV} --pool agent --to cx53
Runbook: infra/hetzner/docs/runbooks/switch-node-type.md

---
Generated by check-node-type-switch.sh.
"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY-RUN] Would send: ${SUBJECT}"
  exit 0
fi

# Reuse alert-common.sh senders (sendmail -> mail -> curl SMTP -> logger fallback).
sent=false
if _detect_sendmail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
  _send_via_sendmail "${SUBJECT}" "${BODY}" && sent=true
fi
if [[ "${sent}" != "true" ]] && _detect_mail &>/dev/null && [[ -n "${ALERT_TO:-}" ]]; then
  _send_via_mail "${SUBJECT}" "${BODY}" && sent=true
fi
if [[ "${sent}" != "true" ]] && _smtp_configured; then
  _send_via_curl_smtp "${SUBJECT}" "${BODY}" && sent=true
fi
if [[ "${sent}" != "true" ]]; then
  _send_via_logger "${SUBJECT}" "${BODY}"
fi

mkdir -p "$(dirname "${NODE_SWITCH_ALERT_FILE}")"
printf '%s\n' "${now}" > "${NODE_SWITCH_ALERT_FILE}"
log "Switch reminder sent (${TRIGGER})."
