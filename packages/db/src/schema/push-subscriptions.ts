import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Web Push subscriptions (080, 081 W3): one row per browser or device endpoint.
 * The endpoint is a bearer credential. Never log it in full.
 * Opt-in equals an active row (revoked_at is null). 404/410 from a push service revokes the row.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Push service URL for this browser subscription */
  endpoint: text('endpoint').notNull(),
  /** Client public key (P-256, base64url) */
  p256dh: text('p256dh').notNull(),
  /** Client auth secret (base64url) */
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /** Recorded on every failed push, so an email fallback can see "every push failed" (081 D10). */
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  /** Dot-string error code of the last failure, for example notification.provider_failed */
  lastFailureCode: text('last_failure_code'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  unique('uq_push_subscriptions_endpoint').on(t.endpoint),
  index('idx_push_subscriptions_user_id').on(t.userId),
]);
