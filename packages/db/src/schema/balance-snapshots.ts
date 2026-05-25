import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Balance snapshots — periodic snapshots of venue account balances.
 * Used for P&L calculation and reconciliation.
 */
export const balanceSnapshots = pgTable('balance_snapshots', {
  id: text('id').primaryKey(),               // UUIDv7
  venueAccountId: text('venue_account_id').notNull(),
  venue: text('venue').notNull(),
  /** Full balance snapshot as JSON */
  balances: jsonb('balances').notNull().$type<Array<{ asset: string; free: string; locked: string; total: string }>>(),
  /** Source of the canonical mark price used for P&L/risk: last_fill | oracle | ticker */
  markSource: text('mark_source'),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_balance_snapshots_venue_account_id').on(t.venueAccountId),
  index('idx_balance_snapshots_snapshot_at').on(t.snapshotAt),
]);
