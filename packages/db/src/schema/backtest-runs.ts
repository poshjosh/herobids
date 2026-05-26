import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Backtest runs — bounded replay jobs.
 * Each row tracks a single backtest execution: config, status, and results.
 */
export const backtestRuns = pgTable('backtest_runs', {
  id: text('id').primaryKey(),
  /** Strategy type used for this run */
  strategyType: text('strategy_type').notNull(),
  /** Full config snapshot at run creation time */
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  /** Corpus ID (source data) */
  corpusId: text('corpus_id'),
  /** Venue */
  venue: text('venue').notNull(),
  /** Symbol */
  symbol: text('symbol').notNull(),
  /** Run status */
  status: text('status').notNull().default('pending'), // pending | running | completed | failed
  /** Summary metrics (filled on completion) */
  metrics: jsonb('metrics').$type<Record<string, unknown>>(),
  /** Error payload (filled on failure) */
  error: jsonb('error').$type<{ message: string; stack?: string }>(),
  /** Started at */
  startedAt: timestamp('started_at', { withTimezone: true }),
  /** Completed at */
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_backtest_runs_status').on(t.status),
  index('idx_backtest_runs_strategy_type').on(t.strategyType),
  index('idx_backtest_runs_created_at').on(t.createdAt),
]);
