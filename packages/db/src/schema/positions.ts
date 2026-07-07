import { pgTable, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Positions — current position state derived from fills.
 * Updated on each fill. Represents the current exposure.
 */
export const positions = pgTable('positions', {
  id: text('id').primaryKey(),               // UUIDv7
  // tradingInstanceId REMOVED — positions are actor-scoped via actorType/actorId
  venueAccountId: text('venue_account_id').notNull(),
  /** Actor type: agent | bot | user | system */
  actorType: text('actor_type').notNull().default('system'),
  /** Stable identifier of the actor holding this position */
  actorId: text('actor_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  /** Canonical instrument ID from the venue's instrument repository (e.g. "BTC-USD" on Hyperliquid).
   *  Nullable — populated when the venue adapter provides it. Falls back to symbol for positionKey derivation. */
  instrumentId: text('instrument_id'),
  side: text('side').notNull(),              // long | short | flat
  size: numeric('size').notNull(),
  entryPrice: numeric('entry_price').notNull(),
  /** Realized P&L for this position (accumulated from partial closes) */
  realizedPnl: numeric('realized_pnl').notNull().default('0'),
  /** Source of the canonical mark price used for P&L/risk: last_fill | oracle | ticker */
  markSource: text('mark_source'),
  /** Reason the position was closed (null for open positions or unknown closes).
   *  Values: signal_lost | parabolic_move | daily_limit_reached | sentiment_suppressed |
   *          stop_loss | manual | limit_order_timeout | market_order_timeout | etc. */
  exitReason: text('exit_reason'),
  /** Per-trade stop-loss price level set at entry. Nullable — not all trades carry levels. */
  stopLoss: numeric('stop_loss'),
  /** Per-trade take-profit price level set at entry. Nullable — not all trades carry levels. */
  takeProfit: numeric('take_profit'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_positions_venue_account_id').on(t.venueAccountId),
  // Per-actor query: "what positions does this agent/bot hold?"
  index('idx_positions_actor').on(t.actorType, t.actorId),
  // Risk gate query: "total exposure for (venueAccount, symbol) across ALL actors"
  index('idx_positions_venue_symbol').on(t.venueAccountId, t.symbol),
]);
