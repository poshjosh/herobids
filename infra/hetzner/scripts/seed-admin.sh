#!/usr/bin/env bash
# seed-admin.sh — Run the admin user seeding script against the production database.
#
# Creates or promotes a user to admin on the production server. The script is
# idempotent — safe to re-run against an existing admin user.
#
# Requires ADMIN_EMAIL and ADMIN_PASSWORD environment variables.
# DATABASE_URL defaults to the docker-compose.yaml value (postgres://herobids:herobids@localhost:5432/herobids)
# but can be overridden via the DATABASE_URL env var.
#
# Usage:
#   infra/hetzner/scripts/seed-admin.sh [<server-ip>]
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme ./seed-admin.sh
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme ./seed-admin.sh 1.2.3.4
#   DATABASE_URL=postgres://... ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme ./seed-admin.sh
#
# Examples:
#   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=super-secret ./seed-admin.sh
#   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=super-secret ./seed-admin.sh 1.2.3.4

set -euo pipefail

# Escape a value for safe embedding inside single-quoted shell strings.
# Replaces each ' with '\'' (end-quote, escaped-quote, restart-quote).
_esc() { printf '%s' "${1//\'/\'\\\'\'}"; }

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"

# ─── Parse arguments ─────────────────────────────────────────────────────────

SERVER_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 [<server-ip>]" >&2
      echo "" >&2
      echo "Required environment variables:" >&2
      echo "  ADMIN_EMAIL      Email of the user to create/promote to admin." >&2
      echo "  ADMIN_PASSWORD   Password for the admin user." >&2
      echo "" >&2
      echo "Optional environment variables:" >&2
      echo "  DATABASE_URL     Database connection string (defaults to docker-compose value)." >&2
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

# ─── Validate required env vars ──────────────────────────────────────────────

if [[ -z "${ADMIN_EMAIL:-}" ]]; then
  echo "ERROR: ADMIN_EMAIL environment variable is not set." >&2
  echo "" >&2
  echo "Usage: ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> $0 [<server-ip>]" >&2
  exit 1
fi

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ERROR: ADMIN_PASSWORD environment variable is not set." >&2
  echo "" >&2
  echo "Usage: ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> $0 [<server-ip>]" >&2
  exit 1
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
  echo "Usage: $0 [<server-ip>]" >&2
  echo "  Or run from the terraform directory to auto-detect:" >&2
  echo "    cd infra/hetzner && terraform output -raw server_ipv4" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

# ─── Resolve DATABASE_URL ────────────────────────────────────────────────────

# Default matches docker-compose.yaml: postgres://herobids:herobids@localhost:5432/herobids
# Allow override via DATABASE_URL env var.
DB_URL="${DATABASE_URL:-postgres://herobids:herobids@localhost:5432/herobids}"

# ─── Run seed-admin on the server ────────────────────────────────────────────

echo "==> Seeding admin user (${ADMIN_EMAIL}) on ${SERVER_IP}..."

# Use _esc to safely embed credential values inside single-quoted strings.
ssh "root@${SERVER_IP}" \
  "cd /opt/herobids && ADMIN_EMAIL='$(_esc "${ADMIN_EMAIL}")' ADMIN_PASSWORD='$(_esc "${ADMIN_PASSWORD}")' DATABASE_URL='$(_esc "${DB_URL}")' pnpm exec tsx scripts/ts/seed-admin.ts"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "==> Admin seeding complete."
echo "    User:  ${ADMIN_EMAIL}"
echo "    Server: ${SERVER_IP}"
