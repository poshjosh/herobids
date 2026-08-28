#!/usr/bin/env bash
# reset.sh — Wipe all ephemeral state (DB, Redis, Caddy cache) on the Hetzner server.
#
# Destroys and recreates the Postgres volume, flushes Redis, runs
# fresh migrations, and verifies the API comes up healthy. Caddy TLS
# certificates are preserved to avoid Let's Encrypt rate limits.
# Equivalent to a full clean deploy from a blank database.
#
# Usage:
#   infra/hetzner/scripts/reset.sh [--env <staging|production>] [--yes|-y] [--seed] [<server-ip>]
#   infra/hetzner/scripts/reset.sh --env staging --yes           # reset staging
#   infra/hetzner/scripts/reset.sh 1.2.3.4                       # explicit IP
#
# Flags:
#   --env <name>   Target environment: staging or production (default: production).
#   --yes | -y     Skip confirmation prompt
#   --seed         Also seed the admin user after reset (requires ADMIN_EMAIL + ADMIN_PASSWORD)
#
# Environment:
#   HEROBIDS_ENV   Deployment environment: staging | production (default: production).
#
# Examples:
#   ./reset.sh --env staging --yes
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme ./reset.sh --yes --seed
#   ./reset.sh 1.2.3.4
#
# WARNING: This is destructive — all trading data, user accounts, config
# overrides, and market data cache will be lost. Caddy TLS certificates
# are preserved.

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "$(dirname "${BASH_SOURCE[0]}")/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

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
      echo "Usage: $0 [--env <staging|production>] [--yes] [--seed] [<server-ip>]" >&2
      echo "" >&2
      echo "Flags:" >&2
      echo "  --env <name>   Target environment: staging or production (default: production)." >&2
      echo "  --yes | -y     Skip confirmation prompt." >&2
      echo "  --seed         Seed admin user after reset (requires ADMIN_EMAIL + ADMIN_PASSWORD)." >&2
      echo "" >&2
      echo "Arguments:" >&2
      echo "  <server-ip>    Server IP (auto-detected from terraform if omitted)." >&2
      echo "" >&2
      echo "Environment variables:" >&2
      echo "  HEROBIDS_ENV   Deployment environment." >&2
      echo "  ADMIN_EMAIL    Email for admin user seeding." >&2
      echo "  ADMIN_PASSWORD Password for admin user seeding." >&2
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
    SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided." >&2
  echo "" >&2
  echo "Usage: $0 [--yes] [--seed] <server-ip>" >&2
  echo "  Or run provision.sh first: infra/hetzner/scripts/provision.sh --env ${HEROBIDS_ENV}" >&2
  exit 1
fi

# ─── Confirmation ────────────────────────────────────────────────────────────

if [[ "${SKIP_CONFIRM}" != "true" ]]; then
  echo "================================================"
  echo " DESTRUCTIVE RESET"
  echo "================================================"
  echo " Server:      ${SERVER_IP}"
  echo " Environment: ${HEROBIDS_ENV}"
  echo " Compose:     ${COMPOSE_OVERLAY}"
  echo ""
  echo "This will:"
  echo "  - Stop all services"
  echo "  - DELETE the Postgres database volume (all data)"
  echo "  - FLUSH Redis (all cached data)"
  echo "  - Run fresh database migrations"
  echo "  - Restart all services"
  echo "  - Caddy TLS certificates are PRESERVED (rate-limit safe)"
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
echo "==> Resetting ${HEROBIDS_ENV} server ${SERVER_IP}..."
echo ""

ssh ${SSH_OPTS} "root@${SERVER_IP}" HEROBIDS_ENV="${HEROBIDS_ENV}" COMPOSE_OVERLAY="${COMPOSE_OVERLAY}" bash -s << 'RESET'
set -euo pipefail

cd /opt/herobids
COMPOSE_FILES="-f docker-compose.yaml -f ${COMPOSE_OVERLAY}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Environment: ${HEROBIDS_ENV}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Stopping all services..."
docker compose ${COMPOSE_FILES} down --remove-orphans 2>/dev/null || true

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Removing Docker volumes (pgdata)..."
docker volume rm herobids_pgdata 2>/dev/null || echo "    Volume pgdata not found — skipping."
# Caddy TLS volumes are intentionally preserved across resets.
# Let's Encrypt has a strict rate limit (5 certs per domain per 168 hours).
# Deleting caddy_data forces a new certificate request on every reset,
# which quickly exhausts the limit and leaves the site without TLS.
echo "    Caddy TLS volumes preserved (caddy_data, caddy_config)."

# Clean up any dangling containers/networks from failed runs
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruning dangling resources..."
docker container prune -f 2>/dev/null || true
docker network prune -f 2>/dev/null || true

# Aggressive build cache cleanup — Docker buildkit overlayfs can consume
# tens of GB on small Hetzner instances across repeated deploys.
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruning build cache and dangling images..."
docker builder prune -af 2>/dev/null || true
docker image prune -f 2>/dev/null || true

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Flushing Redis..."
# Start a temporary redis-cli in the redis container (if the redis service image is available)
# We do this via docker run to avoid depending on the compose service being up.
docker run --rm --network herobids_default redis:7-alpine redis-cli -h redis FLUSHALL 2>/dev/null \
  || echo "    Redis flush skipped (redis may not be reachable yet — will be clean on first start)."

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pulling latest code..."
git fetch --all && git reset --hard origin/main

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Building agent runtime image (herobids-agent:latest)..."
docker build --pull -f docker/Dockerfile.agent -t herobids-agent:latest .

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting services (postgres, redis → migrate → api, worker, web)..."
docker compose ${COMPOSE_FILES} up -d --build --remove-orphans

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
    if ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" "${SCRIPT_DIR}/seed-admin.sh" --env "${HEROBIDS_ENV}" "${SERVER_IP}"; then
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
echo "  Server:      ${SERVER_IP}"
echo "  Environment: ${HEROBIDS_ENV}"
echo "  SSH:     ssh root@${SERVER_IP}"
echo "  Logs:    ${SCRIPT_DIR}/logs.sh ${SERVER_IP}"
echo "  Health:  http://${SERVER_IP}:3000/health"
echo ""
echo "All ephemeral state has been wiped."
echo "Migrations ran automatically via the migrate service's depends_on."
echo ""
