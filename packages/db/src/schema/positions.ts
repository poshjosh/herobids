import { pgTable, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Positions — current position state derived from fills.
 * Updated on each fill. Represents the current exposure.
 */
export const positions = pgTable('positions', {
  id: text('id').primaryKey(),               // UUIDv7
  tradingInstanceId: text('trading_instance_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),              // long | short | flat
  size: numeric('size').notNull(),
  entryPrice: numeric('entry_price').notNull(),
  /** Realized P&L for this position (accumulated from partial closes) */
  realizedPnl: numeric('realized_pnl').notNull().default('0'),
  /** Source of the canonical mark price used for P&L/risk: last_fill | oracle | ticker */
  markSource: text('mark_source'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_positions_trading_instance_id').on(t.tradingInstanceId),
  index('idx_positions_venue_account_id').on(t.venueAccountId),
  index('idx_positions_open').on(t.tradingInstanceId, t.closedAt),
]);
