import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Journal events — append-only audit log.
 * Every significant event: decisions, risk rejections, order updates,
 * fills, balance changes, reconciliation events, credential access.
 * venueAccountId is NOT added here — it lives in the event payload for relevant types.
 */
export const journalEvents = pgTable('journal_events', {
  id: text('id').primaryKey(),               // UUIDv7
  // tradingInstanceId REMOVED — journal events are actor-scoped
  /** Actor type: agent | bot | user | system (nullable — some system events have no actor) */
  actorType: text('actor_type'),
  /** Stable identifier of the actor (nullable — null for system events) */
  actorId: text('actor_id'),
  /** Optional backtest run scope — null for live events */
  backtestRunId: text('backtest_run_id'),
  /** Event type, e.g. "decision.created", "order.filled", "risk.breach" */
  type: text('type').notNull(),
  /** Structured event payload (contains venueAccountId where relevant) */
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_journal_events_actor_id').on(t.actorId),
  index('idx_journal_events_type').on(t.type),
  index('idx_journal_events_created_at').on(t.createdAt),
  index('idx_journal_events_backtest_run_id').on(t.backtestRunId),
]);
