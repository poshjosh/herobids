import { pgTable, text, timestamp, numeric, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Replay market events — append-only normalized market data for backtesting.
 * Each row is a single point-in-time observation keyed by corpus.
 */
export const replayMarketEvents = pgTable('replay_market_events', {
  id: text('id').primaryKey(),
  corpusId: text('corpus_id').notNull(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  /** Event type: ticker, trade, candle, mark */
  eventType: text('event_type').notNull(),
  /** Price at this point in time */
  price: numeric('price').notNull(),
  /** ISO 8601 event timestamp */
  eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
  /** Optional additional structured data (bid/ask spread, volume, OHLC, etc.) */
  data: jsonb('data').$type<Record<string, unknown>>(),
}, (t) => [
  index('idx_replay_market_events_corpus_symbol_time').on(t.corpusId, t.symbol, t.eventAt),
  index('idx_replay_market_events_corpus_type').on(t.corpusId, t.eventType),
]);
