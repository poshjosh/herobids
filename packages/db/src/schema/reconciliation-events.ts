import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Reconciliation events — structured records of each reconciliation pass.
 * Reconciliation is venue-account-scoped (the venue sees one account, not one bot).
 */
export const reconciliationEvents = pgTable('reconciliation_events', {
  id: text('id').primaryKey(),               // UUIDv7
  // tradingInstanceId REMOVED — reconciliation is venue-account-scoped, not actor-scoped
  venueAccountId: text('venue_account_id').notNull(),
  /** Result of the reconciliation pass: match | drift_detected | repaired */
  result: text('result').notNull(),
  /** Snapshot of local state at reconciliation time */
  localState: jsonb('local_state').notNull().$type<Record<string, unknown>>(),
  /** Snapshot of venue state at reconciliation time */
  venueState: jsonb('venue_state').notNull().$type<Record<string, unknown>>(),
  /** Detected differences (empty array if match) */
  diff: jsonb('diff').notNull().$type<Array<Record<string, unknown>>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_reconciliation_events_venue_account_id').on(t.venueAccountId),
  index('idx_reconciliation_events_created_at').on(t.createdAt),
  index('idx_reconciliation_events_result').on(t.result),
]);
