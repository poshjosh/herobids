import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Journal events — append-only audit log.
 * Every significant event: decisions, risk rejections, order updates,
 * fills, balance changes, reconciliation events, credential access.
 */
export const journalEvents = pgTable('journal_events', {
  id: text('id').primaryKey(),               // UUIDv7
  tradingInstanceId: text('trading_instance_id'),
  /** Optional backtest run scope — null for live events */
  backtestRunId: text('backtest_run_id'),
  /** Event type, e.g. "decision.created", "order.filled", "risk.breach" */
  type: text('type').notNull(),
  /** Structured event payload */
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_journal_events_trading_instance_id').on(t.tradingInstanceId),
  index('idx_journal_events_type').on(t.type),
  index('idx_journal_events_created_at').on(t.createdAt),
  index('idx_journal_events_backtest_run_id').on(t.backtestRunId),
]);
