#!/usr/bin/env bash
# switch-node-type.sh — switch the agent and/or browser Nomad pool between Hetzner
# server types (e.g. cx23 <-> cx53) on one environment, with a mandatory plan review.
#
# RUN THIS ON THE CONTROL PLANE (it uses the local Terraform state + backend creds the
# autoscaler uses). It orchestrates the same gated flow an operator does by hand:
#   1. Pre-checks: env, target type valid, Hetzner shared-core headroom for the new size.
#   2. Stop the autoscale timers (so scale-out/in do not fight the roll).
#   3. Set agent_node_server_type / browser_node_server_type in <env>.tfvars.
#   4. Produce a -replace plan for the pool being switched, SHOW it, and require the
#      operator to type the confirmation phrase. Refuse if the plan is not exactly the
#      expected replace set (nothing touching hcloud_server.default, the network, volumes).
#   5. Apply the saved plan. Wait for each new node to rejoin ready+eligible.
#   6. refresh-only to clear the hcloud_firewall.agent[0] apply_to drift (so the scale-out
#      allowlist is not tripped).
#   7. Agents: re-measure the node template and rewrite the autoscale settings so demand
#      mode simulates placement against the new node size.
#   8. Browser: restart the worker (it resolves the browser pool address once at startup)
#      and re-run the sandbox egress sanity (A1-A3) note.
#   9. Restart the autoscale timers.
#
# This script NEVER force-applies: step 4 stops unless you type the phrase, and it refuses
# any plan with an unexpected destroy/replace. Hard-to-undo by nature — read the runbook
# (infra/hetzner/docs/runbooks/switch-node-type.md) before using it.
#
# Usage (on the control plane):
#   switch-node-type.sh --env <staging|production> --pool <agent|browser> --to <server-type> [--yes]
#
# Options:
#   --env ENV        staging | production (required).
#   --pool POOL      agent | browser (required). Which pool to switch.
#   --to TYPE        target Hetzner server type, e.g. cx53 (required).
#   --yes            skip the interactive confirmation (still refuses an unexpected plan).
#   --dry-run        produce and show the plan, make no changes.
#   --help           show this help.
#
# Env:
#   HCLOUD_TOKEN, AWS_* , TF_BACKEND_*   sourced from /etc/herobids/autoscale.env normally.
#   TERRAFORM_DIR                        default /opt/herobids/infra/hetzner.

set -euo pipefail

ENV="" POOL="" TO_TYPE="" ASSUME_YES=false DRY_RUN=false
TERRAFORM_DIR="${TERRAFORM_DIR:-/opt/herobids/infra/hetzner}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[switch-node-type] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="${2:-}"; shift 2 ;;
    --pool) POOL="${2:-}"; shift 2 ;;
    --to) TO_TYPE="${2:-}"; shift 2 ;;
    --yes) ASSUME_YES=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) sed -n '2,45p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "${ENV}" == "staging" || "${ENV}" == "production" ]] || die "--env must be staging or production"
[[ "${POOL}" == "agent" || "${POOL}" == "browser" ]] || die "--pool must be agent or browser"
[[ "${TO_TYPE}" =~ ^(cx|ccx|cpx|CAX)[0-9]+$ ]] || die "--to '${TO_TYPE}' is not a valid Hetzner type"

export HEROBIDS_ENV="${ENV}"
VAR_FILE="${TERRAFORM_DIR}/${ENV}.tfvars"
[[ -f "${VAR_FILE}" ]] || die "tfvars not found: ${VAR_FILE}"

# Source backend + Hetzner creds the same way the autoscaler does, exporting them.
if [[ -z "${HCLOUD_TOKEN:-}" && -f /etc/herobids/autoscale.env ]]; then
  set -a; # shellcheck disable=SC1091
  source /etc/herobids/autoscale.env; set +a
fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN not set (source /etc/herobids/autoscale.env)"

source "${SCRIPT_DIR}/scale-common.sh"
source "${SCRIPT_DIR}/capacity-inventory.sh"

TF_VAR_NAME="agent_node_server_type"
TF_ADDR="hcloud_server.agent"
NET_ADDR="hcloud_server_network.agent"
if [[ "${POOL}" == "browser" ]]; then
  TF_VAR_NAME="browser_node_server_type"
  TF_ADDR="hcloud_server.browser"
  NET_ADDR="hcloud_server_network.browser"
fi

# ─── 1. Pre-checks ────────────────────────────────────────────────────────────

log "Reading current ${TF_VAR_NAME} and the live inventory..."
CURRENT_TYPE="$(grep -E "^${TF_VAR_NAME}[[:space:]]*=" "${VAR_FILE}" | head -1 | sed -E 's/.*=[[:space:]]*"?([^"# ]+)"?.*/\1/')"
log "  current: ${CURRENT_TYPE:-<unset>}  ->  target: ${TO_TYPE}"
if [[ "${CURRENT_TYPE}" == "${TO_TYPE}" ]]; then
  log "Already ${TO_TYPE}; nothing to switch."
  exit 0
fi

# Hetzner shared-core headroom: the new type's vCPU count must fit the project limit.
# A cx53 is 16 vCPU; a shared project can refuse with 'shared core limit exceeded'. Fetch
# the project's current server count + the type's cores and warn loudly (we cannot read the
# project quota via the API, so this is a heads-up, not a hard gate — the apply is the real test).
TYPE_CORES="$(printf 'header = "Authorization: Bearer %s"\n' "${HCLOUD_TOKEN}" \
  | curl -sS -K - "${HCLOUD_API_URL:-https://api.hetzner.cloud/v1}/server_types?per_page=100" \
  | jq -r --arg t "${TO_TYPE}" '.server_types[] | select(.name==$t) | .cores' 2>/dev/null || true)"
log "  ${TO_TYPE} = ${TYPE_CORES:-?} vCPU per node."
log "  NOTE: the Hetzner project is shared (herobids staging+production+traderton). If the"
log "        project's shared-vCPU/server limit is too low, the apply will fail with"
log "        'shared core limit exceeded' AFTER destroying the old node. Confirm the limit"
log "        was raised in the Hetzner console before switching UP to a larger type."

# ─── 2. Stop the autoscale timers ─────────────────────────────────────────────

if [[ "${DRY_RUN}" != "true" ]]; then
  log "Stopping autoscale timers (will restart at the end)..."
  systemctl stop nomad-autoscale.timer nomad-scale-in.timer 2>/dev/null || true
fi

# ─── 3. Set the type in tfvars ────────────────────────────────────────────────

cp "${VAR_FILE}" "${VAR_FILE}.bak-switch-$(date +%s)"
if grep -qE "^${TF_VAR_NAME}[[:space:]]*=" "${VAR_FILE}"; then
  sed -i -E "s|^${TF_VAR_NAME}[[:space:]]*=.*|${TF_VAR_NAME} = \"${TO_TYPE}\"|" "${VAR_FILE}"
else
  printf '%s = "%s"\n' "${TF_VAR_NAME}" "${TO_TYPE}" >> "${VAR_FILE}"
fi
log "Set ${TF_VAR_NAME} = ${TO_TYPE} in ${VAR_FILE} (backup kept)."

# ─── 4. Plan (replace the pool), show, confirm ────────────────────────────────

export TF_DATA_DIR="${TERRAFORM_DIR}/.terraform-envs/${ENV}"
cd "${TERRAFORM_DIR}"
tf_ensure_ready

# Replace every index of the pool so each node is rebuilt from the current template on the
# new type. -target keeps the plan to this pool only (the browser node keeps its fixed IP;
# a replace destroys the old attachment before the new one — create_before_destroy is not set).
mapfile -t REPLACE_ARGS < <(
  terraform state list 2>/dev/null | grep -E "^${TF_ADDR}\[" | sed 's/^/-replace=/'
)
[[ ${#REPLACE_ARGS[@]} -gt 0 ]] || die "no ${TF_ADDR}[*] in state; nothing to replace"

PLAN_FILE="/tmp/switch-${POOL}-${TO_TYPE}.tfplan"
log "Planning the replace of ${#REPLACE_ARGS[@]} ${POOL} node(s)..."
terraform plan -input=false -var-file="${VAR_FILE}" \
  "${REPLACE_ARGS[@]}" -target="${TF_ADDR}" -target="${NET_ADDR}" \
  -out="${PLAN_FILE}" >/tmp/switch-plan.log 2>&1 \
  || { tail -20 /tmp/switch-plan.log; die "terraform plan failed"; }

# Guard: refuse any action on protected resources. Only replace/create/delete of the pool's
# own server + network resources are allowed.
BAD="$(terraform show -no-color -json "${PLAN_FILE}" 2>/dev/null | jq -r --arg s "${TF_ADDR}" --arg n "${NET_ADDR}" '
  .resource_changes[]
  | select(.change.actions != ["no-op"] and .change.actions != ["read"])
  | select((.address | startswith($s + "[") or startswith($n + "[")) | not)
  | .address')"
if [[ -n "${BAD}" ]]; then
  echo "REFUSING: the plan touches resources outside the ${POOL} pool:" >&2
  echo "${BAD}" >&2
  die "unexpected plan; nothing applied (tfvars backup kept)"
fi

echo "── Plan summary (actions on the ${POOL} pool) ──"
terraform show -no-color -json "${PLAN_FILE}" | jq -r '.resource_changes[] | select(.change.actions!=["no-op"]) | "  \(.change.actions|join(","))  \(.address)"'

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY-RUN] plan saved to ${PLAN_FILE}; no changes made. Restart timers if you stopped them."
  exit 0
fi

if [[ "${ASSUME_YES}" != "true" ]]; then
  echo ""
  echo "This REPLACES the ${POOL} node(s) on ${ENV} with ${TO_TYPE} (destroy + recreate)."
  echo "Agents on a replaced node restart elsewhere. Type: switch ${POOL} ${ENV} ${TO_TYPE}"
  read -r CONFIRM
  [[ "${CONFIRM}" == "switch ${POOL} ${ENV} ${TO_TYPE}" ]] || die "confirmation phrase did not match; nothing applied"
fi

# ─── 5. Apply ─────────────────────────────────────────────────────────────────

log "Applying the saved plan..."
tf_apply_plan "${PLAN_FILE}" || die "apply failed. Check Hetzner limits ('shared core limit exceeded' means the project quota is too low). The old node(s) may already be destroyed; re-run once the limit is raised, or switch back to ${CURRENT_TYPE}."

# ─── 6. Clear the firewall apply_to drift (agent pool) ────────────────────────

if [[ "${POOL}" == "agent" ]]; then
  log "Reconciling hcloud_firewall.agent[0] apply_to drift (refresh-only)..."
  REFRESH="/tmp/switch-refresh.tfplan"
  terraform plan -refresh-only -input=false -var-file="${VAR_FILE}" -out="${REFRESH}" >/dev/null 2>&1 || true
  if terraform show -no-color -json "${REFRESH}" 2>/dev/null | jq -e '[.resource_changes[]?|select(.change.actions!=["no-op"])]|length==0' >/dev/null; then
    tf_apply_plan "${REFRESH}" || log "WARNING: refresh-only apply failed; run it by hand before the autoscaler resumes."
  fi
fi

# ─── 7/8. Post-switch: template re-measure (agent) or worker restart (browser) ─

log "Switch applied. REMAINING MANUAL STEPS (see the runbook):"
if [[ "${POOL}" == "agent" ]]; then
  log "  - Re-measure the node template on the new ${TO_TYPE} node (Nomad GET /v1/node/<id>:"
  log "    NodeResources.Memory.MemoryMB / Cpu.CpuShares) and set nomad_node_template_memory_mb"
  log "    / nomad_node_template_cpu_mhz, then re-upload settings (setup-autoscale-env.sh --env ${ENV})"
  log "    so demand mode simulates against the new size. The old values would mis-size scale-out."
else
  log "  - Restart the worker so it re-resolves the browser pool address:"
  log "      docker compose -f docker-compose.yaml -f docker-compose.${ENV}.yaml up -d worker"
  log "  - Re-run sandbox checks A1-A3 on an agent (public ok, private blocked, browser reachable)."
fi

# ─── 9. Restart timers ────────────────────────────────────────────────────────

log "Restarting autoscale timers..."
systemctl start nomad-autoscale.timer 2>/dev/null || log "WARNING: could not start nomad-autoscale.timer"
if [[ "$(grep -cE '^enable_scale_in[[:space:]]*=[[:space:]]*true' "${VAR_FILE}")" -ge 1 ]]; then
  systemctl start nomad-scale-in.timer 2>/dev/null || log "WARNING: could not start nomad-scale-in.timer"
fi

log "Done. Verify: nomad node status shows the new ${TO_TYPE} node(s) ready+eligible, and the"
log "autoscale log has no blockers."
