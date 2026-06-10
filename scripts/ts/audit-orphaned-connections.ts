/**
 * audit-orphaned-connections.ts — Identifies trading provider connections that
 * have no associated trading binding (the hidden backfill has been removed).
 *
 * Run this BEFORE deploying the improved-connection-and-credential-handling
 * changes to production. For each orphaned connection listed, manually complete
 * trading setup via POST /setup/provider-link or notify the affected user.
 *
 * Usage (dry-run, read-only):
 *   DATABASE_URL=postgres://... tsx ts/audit-orphaned-connections.ts
 *
 * Exit codes:
 *   0 — no orphans found
 *   1 — one or more orphans found (or fatal error)
 */

import { createDatabase, connections, tradingBindings } from '@herobids/db';
import { eq, notExists, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const TRADING_PROVIDERS = ['hyperliquid', 'jupiter', '1inch', 'bybit'] as const;

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[audit-orphaned-connections] DATABASE_URL is required.');
    process.exit(1);
  }

  const db = createDatabase(databaseUrl);

  console.log('[audit-orphaned-connections] Scanning for trading connections without a binding...');
  console.log(`[audit-orphaned-connections] Providers checked: ${TRADING_PROVIDERS.join(', ')}`);

  // Find active trading-provider connections that have no trading_bindings row.
  const orphans = await db.execute<{
    connection_id: string;
    user_id: string;
    provider: string;
    label: string;
    status: string;
    created_at: string;
  }>(sql`
    SELECT
      c.id         AS connection_id,
      c.user_id,
      c.provider,
      c.label,
      c.status,
      c.created_at
    FROM connections c
    WHERE c.provider = ANY(ARRAY[${sql.raw(TRADING_PROVIDERS.map((p) => `'${p}'`).join(', '))}])
      AND c.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM trading_bindings tb
        WHERE tb.connection_id = c.id
      )
    ORDER BY c.created_at ASC
  `);

  const rows = orphans.rows ?? (orphans as unknown as typeof orphans.rows);

  if (!rows || rows.length === 0) {
    console.log('[audit-orphaned-connections] ✅  No orphaned connections found. Safe to deploy.');
    process.exit(0);
  }

  console.error(`[audit-orphaned-connections] ⚠️  Found ${rows.length} orphaned connection(s):`);
  console.error('');
  console.error('connection_id                          | user_id                               | provider    | label');
  console.error('---------------------------------------+---------------------------------------+-------------+------');
  for (const row of rows) {
    console.error(
      `${row.connection_id.padEnd(38)} | ${row.user_id.padEnd(38)} | ${row.provider.padEnd(12)} | ${row.label}`,
    );
  }
  console.error('');
  console.error('[audit-orphaned-connections] Action required before deploying:');
  console.error('  For each orphaned connection, either:');
  console.error('  1. Run POST /setup/provider-link with the user\'s secrets to create the missing binding, or');
  console.error('  2. Contact the affected user and ask them to complete trading setup from Mission Control.');
  console.error('');
  console.error('[audit-orphaned-connections] Re-run this script after remediation to confirm zero orphans.');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[audit-orphaned-connections] Fatal error:', err);
  process.exit(1);
});
