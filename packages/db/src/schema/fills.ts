import { pgTable, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Fills — immutable fill records.
 * One order → many fills. Never mutated after insert.
 */
export const fills = pgTable('fills', {
  id: text('id').primaryKey(),               // UUIDv7
  orderId: text('order_id').notNull(),
  tradingInstanceId: text('trading_instance_id').notNull(),
  /** Venue's fill/trade ID */
  venueRefId: text('venue_ref_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),              // buy | sell
  quantity: numeric('quantity').notNull(),
  price: numeric('price').notNull(),
  /** Fee paid */
  fee: numeric('fee'),
  /** Fee currency */
  feeCurrency: text('fee_currency'),
  filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_fills_order_id').on(t.orderId),
  index('idx_fills_trading_instance_id').on(t.tradingInstanceId),
  index('idx_fills_filled_at').on(t.filledAt),
]);
