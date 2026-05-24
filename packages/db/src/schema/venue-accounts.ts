import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Venue accounts — user's authenticated sessions on venues.
 * Each represents one wallet or exchange subaccount.
 */
export const venueAccounts = pgTable('venue_accounts', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull(),
  venue: text('venue').notNull(),            // e.g. "hyperliquid"
  /** Display label, e.g. "My Hyperliquid Main" */
  label: text('label').notNull(),
  /** Venue-specific identifier (subaccount ID, wallet address, etc.) */
  venueAccountRef: text('venue_account_ref'),
  /** Reference to credentials row */
  credentialId: text('credential_id'),
  /** Timestamp of last successful reconciliation pass (cursor) */
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_venue_accounts_user_id').on(t.userId),
]);
