import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Local identities — email + password credentials for users who register
 * without an OAuth provider.  One row per user maximum (enforced by unique index).
 */
export const localIdentities = pgTable('local_identities', {
  id: text('id').primaryKey(),                // UUIDv4
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** scrypt-derived hash stored as "salt:hash" (both hex-encoded) */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('idx_local_identities_user_id').on(t.userId),
]);
