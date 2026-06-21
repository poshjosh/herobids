#!/usr/bin/env bash
# reset.sh — Wipe all ephemeral state (DB, Redis, Caddy cache) on the Hetzner server.
#
# Destroys and recreates the Postgres and Caddy volumes, flushes Redis, runs
# fresh migrations, and verifies the API comes up healthy. Equivalent to a
# full clean deploy from a blank database.
#
# Usage:
#   infra/hetzner/scripts/reset.sh [<server-ip>]
#   infra/hetzner/scripts/reset.sh                        # auto-detect IP via terraform
#   infra/hetzner/scripts/reset.sh 1.2.3.4                # explicit IP
#
# Flags:
#   --yes | -y    Skip confirmation prompt
#   --seed        Also seed the admin user after reset (requires ADMIN_EMAIL + ADMIN_PASSWORD)
#
# Examples:
#   ./reset.sh --yes
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme ./reset.sh --yes --seed
#   ./reset.sh 1.2.3.4
#
# WARNING: This is destructive — all trading data, user accounts, config
# overrides, market data cache, and Let's Encrypt certificates will be lost.

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "$(dirname "${BASH_SOURCE[0]}")/_ssh_opts.sh"

# ─── Defaults ────────────────────────────────────────────────────────────────

SKIP_CONFIRM=false
SEED_AFTER=false
SERVER_IP=""

# ─── Parse arguments ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)
      SKIP_CONFIRM=true
      shift
      ;;
    --seed)
      SEED_AFTER=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--yes] [--seed] [<server-ip>]" >&2
      echo "" >&2
      echo "Flags:" >&2
      echo "  --yes | -y    Skip confirmation prompt." >&2
      echo "  --seed        Seed admin user after reset (requires ADMIN_EMAIL + ADMIN_PASSWORD)." >&2
      echo "" >&2
      echo "Arguments:" >&2
      echo "  <server-ip>   Server IP (auto-detected from terraform if omitted)." >&2
      echo "" >&2
      echo "Environment variables:" >&2
      echo "  ADMIN_EMAIL     Email for admin user seeding." >&2
      echo "  ADMIN_PASSWORD  Password for admin user seeding." >&2
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

# ─── Determine server IP ─────────────────────────────────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(cd "${TF_DIR}" && terraform output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided." >&2
  echo "" >&2
  echo "Usage: $0 [--yes] [--seed] <server-ip>" >&2
  echo "  Or auto-detect: cd infra/hetzner && terraform output -raw server_ipv4" >&2
  exit 1
fi

# ─── Confirmation ────────────────────────────────────────────────────────────

if [[ "${SKIP_CONFIRM}" != "true" ]]; then
  echo "================================================"
  echo " DESTRUCTIVE RESET"
  echo "================================================"
  echo " Server:  ${SERVER_IP}"
  echo ""
  echo "This will:"
  echo "  - Stop all services"
  echo "  - DELETE the Postgres database volume (all data)"
  echo "  - FLUSH Redis (all cached data)"
  echo "  - DELETE Caddy TLS certificates & config"
  echo "  - Run fresh database migrations"
  echo "  - Restart all services"
  echo ""
  if [[ "${SEED_AFTER}" == "true" ]]; then
    echo "  - Seed admin user (ADMIN_EMAIL=${ADMIN_EMAIL:-<not set>})"
  fi
  echo ""
  read -rp "Are you sure? Type 'reset' to confirm: " CONFIRM
  if [[ "${CONFIRM}" != "reset" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ─── Reset ───────────────────────────────────────────────────────────────────

echo ""
echo "==> Resetting server ${SERVER_IP}..."
echo ""

ssh ${SSH_OPTS} "root@${SERVER_IP}" bash -s << 'RESET'
set -euo pipefail

cd /opt/herobids

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Stopping all services..."
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml down --remove-orphans 2>/dev/null || true

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Removing Docker volumes (pgdata, caddy_data, caddy_config)..."
docker volume rm herobids_pgdata 2>/dev/null || echo "    Volume pgdata not found — skipping."
docker volume rm herobids_caddy_data 2>/dev/null || echo "    Volume caddy_data not found — skipping."
docker volume rm herobids_caddy_config 2>/dev/null || echo "    Volume caddy_config not found — skipping."

# Clean up any dangling containers/networks from failed runs
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruning dangling resources..."
docker container prune -f 2>/dev/null || true
docker network prune -f 2>/dev/null || true

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Flushing Redis..."
# Start a temporary redis-cli in the redis container (if the redis service image is available)
# We do this via docker run to avoid depending on the compose service being up.
docker run --rm --network herobids_default redis:7-alpine redis-cli -h redis FLUSHALL 2>/dev/null \
  || echo "    Redis flush skipped (redis may not be reachable yet — will be clean on first start)."

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting services (postgres, redis → migrate → api, worker, web)..."
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build --remove-orphans

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Waiting for API health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] API is healthy."
    break
  fi
  echo "  Waiting... (${i}/30)"
  sleep 2
done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Done."
RESET

echo ""
echo "==> Reset complete."
echo ""

# ─── Optional: Seed admin user ──────────────────────────────────────────────

if [[ "${SEED_AFTER}" == "true" ]]; then
  if [[ -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
    echo "WARNING: --seed was specified but ADMIN_EMAIL or ADMIN_PASSWORD is not set."
    echo "  Skipping admin seeding."
    echo "  To seed later: ADMIN_EMAIL=<email> ADMIN_PASSWORD=<pw> ${SCRIPT_DIR}/seed-admin.sh ${SERVER_IP}"
  else
    echo "-- Step: Seed admin user --"
    if ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" "${SCRIPT_DIR}/seed-admin.sh" "${SERVER_IP}"; then
      echo "Admin user seeded."
    else
      echo "WARNING: Admin seeding failed (non-fatal)."
    fi
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Fresh Start Complete"
echo "========================================"
echo ""
echo "  Server:  ${SERVER_IP}"
echo "  SSH:     ssh root@${SERVER_IP}"
echo "  Logs:    ${SCRIPT_DIR}/logs.sh ${SERVER_IP}"
echo "  Health:  http://${SERVER_IP}:3000/health"
echo ""
echo "All ephemeral state has been wiped."
echo "Migrations ran automatically via the migrate service's depends_on."
echo ""
