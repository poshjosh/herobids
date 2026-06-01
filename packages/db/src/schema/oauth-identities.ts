import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * OAuth identities — links external OAuth providers to local users.
 * Supports multiple providers per user in the future.
 */
export const oauthIdentities = pgTable('oauth_identities', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  /** OAuth provider name: "google" */
  provider: text('provider').notNull(),
  /** Provider-specific user ID (sub claim) */
  providerUserId: text('provider_user_id').notNull(),
  /** Provider email (for display/debugging) */
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_oauth_identities_user_id').on(t.userId),
  // Unique constraint: one identity row per (provider, providerUserId) — no duplicates on concurrent first-login
  uniqueIndex('uq_oauth_identities_provider_user_id').on(t.provider, t.providerUserId),
]);
