/**
 * apply-db-squash-fixup.ts — registers the squashed baseline migration hash for
 * existing databases before the new `0001_add_preferred_locale` migration runs.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @herobids/scripts exec tsx ts/apply-db-squash-fixup.ts
 *
 * The helper is idempotent. It only inserts the `0000_baseline` migration hash
 * into drizzle.__drizzle_migrations when it is missing.
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[db-squash-fixup] DATABASE_URL is required.');
    process.exit(1);
  }

  const baselineSql = readFileSync(new URL('../../packages/db/drizzle/0000_baseline.sql', import.meta.url), 'utf8');
  const journal = JSON.parse(
    readFileSync(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: JournalEntry[] };
  const baselineEntry = journal.entries.find((entry) => entry.tag === '0000_baseline');

  if (!baselineEntry) {
    throw new Error('Could not locate the 0000_baseline entry in the Drizzle journal.');
  }

  const baselineHash = crypto.createHash('sha256').update(baselineSql).digest('hex');
  const client = postgres(databaseUrl, { max: 1 });

  try {
    await client`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${baselineHash}, ${baselineEntry.when})
      ON CONFLICT (hash) DO NOTHING
    `;

    console.log(`[db-squash-fixup] Registered baseline hash ${baselineHash}.`);
    console.log('[db-squash-fixup] Next step: pnpm --filter @herobids/db run db:migrate');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[db-squash-fixup] Fatal error:', error);
  process.exit(1);
});