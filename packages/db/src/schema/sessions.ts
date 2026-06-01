import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Sessions — tracks active user sessions (JWT references).
 * Used for session revocation and optional server-side tracking.
 */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),               // UUIDv7 (= JWT jti claim)
  userId: text('user_id').notNull().references(() => users.id),
  /** When the session/token expires */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** When the session was revoked (null = active) */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_sessions_user_id').on(t.userId),
  index('idx_sessions_expires_at').on(t.expiresAt),
]);
