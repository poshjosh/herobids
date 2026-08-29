#!/usr/bin/env bash
# deploy.sh — Full deployment orchestrator for Herobids on Hetzner.
#
# Runs the complete deploy sequence:
#   1. setup-env.sh            — upload .env to server
#   2. setup-autoscale-env.sh  — upload autoscale.env (infra secrets, skipped if TF_BACKEND_BUCKET unset)
#   3. push.sh --yes           — git pull → build → compose up
#   4. seed-admin.sh           — seed admin user (skipped if ADMIN_EMAIL/ADMIN_PASSWORD not set)
#   5. verify                  — curl health endpoint on server
#
# Usage:
#   infra/hetzner/deploy.sh [--env <staging|production>] [--env-file <path>] [--backend-env-file <path>] [<server-ip>]
#   infra/hetzner/deploy.sh                                                                # auto-detect IP, prompt for .env
#   infra/hetzner/deploy.sh --env staging --env-file .env.staging --backend-env-file .env.backend
#   infra/hetzner/deploy.sh --env-file infra/hetzner/.env.prod 1.2.3.4                     # explicit IP + .env
#   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret ./deploy.sh --env-file infra/hetzner/.env.prod
#
# Environment:
#   HEROBIDS_ENV   Deployment environment: staging | production (default: production).
#                  Can also be set via --env flag.
#
# Examples:
#   ./deploy.sh --env staging --env-file .env.staging
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme ./deploy.sh --env-file .env.prod 1.2.3.4

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="${SCRIPT_DIR}/scripts"
TF_DIR="${SCRIPT_DIR}"
source "${SCRIPTS_DIR}/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# ─── Parse arguments ─────────────────────────────────────────────────────────

ENV_FILE=""
SERVER_IP=""
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-${SCRIPT_DIR}/../.env.backend}"

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
      echo "Usage: $0 [--env <staging|production>] [--env-file <path>] [--backend-env-file <path>] [<server-ip>]" >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>              Target environment: staging or production (default: production)." >&2
      echo "  --env-file <path>         Path to local .env file (forwarded to setup-env.sh)." >&2
      echo "  --backend-env-file <path> Path to env file with S3 backend and Nomad ACL credentials." >&2
      echo "                            Sourced before uploading autoscale.env to the server." >&2
      echo "                            Falls back to shell environment variables if omitted." >&2
      echo "  <server-ip>               Server IP address (auto-detected from terraform if omitted)." >&2
      echo "" >&2
      echo "Environment variables:" >&2
      echo "  HEROBIDS_ENV        Deployment environment (overridden by --env)." >&2
      echo "  ADMIN_EMAIL         Email for admin user seeding (skip if not set)." >&2
      echo "  ADMIN_PASSWORD      Password for admin user seeding (skip if not set)." >&2
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      SERVER_IP="$1"
      shift
      ;;
  esac
done

# ─── Determine server IP (if not provided explicitly) ────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided." >&2
  echo "" >&2
  echo "Usage: $0 [--env-file <path>] <server-ip>" >&2
  echo "  Or run provision.sh first to provision the server:" >&2
  echo "    infra/hetzner/scripts/provision.sh --env ${HEROBIDS_ENV}" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

echo "========================================"
echo " Herobids Deploy Orchestrator"
echo "========================================"
echo " Environment: ${HEROBIDS_ENV}"
echo " Server:      ${SERVER_IP}"
echo ""

# ─── Step 1: Upload .env ─────────────────────────────────────────────────────

echo "── Step 1/5: Upload .env ──"

SETUP_ARGS=("${SCRIPTS_DIR}/setup-env.sh" "--env" "${HEROBIDS_ENV}" "${SERVER_IP}")
if [[ -n "${ENV_FILE}" ]]; then
  SETUP_ARGS+=("--file" "${ENV_FILE}")
fi

if ! "${SETUP_ARGS[@]}"; then
  echo "" >&2
  echo "ERROR: setup-env.sh failed. Aborting deploy." >&2
  exit 1
fi

echo ""

# ─── Step 2: Upload autoscale.env (infra secrets) ────────────────────────────

echo "── Step 2/5: Upload autoscale.env ──"

# Source backend env file if provided (--backend-env-file).
if [[ -n "${BACKEND_ENV_FILE}" ]]; then
  if [[ ! -f "${BACKEND_ENV_FILE}" ]]; then
    echo "ERROR: --backend-env-file '${BACKEND_ENV_FILE}' does not exist." >&2
    exit 1
  fi
  echo "==> Sourcing backend env file: ${BACKEND_ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${BACKEND_ENV_FILE}"
  set +a
fi

if [[ -n "${TF_BACKEND_BUCKET:-}" ]]; then
  if ! "${SCRIPTS_DIR}/setup-autoscale-env.sh" --env "${HEROBIDS_ENV}" "${SERVER_IP}"; then
    echo "" >&2
    echo "ERROR: setup-autoscale-env.sh failed. Aborting deploy." >&2
    exit 1
  fi
else
  echo "TF_BACKEND_BUCKET not set — skipping autoscale env upload."
fi

echo ""

# ─── Step 3: Push (git pull → build → compose up) ────────────────────────────

echo "── Step 3/5: Push (git pull → build → compose up) ──"

if ! "${SCRIPTS_DIR}/push.sh" --env "${HEROBIDS_ENV}" --yes "${SERVER_IP}"; then
  echo "" >&2
  echo "ERROR: push.sh failed. Aborting deploy." >&2
  exit 1
fi

echo ""

# ─── Step 4: Seed admin user (skip if env vars not set) ──────────────────────

echo "── Step 4/5: Seed admin user ──"

if [[ -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping admin seeding."
  echo "To seed later: ADMIN_EMAIL=<email> ADMIN_PASSWORD=<pw> ${SCRIPTS_DIR}/seed-admin.sh --env ${HEROBIDS_ENV} ${SERVER_IP}"
else
  if ! ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" "${SCRIPTS_DIR}/seed-admin.sh" --env "${HEROBIDS_ENV}" "${SERVER_IP}"; then
    echo "" >&2
    echo "ERROR: seed-admin.sh failed. Aborting deploy." >&2
    exit 1
  fi
fi

echo ""

# ─── Step 5: Verify health endpoint ──────────────────────────────────────────

echo "── Step 5/5: Verify health endpoint ──"

# Pre-flight: verify SSH connectivity before polling health
echo ""
echo "==> Verifying SSH connectivity..."
if ! ssh ${SSH_OPTS} "root@${SERVER_IP}" 'echo ok' > /dev/null 2>&1; then
  echo "ERROR: Cannot connect to server via SSH. Check that the server is running and reachable." >&2
  echo "  Try: ssh root@${SERVER_IP}" >&2
  exit 1
fi

echo "Checking API health on ${SERVER_IP}..."

HEALTHY=false
for ((i = 1; i <= 30; i++)); do
  if ssh ${SSH_OPTS} "root@${SERVER_IP}" 'curl -sf http://localhost:3000/health' > /dev/null 2>&1; then
    echo "API is healthy."
    HEALTHY=true
    break
  fi
  echo "  Waiting... (${i}/30)"
  sleep 2
done

if [[ "${HEALTHY}" != "true" ]]; then
  echo "" >&2
  echo "ERROR: Health check failed after 60 seconds. The API may still be starting." >&2
  echo "Check logs: ${SCRIPTS_DIR}/logs.sh ${SERVER_IP}" >&2
  exit 1
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Deploy Complete"
echo "========================================"
echo ""

# Try to get URLs from terraform output, fall back to IP-based URLs
FRONTEND_URL="$(terraform_output -raw frontend_url 2>/dev/null || echo "http://${SERVER_IP}:3000")"
API_URL="$(terraform_output -raw api_url 2>/dev/null || echo "http://${SERVER_IP}:3000/api")"

echo "  Frontend URL:  ${FRONTEND_URL}"
echo "  API URL:       ${API_URL}"
echo "  Health:        http://${SERVER_IP}:3000/health"
echo ""
echo "  SSH:           ssh root@${SERVER_IP}"
echo "  Logs:          ${SCRIPTS_DIR}/logs.sh ${SERVER_IP}"
echo ""
echo "========================================"
