#!/usr/bin/env bash
# setup-env.sh — Upload a local .env file to the Hetzner server.
#
# Copies a local .env file to /opt/herobids/.env on the server and sets
# restrictive permissions (chmod 600). This file contains secrets
# (API keys, JWT secret, etc.) and must never be world-readable.
#
# Naming convention for env files:
#   .env.staging     → staging environment secrets
#   .env.production  → production environment secrets
#
# Usage:
#   infra/hetzner/scripts/setup-env.sh [--env <staging|production>] [<server-ip>] --file <path>
#   infra/hetzner/scripts/setup-env.sh --env staging --file infra/hetzner/.env.staging
#   infra/hetzner/scripts/setup-env.sh --env staging 1.2.3.4 --file infra/hetzner/.env.production  # explicit IP
#   infra/hetzner/scripts/setup-env.sh    # interactive prompt
#
# Environment:
#   HEROBIDS_ENV   Deployment environment: staging | production (default: production).
#
# Examples:
#   ./setup-env.sh --env staging --file .env.staging
#   ./setup-env.sh --env-file .env.prod
#   ./setup-env.sh 1.2.3.4 --file ../.env.prod
#   ./setup-env.sh                        # prompts for path

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "$(dirname "${BASH_SOURCE[0]}")/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# ─── Parse arguments ─────────────────────────────────────────────────────────

ENV_FILE=""
SERVER_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      ENV_FILE="${2:-}"
      if [[ -z "${ENV_FILE}" ]]; then
        echo "ERROR: --file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--env <staging|production>] [<server-ip>] [--file <path>]" >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>      Target environment: staging or production (default: production)." >&2
      echo "  --file <path>     Path to local .env file to upload." >&2
      echo "  <server-ip>       Server IP address (auto-detected from terraform if omitted)." >&2
      echo "" >&2
      echo "If --file is omitted, the script prompts interactively." >&2
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
  echo "Usage: $0 [<server-ip>] [--file <path>]" >&2
  echo "  Or run provision.sh first to provision the server:" >&2
  echo "    infra/hetzner/scripts/provision.sh --env ${HEROBIDS_ENV}" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

# ─── Determine .env file path ────────────────────────────────────────────────

if [[ -z "${ENV_FILE}" ]]; then
  echo "No --file provided."
  read -rp "Path to local .env file: " ENV_FILE
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: File not found: ${ENV_FILE}" >&2
  exit 1
fi

# ─── Upload ──────────────────────────────────────────────────────────────────

echo "==> [${HEROBIDS_ENV}] Ensuring target directory exists on ${SERVER_IP}..."
ssh ${SSH_OPTS} "root@${SERVER_IP}" 'mkdir -p /opt/herobids' || {
  echo "ERROR: Cannot create /opt/herobids on server." >&2
  exit 1
}

echo "==> Uploading ${ENV_FILE} to root@${SERVER_IP}:/opt/herobids/.env ..."

scp ${SSH_OPTS} "${ENV_FILE}" "root@${SERVER_IP}:/opt/herobids/.env"

echo "==> Setting restrictive permissions (chmod 600)..."

ssh ${SSH_OPTS} "root@${SERVER_IP}" 'chmod 600 /opt/herobids/.env'

echo ""
echo "==> Done. .env file uploaded and permissions set."
echo "    Path on server: /opt/herobids/.env"
echo "    Permissions:    600 (owner read/write only)"
