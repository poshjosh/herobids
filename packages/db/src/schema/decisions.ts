import { pgTable, text, timestamp, numeric, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Decisions — every strategy output, for audit and replay.
 * Append-only. Never mutated after insert.
 */
export const decisions = pgTable('decisions', {
  id: text('id').primaryKey(),               // UUIDv7
  tradingInstanceId: text('trading_instance_id').notNull(),
  instrumentId: text('instrument_id').notNull(),
  intent: text('intent').notNull(),          // go_long | go_short | go_flat | increase | decrease
  targetSize: numeric('target_size').notNull(),
  limitPrice: numeric('limit_price'),
  /** Hash of the context (market snapshot) that produced this decision */
  contextHash: text('context_hash'),
  /** Freeform metadata from strategy */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_decisions_trading_instance_id').on(t.tradingInstanceId),
  index('idx_decisions_created_at').on(t.createdAt),
]);
