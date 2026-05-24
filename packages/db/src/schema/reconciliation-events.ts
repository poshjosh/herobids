import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Reconciliation events — structured records of each reconciliation pass.
 * Written alongside journal_events for queryability.
 */
export const reconciliationEvents = pgTable('reconciliation_events', {
  id: text('id').primaryKey(),               // UUIDv7
  tradingInstanceId: text('trading_instance_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  /** Result of the reconciliation pass */
  result: text('result').notNull(),          // match | drift_detected | repaired
  /** Snapshot of local state at reconciliation time */
  localState: jsonb('local_state').notNull().$type<Record<string, unknown>>(),
  /** Snapshot of venue state at reconciliation time */
  venueState: jsonb('venue_state').notNull().$type<Record<string, unknown>>(),
  /** Detected differences (empty array if match) */
  diff: jsonb('diff').notNull().$type<Array<Record<string, unknown>>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_reconciliation_events_trading_instance_id').on(t.tradingInstanceId),
  index('idx_reconciliation_events_venue_account_id').on(t.venueAccountId),
  index('idx_reconciliation_events_created_at').on(t.createdAt),
  index('idx_reconciliation_events_result').on(t.result),
]);
