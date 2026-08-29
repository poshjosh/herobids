#!/usr/bin/env bash
# setup-nomad.sh — One-time setup for a Nomad-enabled environment.
#
# Takes a freshly provisioned environment (with S3 backend already migrated)
# and brings it to a fully working state: deploys credentials, bootstraps
# Nomad ACLs, redeploys with the token, and verifies health.
#
# This script is idempotent for ACL bootstrap — if ACLs are already
# bootstrapped, it skips that step and uses the existing token from
# .env.backend.
#
# Usage:
#   infra/hetzner/scripts/setup-nomad.sh --env <staging|production> \
#     --env-file <path> --backend-env-file <path>
#
# Example:
#   scripts/setup-nomad.sh --env staging \
#     --env-file .env.staging --backend-env-file .env.backend
#
# Prerequisites:
#   - Server provisioned (provision.sh already run)
#   - S3 backend migrated (migrate-backend-to-s3.sh already run)
#   - .env file exists (app secrets)
#   - .env.backend file exists (S3 credentials; NOMAD_ACL_TOKEN may be empty)
#
# What it does:
#   1. Initial deploy (uploads .env + autoscale.env, builds, starts services)
#   2. Waits for Nomad server to be healthy
#   3. Bootstraps Nomad ACLs (if not already done)
#   4. Saves the token to .env.backend and .env file
#   5. Redeploys to push the token to the server
#   6. Verifies authenticated Nomad access
#
# After running:
#   - Nomad ACLs are enabled and the token is in .env.backend
#   - Autoscale services have credentials via /etc/herobids/autoscale.env
#   - Worker has NOMAD_TOKEN via .env
#   - Day-to-day deploys use: deploy.sh --env <env> --env-file <file> --backend-env-file .env.backend

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/_ssh_opts.sh"

# ─── Parse arguments ─────────────────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

ENV_FILE=""
BACKEND_ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      if [[ -z "${ENV_FILE}" ]]; then
        echo "ERROR: --env-file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --backend-env-file)
      BACKEND_ENV_FILE="${2:-}"
      if [[ -z "${BACKEND_ENV_FILE}" ]]; then
        echo "ERROR: --backend-env-file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 --env <staging|production> --env-file <path> --backend-env-file <path>" >&2
      echo "" >&2
      echo "One-time setup for a Nomad-enabled environment." >&2
      echo "Deploys credentials, bootstraps ACLs, and verifies health." >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>              Target environment: staging or production." >&2
      echo "  --env-file <path>         Path to .env file (app secrets)." >&2
      echo "  --backend-env-file <path> Path to .env.backend file (S3 + Nomad credentials)." >&2
      echo "" >&2
      echo "Example:" >&2
      echo "  $0 --env staging --env-file .env.staging --backend-env-file .env.backend" >&2
      exit 0
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

# ─── Validate arguments ──────────────────────────────────────────────────────

if [[ -z "${ENV_FILE}" ]]; then
  echo "ERROR: --env-file is required." >&2
  echo "Usage: $0 --env <staging|production> --env-file <path> --backend-env-file <path>" >&2
  exit 1
fi

if [[ -z "${BACKEND_ENV_FILE}" ]]; then
  echo "ERROR: --backend-env-file is required." >&2
  echo "Usage: $0 --env <staging|production> --env-file <path> --backend-env-file <path>" >&2
  exit 1
fi

# Resolve relative paths against infra dir
if [[ "${ENV_FILE}" != /* ]]; then
  ENV_FILE="${INFRA_DIR}/${ENV_FILE}"
fi
if [[ "${BACKEND_ENV_FILE}" != /* ]]; then
  BACKEND_ENV_FILE="${INFRA_DIR}/${BACKEND_ENV_FILE}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: --env-file '${ENV_FILE}' does not exist." >&2
  exit 1
fi
if [[ ! -f "${BACKEND_ENV_FILE}" ]]; then
  echo "ERROR: --backend-env-file '${BACKEND_ENV_FILE}' does not exist." >&2
  exit 1
fi

# ─── Source backend credentials ───────────────────────────────────────────────

set -a
# shellcheck disable=SC1090
source "${BACKEND_ENV_FILE}"
set +a

# ─── Resolve server IP ───────────────────────────────────────────────────────

SERVER_IP=""
if command -v terraform &>/dev/null; then
  SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: Could not determine server IP from terraform output." >&2
  echo "Run provision.sh first, or provide the IP manually." >&2
  exit 1
fi

echo "========================================"
echo " Nomad Setup — ${HEROBIDS_ENV}"
echo "========================================"
echo " Server:           ${SERVER_IP}"
echo " Env file:         ${ENV_FILE}"
echo " Backend env file: ${BACKEND_ENV_FILE}"
echo ""

# ─── Step 1: Initial deploy ──────────────────────────────────────────────────

echo "── Step 1/6: Initial deploy ──"
echo "Deploying app + autoscale credentials to ${SERVER_IP}..."
echo ""

"${INFRA_DIR}/deploy.sh" --env "${HEROBIDS_ENV}" \
  --env-file "${ENV_FILE}" \
  --backend-env-file "${BACKEND_ENV_FILE}"

echo ""
echo "Initial deploy complete."
echo ""

# ─── Step 2: Wait for Nomad server ───────────────────────────────────────────

echo "── Step 2/6: Wait for Nomad server ──"
echo "Waiting for Nomad API to be healthy..."

NOMAD_HEALTHY=false
for ((i = 1; i <= 30; i++)); do
  if ssh ${SSH_OPTS} "root@${SERVER_IP}" 'curl -sf http://127.0.0.1:4646/v1/status/leader' >/dev/null 2>&1; then
    NOMAD_HEALTHY=true
    echo "Nomad server is healthy."
    break
  fi
  echo "  Waiting... (${i}/30)"
  sleep 5
done

if [[ "${NOMAD_HEALTHY}" != "true" ]]; then
  echo "ERROR: Nomad server did not become healthy within 150 seconds." >&2
  echo "Check: ssh root@${SERVER_IP} 'journalctl -u nomad -n 50'" >&2
  exit 1
fi

echo ""

# ─── Step 3: Bootstrap Nomad ACLs ────────────────────────────────────────────

echo "── Step 3/6: Bootstrap Nomad ACLs ──"

if [[ -n "${NOMAD_ACL_TOKEN:-}" ]]; then
  echo "NOMAD_ACL_TOKEN is already set in ${BACKEND_ENV_FILE} — skipping bootstrap."
  echo "Using existing token."
  ACL_TOKEN="${NOMAD_ACL_TOKEN}"
else
  echo "NOMAD_ACL_TOKEN is empty — bootstrapping ACLs..."
  echo ""

  BOOTSTRAP_OUTPUT="$(ssh ${SSH_OPTS} "root@${SERVER_IP}" 'nomad acl bootstrap' 2>&1)" || {
    if echo "${BOOTSTRAP_OUTPUT}" | grep -q "already been bootstrapped"; then
      echo "ACLs already bootstrapped on this cluster." >&2
      echo "You need the existing management token. Add it to ${BACKEND_ENV_FILE}:" >&2
      echo "  NOMAD_ACL_TOKEN=<your-existing-token>" >&2
      echo "Then re-run this script." >&2
      exit 1
    fi
    echo "ERROR: nomad acl bootstrap failed:" >&2
    echo "${BOOTSTRAP_OUTPUT}" >&2
    exit 1
  }

  # Extract the Secret ID from bootstrap output
  ACL_TOKEN="$(echo "${BOOTSTRAP_OUTPUT}" | grep 'Secret ID' | awk '{print $NF}')"

  if [[ -z "${ACL_TOKEN}" ]]; then
    echo "ERROR: Could not extract Secret ID from bootstrap output:" >&2
    echo "${BOOTSTRAP_OUTPUT}" >&2
    exit 1
  fi

  echo "ACL bootstrap successful."
  echo "Token: ${ACL_TOKEN:0:8}..."
  echo ""

  # ─── Step 4: Save token to files ─────────────────────────────────────────

  echo "── Step 4/6: Save token to config files ──"

  # Append to .env.backend
  if grep -q '^NOMAD_ACL_TOKEN=' "${BACKEND_ENV_FILE}"; then
    # Replace existing empty or placeholder value
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^NOMAD_ACL_TOKEN=.*|NOMAD_ACL_TOKEN=${ACL_TOKEN}|" "${BACKEND_ENV_FILE}"
    else
      sed -i "s|^NOMAD_ACL_TOKEN=.*|NOMAD_ACL_TOKEN=${ACL_TOKEN}|" "${BACKEND_ENV_FILE}"
    fi
    echo "Updated NOMAD_ACL_TOKEN in ${BACKEND_ENV_FILE}"
  else
    echo "NOMAD_ACL_TOKEN=${ACL_TOKEN}" >> "${BACKEND_ENV_FILE}"
    echo "Added NOMAD_ACL_TOKEN to ${BACKEND_ENV_FILE}"
  fi

  # Add/update NOMAD_TOKEN in .env file (for the worker container)
  if grep -q '^NOMAD_TOKEN=' "${ENV_FILE}"; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^NOMAD_TOKEN=.*|NOMAD_TOKEN=${ACL_TOKEN}|" "${ENV_FILE}"
    else
      sed -i "s|^NOMAD_TOKEN=.*|NOMAD_TOKEN=${ACL_TOKEN}|" "${ENV_FILE}"
    fi
    echo "Updated NOMAD_TOKEN in ${ENV_FILE}"
  else
    echo "" >> "${ENV_FILE}"
    echo "# Nomad ACL token (added by setup-nomad.sh)" >> "${ENV_FILE}"
    echo "NOMAD_TOKEN=${ACL_TOKEN}" >> "${ENV_FILE}"
    echo "Added NOMAD_TOKEN to ${ENV_FILE}"
  fi

  # Export for the redeploy step
  export NOMAD_ACL_TOKEN="${ACL_TOKEN}"

  echo ""
fi

# ─── Step 5: Redeploy with token ─────────────────────────────────────────────

echo "── Step 5/6: Redeploy with ACL token ──"
echo "Redeploying to push the token to the server..."
echo ""

"${INFRA_DIR}/deploy.sh" --env "${HEROBIDS_ENV}" \
  --env-file "${ENV_FILE}" \
  --backend-env-file "${BACKEND_ENV_FILE}"

echo ""
echo "Redeploy complete."
echo ""

# ─── Step 6: Verify ──────────────────────────────────────────────────────────

echo "── Step 6/6: Verify ──"

ACL_TOKEN="${NOMAD_ACL_TOKEN:-${ACL_TOKEN:-}}"

echo "Verifying Nomad server members..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" "NOMAD_TOKEN=${ACL_TOKEN} nomad server members" || {
  echo "WARNING: Could not list server members." >&2
}

echo ""
echo "Verifying Nomad node status..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" "NOMAD_TOKEN=${ACL_TOKEN} nomad node status" || {
  echo "WARNING: Could not list nodes (may be normal if no agent nodes are provisioned)." >&2
}

echo ""
echo "Verifying autoscale env file on server..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'test -f /etc/herobids/autoscale.env && echo "/etc/herobids/autoscale.env exists (OK)" || echo "WARNING: /etc/herobids/autoscale.env not found"'

echo ""
echo "Verifying Nomad ACL token file on server..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'test -f /etc/nomad.d/acl-token && echo "/etc/nomad.d/acl-token exists (OK)" || echo "WARNING: /etc/nomad.d/acl-token not found"'

echo ""
echo "========================================"
echo " Nomad Setup Complete — ${HEROBIDS_ENV}"
echo "========================================"
echo ""
echo " Server:     ${SERVER_IP}"
echo " ACL token:  ${ACL_TOKEN:0:8}... (saved to ${BACKEND_ENV_FILE})"
echo ""
echo " Day-to-day deploys:"
echo "   ${INFRA_DIR}/deploy.sh --env ${HEROBIDS_ENV} --env-file ${ENV_FILE} --backend-env-file ${BACKEND_ENV_FILE}"
echo ""
echo " Next steps:"
echo "   - Run the production validation plan (002-production-validation-plan.md)"
echo "   - Or provision agent nodes: provision.sh --env ${HEROBIDS_ENV} --var-file ${HEROBIDS_ENV}.tfvars --backend-env-file .env.backend"
echo ""
echo "========================================"
