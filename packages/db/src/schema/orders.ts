import { pgTable, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Orders — mutable order lifecycle records (state machine).
 * Status transitions: pending → open → partial → filled / cancelled / rejected
 */
export const orders = pgTable('orders', {
  id: text('id').primaryKey(),               // UUIDv7
  // tradingInstanceId REMOVED — orders are actor-scoped via actorType/actorId
  /** Venue account this order was placed through */
  venueAccountId: text('venue_account_id').notNull(),
  /** Actor type that placed this order: agent | bot | user | system */
  actorType: text('actor_type').notNull().default('system'),
  /** Stable identifier of the actor that placed this order */
  actorId: text('actor_id'),
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
  /** Decision-time mark used for execution-quality checks */
  referencePrice: numeric('reference_price'),
  /** Current order status */
  status: text('status').notNull().default('pending'),
  /** Live submit lifecycle phase for crash-safe recovery */
  submissionState: text('submission_state'),
  /** Timestamp when venue submit attempt was initiated */
  submitAttemptedAt: timestamp('submit_attempted_at', { withTimezone: true }),
  /** Timestamp when venue acknowledgement was persisted */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  /** Quantity filled so far */
  filledQuantity: numeric('filled_quantity').notNull().default('0'),
  /** Average fill price */
  avgFillPrice: numeric('avg_fill_price'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_orders_venue_account_id').on(t.venueAccountId),
  index('idx_orders_actor_id').on(t.actorId),
  index('idx_orders_venue_ref_id').on(t.venueRefId),
  index('idx_orders_client_order_id').on(t.clientOrderId),
  index('idx_orders_status').on(t.status),
]);
