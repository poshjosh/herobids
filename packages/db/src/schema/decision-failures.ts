import { pgTable, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';

/**
 * decision_failures — durable dead-letter ledger for rejected or thrown decisions.
 * Provides operators with queryable evidence of what failed, where, and why.
 */
export const decisionFailures = pgTable('decision_failures', {
  id: text('id').primaryKey(),
  /** Actor type: agent | bot */
  actorType: text('actor_type').notNull(),
  /** Actor ID (agent or bot) */
  actorId: text('actor_id').notNull(),
  /** Decision ID when available */
  decisionId: text('decision_id'),
  /** Instrument/symbol where available */
  instrumentId: text('instrument_id'),
  /** Venue name where available */
  venue: text('venue'),
  /** Venue account ID where available */
  venueAccountId: text('venue_account_id'),
  /** Machine-readable failure code (dot-namespaced) */
  failureCode: text('failure_code').notNull(),
  /** Human-readable failure message */
  failureMessage: text('failure_message').notNull(),
  /** Failure class: rejection (handled), error (unhandled throw) */
  failureClass: text('failure_class').notNull(),
  /** Whether this failure is retryable */
  retryable: boolean('retryable').notNull().default(false),
  /** Structured failure details/context */
  details: jsonb('details').$type<Record<string, unknown> | null>(),
  /** Timestamp of the failure */
  failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_decision_failures_actor').on(t.actorType, t.actorId),
  index('idx_decision_failures_failed_at').on(t.failedAt),
]);
