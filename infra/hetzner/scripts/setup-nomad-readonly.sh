#!/usr/bin/env bash
# setup-nomad-readonly.sh — Create a read-only Nomad ACL token for evaluators.
#
# Applies infra/nomad/acl/eval-readonly.hcl on the server and creates a
# client token bound to it. The token is saved as NOMAD_READONLY_TOKEN in a
# separate, gitignored file (default: infra/hetzner/.env.eval.<env>), never in
# the deploy env file, because deploy uploads that file to the server.
#
# Uses the environment's management NOMAD_TOKEN (from --env-file) to write the
# policy and token. This changes Nomad ACL state on the target cluster.
#
# Idempotent: the policy is re-applied on every run (existing tokens pick up
# edits); if the eval file already holds a token the server accepts, no new
# token is created.
#
# Usage:
#   infra/hetzner/scripts/setup-nomad-readonly.sh --env <staging|production> \
#     --env-file <path> [--eval-env-file <path>] [--server-ip <ip>] [--rotate]
#
# Example:
#   scripts/setup-nomad-readonly.sh --env staging --env-file .env.staging
#
# Using the token afterwards (on the server):
#   NOMAD_ADDR=http://127.0.0.1:4646 NOMAD_TOKEN=<token> \
#     nomad job status -namespace=herobids-agents

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/_ssh_opts.sh"

POLICY_NAME="eval-readonly"
POLICY_FILE="${INFRA_DIR}/../nomad/acl/eval-readonly.hcl"

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

ENV_FILE=""
EVAL_ENV_FILE=""
SERVER_IP=""
ROTATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)      ENV_FILE="${2:-}"; shift 2 ;;
    --eval-env-file) EVAL_ENV_FILE="${2:-}"; shift 2 ;;
    --server-ip)     SERVER_IP="${2:-}"; shift 2 ;;
    --rotate)        ROTATE=true; shift ;;
    --help|-h)
      echo "Usage: $0 --env <staging|production> --env-file <path> [--eval-env-file <path>] [--server-ip <ip>] [--rotate]" >&2
      echo "" >&2
      echo "Creates a read-only Nomad ACL token (policy: ${POLICY_NAME}) and saves it" >&2
      echo "as NOMAD_READONLY_TOKEN in the eval env file (default .env.eval.<env>)." >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>            Target environment: staging or production." >&2
      echo "  --env-file <path>       Deploy env file holding the management NOMAD_TOKEN." >&2
      echo "  --eval-env-file <path>  Where to save the read-only token." >&2
      echo "  --server-ip <ip>        Server IP (default: terraform output server_ipv4)." >&2
      echo "  --rotate                Create a new token even if the saved one is valid." >&2
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${ENV_FILE}" ]]; then
  echo "ERROR: --env-file is required." >&2
  exit 1
fi
[[ "${ENV_FILE}" != /* ]] && ENV_FILE="${INFRA_DIR}/${ENV_FILE}"
[[ -z "${EVAL_ENV_FILE}" ]] && EVAL_ENV_FILE="${INFRA_DIR}/.env.eval.${HEROBIDS_ENV}"
[[ "${EVAL_ENV_FILE}" != /* ]] && EVAL_ENV_FILE="${INFRA_DIR}/${EVAL_ENV_FILE}"

[[ -f "${ENV_FILE}" ]] || { echo "ERROR: --env-file '${ENV_FILE}' does not exist." >&2; exit 1; }
[[ -f "${POLICY_FILE}" ]] || { echo "ERROR: policy file '${POLICY_FILE}' not found." >&2; exit 1; }

read_var() { # <file> <name>
  grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' || true
}

MGMT_TOKEN="$(read_var "${ENV_FILE}" NOMAD_TOKEN)"
if [[ -z "${MGMT_TOKEN}" ]]; then
  echo "ERROR: NOMAD_TOKEN is empty in ${ENV_FILE}. Run setup-nomad.sh first." >&2
  exit 1
fi

if [[ -z "${SERVER_IP}" ]] && command -v terraform &>/dev/null; then
  SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
fi
if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: Could not determine server IP. Pass --server-ip <ip>." >&2
  exit 1
fi

# Run a command on the server with NOMAD_TOKEN taken from the first stdin line,
# so no token ever appears in a process list or argument.
# Any further stdin is passed through to the command.
remote_nomad() { # <token> <command...>; stdin forwarded after the token
  local token="$1"; shift
  { printf '%s\n' "${token}"; cat; } \
    | ssh ${SSH_OPTS} "root@${SERVER_IP}" \
      "read -r NOMAD_TOKEN; export NOMAD_TOKEN NOMAD_ADDR=http://127.0.0.1:4646; $*"
}

echo "========================================"
echo " Nomad read-only token — ${HEROBIDS_ENV}"
echo "========================================"
echo " Server:    ${SERVER_IP}"
echo " Policy:    ${POLICY_NAME} (${POLICY_FILE})"
echo " Saved to:  ${EVAL_ENV_FILE}"
echo ""

# ─── Apply policy (every run, so policy edits reach existing tokens) ─────────

echo "── Applying policy ${POLICY_NAME} ──"
remote_nomad "${MGMT_TOKEN}" \
  "nomad acl policy apply -description 'Evaluator access: read jobs, logs, files; alloc exec' ${POLICY_NAME} -" \
  < "${POLICY_FILE}"

# ─── Reuse a valid saved token ───────────────────────────────────────────────

EXISTING="$(read_var "${EVAL_ENV_FILE}" NOMAD_READONLY_TOKEN)"
if [[ -n "${EXISTING}" && "${ROTATE}" != "true" ]]; then
  if remote_nomad "${EXISTING}" 'nomad acl token self >/dev/null 2>&1' </dev/null; then
    echo "Saved NOMAD_READONLY_TOKEN is valid (${EXISTING:0:8}...). Nothing to do. Use --rotate for a new one."
    exit 0
  fi
  echo "Saved token is not accepted by the server; creating a new one."
fi

# ─── Create token ────────────────────────────────────────────────────────────

echo "── Creating token ──"
CREATED="$(remote_nomad "${MGMT_TOKEN}" \
  "nomad acl token create -name=eval-readonly-$(date -u +%Y%m%d%H%M%S) -policy=${POLICY_NAME} -type=client -json | jq -r '.AccessorID + \" \" + .SecretID'" \
  </dev/null)"
NEW_ACCESSOR="${CREATED%% *}"
NEW_TOKEN="${CREATED##* }"

if [[ -z "${NEW_TOKEN}" || "${NEW_TOKEN}" == "null" || "${NEW_ACCESSOR}" == "${NEW_TOKEN}" ]]; then
  echo "ERROR: token creation returned no secret ID." >&2
  exit 1
fi

# Delete the just-created token if verification fails, so no unused token is left behind.
discard_token() {
  remote_nomad "${MGMT_TOKEN}" "nomad acl token delete ${NEW_ACCESSOR}" </dev/null >/dev/null 2>&1 \
    && echo "Deleted the unverified token (accessor ${NEW_ACCESSOR})." >&2 \
    || echo "WARNING: could not delete token accessor ${NEW_ACCESSOR}; delete it manually." >&2
}

# ─── Verify: reads work, management actions are denied ──────────────────────
# `acl policy list` is not a valid denial test: Nomad lets any token list the
# policies attached to itself. `acl token list` needs a management token.

echo "── Verifying ──"
if ! remote_nomad "${NEW_TOKEN}" 'nomad job status -namespace=herobids-agents >/dev/null' </dev/null; then
  echo "ERROR: new token cannot read jobs in herobids-agents." >&2
  discard_token
  exit 1
fi

if remote_nomad "${NEW_TOKEN}" 'nomad acl token list >/dev/null 2>&1' </dev/null; then
  echo "ERROR: new token can list ACL tokens; it is not read-only. Not saving it." >&2
  discard_token
  exit 1
fi
echo "Reads allowed, ACL token listing denied."

# ─── Save ────────────────────────────────────────────────────────────────────

touch "${EVAL_ENV_FILE}"
chmod 600 "${EVAL_ENV_FILE}"
if grep -qE '^NOMAD_READONLY_TOKEN=' "${EVAL_ENV_FILE}"; then
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^NOMAD_READONLY_TOKEN=.*|NOMAD_READONLY_TOKEN=${NEW_TOKEN}|" "${EVAL_ENV_FILE}"
  else
    sed -i "s|^NOMAD_READONLY_TOKEN=.*|NOMAD_READONLY_TOKEN=${NEW_TOKEN}|" "${EVAL_ENV_FILE}"
  fi
else
  printf 'NOMAD_READONLY_TOKEN=%s\n' "${NEW_TOKEN}" >> "${EVAL_ENV_FILE}"
fi

echo ""
echo "Saved NOMAD_READONLY_TOKEN (${NEW_TOKEN:0:8}...) to ${EVAL_ENV_FILE}"
