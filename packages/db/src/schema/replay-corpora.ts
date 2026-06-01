import { pgTable, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Replay corpora — metadata about a collection of market events for replay.
 * A corpus is a window of market data for one or more symbols.
 */
export const replayCorpora = pgTable('replay_corpora', {
  id: text('id').primaryKey(),
  /** Owner user ID (nullable for legacy corpora) */
  userId: text('user_id').references(() => users.id),
  /** Human-readable name */
  name: text('name').notNull(),
  /** Source description (e.g. "live-recording", "csv-import:btc-2025-q4") */
  source: text('source').notNull(),
  venue: text('venue').notNull(),
  /** Comma-separated symbols in this corpus */
  symbols: text('symbols').notNull(),
  /** Corpus format version for forward-compatibility */
  formatVersion: integer('format_version').notNull().default(1),
  /** Optional metadata */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  /** First event timestamp in the corpus */
  startAt: timestamp('start_at', { withTimezone: true }),
  /** Last event timestamp in the corpus */
  endAt: timestamp('end_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_replay_corpora_venue').on(t.venue),
]);
