/**
 * Regression: bug 2026-05-31-003 — Crashed instances blocked starting a new bot
 * on the same venue account via a partial unique index:
 *
 *   CREATE UNIQUE INDEX uq_trading_instances_active_venue_account
 *     ON bots (venue_account_id)
 *     WHERE status <> 'stopped';
 *
 * When a bot crashed, its status remained non-stopped, so the slot was held
 * permanently and no new bot could start on that venue account.
 *
 * Fix: the partial unique index was removed from the schema entirely.
 * Enforcement is now a soft runtime broker check (maxBots per agent, configurable).
 *
 * This test verifies the schema source does not re-introduce the constraint.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schemaSource = readFileSync(
  resolve(new URL(import.meta.url).pathname, '../bots.ts'),
  'utf-8',
);

describe('bots schema — removed unique index (bug 2026-05-31-003 regression)', () => {
  it('does not import uniqueIndex from drizzle-orm/pg-core', () => {
    // If uniqueIndex were re-imported, the partial unique constraint could be
    // re-introduced, which would block starts when a crashed bot exists.
    expect(schemaSource).not.toContain('uniqueIndex');
  });

  it('documents the removal of uq_trading_instances_active_venue_account with REMOVED marker', () => {
    // The comment must say REMOVED — this ensures any future attempt to re-add
    // the constraint requires deleting the comment, making the change deliberate.
    expect(schemaSource).toContain('uq_trading_instances_active_venue_account REMOVED');
  });

  it('only uses non-unique index() on venueAccountId', () => {
    // Verify the venueAccountId column has only a regular (non-unique) index.
    // Unique indexes on this column would prevent multiple bots on the same account.
    expect(schemaSource).toContain("index('idx_bots_venue_account_id').on(t.venueAccountId)");
  });
});
