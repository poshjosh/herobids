/**
 * audit-orphaned-connections.ts — Lists all trading provider connections
 * for audit purposes (the trading_bindings table has been removed).
 *
 * Usage (dry-run, read-only):
 *   DATABASE_URL=postgres://... tsx ts/audit-orphaned-connections.ts
 *
 * Exit codes:
 *   0 — no issues found
 *   1 — one or more connections found (or fatal error)
 */

import { createDatabase, connections } from '@herobids/db';
import { sql } from 'drizzle-orm';

const TRADING_PROVIDERS = ['hyperliquid', 'jupiter', '1inch', 'bybit'] as const;

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[audit-orphaned-connections] DATABASE_URL is required.');
    process.exit(1);
  }

  const db = createDatabase(databaseUrl);

  console.log('[audit-orphaned-connections] Listing trading connections...');
  console.log(`[audit-orphaned-connections] Providers checked: ${TRADING_PROVIDERS.join(', ')}`);

  // List active trading-provider connections.
  const results = await db.execute<{
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
    ORDER BY c.created_at ASC
  `);

  const rows = results.rows ?? (results as unknown as typeof results.rows);

  if (!rows || rows.length === 0) {
    console.log('[audit-orphaned-connections] ✅  No trading connections found.');
    process.exit(0);
  }

  console.log(`[audit-orphaned-connections] Found ${rows.length} trading connection(s):`);
  console.log('');
  console.log('connection_id                          | user_id                               | provider    | label');
  console.log('---------------------------------------+---------------------------------------+-------------+------');
  for (const row of rows) {
    console.log(
      `${row.connection_id.padEnd(38)} | ${row.user_id.padEnd(38)} | ${row.provider.padEnd(12)} | ${row.label}`,
    );
  }
  console.log('');
  console.log('[audit-orphaned-connections] Connections listed. No orphan checks needed — trading_bindings table has been removed.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[audit-orphaned-connections] Fatal error:', err);
  process.exit(1);
});
