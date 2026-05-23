import { pgTable, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Orders — mutable order lifecycle records (state machine).
 * Status transitions: pending → open → partial → filled / cancelled / rejected
 */
export const orders = pgTable('orders', {
  id: text('id').primaryKey(),               // UUIDv7
  tradingInstanceId: text('trading_instance_id').notNull(),
  executionPlanId: text('execution_plan_id'),
  /** Venue's own reference ID for reconciliation */
  venueRefId: text('venue_ref_id'),
  /** Client-generated ID for idempotency */
  clientOrderId: text('client_order_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),              // buy | sell
  type: text('type').notNull(),              // market | limit | stop_market | stop_limit
  quantity: numeric('quantity').notNull(),
  price: numeric('price'),
  /** Current order status */
  status: text('status').notNull().default('pending'),
  /** Quantity filled so far */
  filledQuantity: numeric('filled_quantity').notNull().default('0'),
  /** Average fill price */
  avgFillPrice: numeric('avg_fill_price'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_orders_trading_instance_id').on(t.tradingInstanceId),
  index('idx_orders_venue_ref_id').on(t.venueRefId),
  index('idx_orders_status').on(t.status),
]);
