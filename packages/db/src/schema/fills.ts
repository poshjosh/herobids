import { pgTable, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Fills — immutable fill records.
 * One order → many fills. Never mutated after insert.
 */
export const fills = pgTable('fills', {
  id: text('id').primaryKey(),               // UUIDv7
  orderId: text('order_id').notNull(),
  // tradingInstanceId REMOVED — fills are actor-scoped via actorType/actorId
  /** Venue account this fill belongs to */
  venueAccountId: text('venue_account_id').notNull(),
  /** Actor type: agent | bot | user | system */
  actorType: text('actor_type').notNull().default('system'),
  /** Stable identifier of the actor */
  actorId: text('actor_id'),
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
  /** Realized P&L delta for this fill (position P&L minus fee). Computed at write time. */
  realizedPnlDelta: numeric('realized_pnl_delta'),
  filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_fills_order_id').on(t.orderId),
  index('idx_fills_venue_account_id').on(t.venueAccountId),
  index('idx_fills_actor_id').on(t.actorId),
  index('idx_fills_filled_at').on(t.filledAt),
]);
