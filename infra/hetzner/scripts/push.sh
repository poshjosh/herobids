#!/usr/bin/env bash
# push.sh — Deploy the latest Herobids commit to the Hetzner server.
#
# Pulls the latest code, builds the agent Docker image, and restarts all
# services via docker compose. Migrations run automatically via depends_on.
# A post-deploy health check waits for the API to become healthy.
#
# Usage:
#   infra/hetzner/scripts/push.sh [--yes|-y] [<server-ip>]
#   infra/hetzner/scripts/push.sh                 # reads IP from terraform output, asks for confirmation
#   infra/hetzner/scripts/push.sh --yes 1.2.3.4   # skips confirmation, deploys to 1.2.3.4
#   infra/hetzner/scripts/push.sh --yes           # skips confirmation, auto-detects IP via terraform
#
# Examples:
#   ./push.sh 1.2.3.4
#   ./push.sh --yes                               # auto-detect IP, no confirmation prompt

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "$(dirname "${BASH_SOURCE[0]}")/_ssh_opts.sh"

# ─── Parse flags ─────────────────────────────────────────────────────────────

SKIP_CONFIRM=false
SERVER_IP=""

if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  SKIP_CONFIRM=true
  shift
  SERVER_IP="${1:-}"
elif [[ $# -ge 1 ]]; then
  SERVER_IP="$1"
fi

# ─── Determine server IP (if not provided explicitly) ────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(cd "${TF_DIR}" && terraform output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided." >&2
  echo "" >&2
  echo "Usage: $0 [--yes|-y] <server-ip>" >&2
  echo "  Or run from the terraform directory to auto-detect:" >&2
  echo "    cd infra/hetzner && terraform output -raw server_ipv4" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

# ─── Confirmation ────────────────────────────────────────────────────────────

if [[ "${SKIP_CONFIRM}" != "true" ]]; then
  echo "Deploying to ${SERVER_IP}..."
  echo "This will: git reset --hard, rebuild agent image, restart all services."
  read -rp "Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "==> Deploying to ${SERVER_IP}..."

# ─── Deploy (single SSH session) ─────────────────────────────────────────────

ssh ${SSH_OPTS} "root@${SERVER_IP}" bash -s << 'DEPLOY'
set -euo pipefail
cd /opt/herobids

# Guard: stash local changes before reset
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARNING: Local changes detected on server. Stashing..."
  git stash
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pulling latest code..."
git fetch --all && git reset --hard origin/main

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Building agent image..."
docker build --pull -f docker/Dockerfile.agent -t herobids-agent:latest .

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting services..."
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build --remove-orphans

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Waiting for services to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] API is healthy."
    break
  fi
  sleep 2
done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruning old build cache..."
docker builder prune -af
DEPLOY

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "==> Deploy complete."
echo ""
echo "Migrations run automatically via the migrate service's depends_on."
echo "To manually re-run migrations:"
echo "  ssh root@${SERVER_IP} 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml run --rm migrate'"
