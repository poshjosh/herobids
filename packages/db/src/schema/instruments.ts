import { pgTable, text, timestamp, numeric, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Instruments — canonical instrument registry.
 * One row per tradable instrument per venue.
 */
export const instruments = pgTable('instruments', {
  id: text('id').primaryKey(),               // UUIDv7
  symbol: text('symbol').notNull(),          // e.g. "BTC/USD:USD"
  venue: text('venue').notNull(),            // e.g. "hyperliquid"
  type: text('type').notNull(),              // "perp" | "spot" | "future"
  base: text('base').notNull(),              // e.g. "BTC"
  quote: text('quote').notNull(),            // e.g. "USD"
  tickSize: numeric('tick_size').notNull(),
  lotSize: numeric('lot_size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('idx_instruments_venue_symbol').on(t.venue, t.symbol),
]);
