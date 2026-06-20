#!/usr/bin/env bash
# seed-admin.sh — Run the admin user seeding script against the production database.
#
# Creates or promotes a user to admin on the production server. The script is
# idempotent — safe to re-run against an existing admin user.
#
# Requires ADMIN_EMAIL and ADMIN_PASSWORD environment variables.
# DATABASE_URL is optional. If omitted, the script uses the API service's
# configured DATABASE_URL from docker compose.
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
      echo "  DATABASE_URL     Database connection string override (defaults to the API service DATABASE_URL)." >&2
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
  echo "  Or provide the IP directly:" >&2
  echo "    infra/hetzner/scripts/seed-admin.sh <server-ip>" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

# ─── Resolve DATABASE_URL ────────────────────────────────────────────────────

# When running inside the API container, postgres is at Docker hostname "postgres",
# not localhost. Only override if the caller explicitly sets DATABASE_URL.
if [[ -n "${DATABASE_URL:-}" ]]; then
  DB_URL="${DATABASE_URL}"
  DB_URL_B64="$(printf '%s' "${DB_URL}" | base64 | tr -d '\n')"
  PASS_DB_URL=1
else
  # Let the node script use the container's own DATABASE_URL (set by docker compose).
  PASS_DB_URL=0
fi

# ─── Run seed-admin on the server ────────────────────────────────────────────

echo "==> Seeding admin user (${ADMIN_EMAIL}) on ${SERVER_IP}..."

# Base64-encode sensitive values to avoid shell-escaping issues with special
# characters in passwords (spaces, quotes, dollar signs, etc.).
ADMIN_EMAIL_B64="$(printf '%s' "${ADMIN_EMAIL}" | base64 | tr -d '\n')"
ADMIN_PASSWORD_B64="$(printf '%s' "${ADMIN_PASSWORD}" | base64 | tr -d '\n')"

# Pipe the seed script into the running API service via docker compose exec.
# The API service has Node.js, @herobids/db, and drizzle-orm already installed.
ssh "root@${SERVER_IP}" bash -s -- "${ADMIN_EMAIL_B64}" "${ADMIN_PASSWORD_B64}" "${PASS_DB_URL}" "${DB_URL_B64:-}" << 'REMOTE'
set -euo pipefail

ADMIN_EMAIL_B64="$1"
ADMIN_PASSWORD_B64="$2"
PASS_DB_URL="$3"
DB_URL_B64="${4:-}"

cd /opt/herobids

DOCKER_EXEC_ARGS=(
  -T
  -e "ADMIN_EMAIL_B64=${ADMIN_EMAIL_B64}"
  -e "ADMIN_PASSWORD_B64=${ADMIN_PASSWORD_B64}"
)
if [[ "${PASS_DB_URL}" -eq 1 ]]; then
  DOCKER_EXEC_ARGS+=( -e "DB_URL_B64=${DB_URL_B64}" )
fi

docker compose -f docker-compose.yaml -f docker-compose.prod.yaml exec \
  "${DOCKER_EXEC_ARGS[@]}" \
  api node --input-type=module << 'NODESCRIPT'
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createDatabase, closeDatabase, users, localIdentities, userPlans } from '@herobids/db';
import { eq } from 'drizzle-orm';

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

const adminEmail = Buffer.from(process.env.ADMIN_EMAIL_B64, 'base64').toString('utf-8');
const adminPassword = Buffer.from(process.env.ADMIN_PASSWORD_B64, 'base64').toString('utf-8');
// Use caller-supplied DB_URL_B64 if given, otherwise fall back to the container's DATABASE_URL.
const databaseUrl = process.env.DB_URL_B64
  ? Buffer.from(process.env.DB_URL_B64, 'base64').toString('utf-8')
  : process.env.DATABASE_URL;
const planId = 'free';

if (!adminEmail) {
  console.log('[seed-admin] ADMIN_EMAIL not set — skipping admin user seeding.');
  process.exit(0);
}

if (!adminPassword) {
  console.error('[seed-admin] ADMIN_PASSWORD is required when ADMIN_EMAIL is set.');
  process.exit(1);
}

if (!databaseUrl) {
  console.error('[seed-admin] DATABASE_URL is required.');
  process.exit(1);
}

const db = createDatabase(databaseUrl);
try {
  const normalizedEmail = adminEmail.toLowerCase().trim();
  const now = new Date();
  const passwordHash = await hashPassword(adminPassword);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  const userId = existing?.id ?? crypto.randomUUID();

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(users)
        .set({ isAdmin: true, updatedAt: now })
        .where(eq(users.id, userId));
    } else {
      await tx.insert(users).values({
        id: userId,
        displayName: 'Admin',
        email: normalizedEmail,
        avatarUrl: null,
        planId,
        isAdmin: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [existingPlanHistory] = await tx
      .select({ id: userPlans.id })
      .from(userPlans)
      .where(eq(userPlans.userId, userId))
      .limit(1);

    await tx.insert(localIdentities).values({
      id: crypto.randomUUID(),
      userId,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: localIdentities.userId,
      set: { passwordHash, updatedAt: now },
    });

    if (!existingPlanHistory) {
      await tx.insert(userPlans).values({
        id: crypto.randomUUID(),
        userId,
        planId,
      });
    }
  });

  const verb = existing ? 'Updated' : 'Created';
  console.log(`[seed-admin] ${verb} admin user: ${normalizedEmail}`);
} finally {
  await closeDatabase(db);
}
NODESCRIPT
REMOTE

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "==> Admin seeding complete."
echo "    User:  ${ADMIN_EMAIL}"
echo "    Server: ${SERVER_IP}"
