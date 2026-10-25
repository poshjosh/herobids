import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Chat suppressions: a platform-wide opt-out for one address on one provider.
 *
 * No foreign keys, so a block outlives the user or agent that held the address and cannot be
 * lifted by deleting or re-pointing an account. A row blocks outbound sends and inbound routing
 * for the exact (provider, address).
 */
export const chatSuppressions = pgTable('chat_suppressions', {
  /** telegram | whatsapp | sms */
  provider: text('provider').notNull(),
  /** Normalised provider address (trimmed; E.164 for phone-based providers) */
  address: text('address').notNull(),
  /** revoked | pending_optin */
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The composite key is the unique (provider, address) constraint.
  primaryKey({ name: 'chat_suppressions_provider_address_pk', columns: [t.provider, t.address] }),
]);
