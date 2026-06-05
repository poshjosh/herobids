import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Execution plans — plan layer output (desired-to-actual mapping).
 * Links a decision to the specific order commands generated.
 */
export const executionPlans = pgTable('execution_plans', {
  id: text('id').primaryKey(),               // UUIDv7
  decisionId: text('decision_id').notNull(),
  // tradingInstanceId REMOVED — plans are actor-scoped via actorType/actorId
  /** Venue account the plan executes against */
  venueAccountId: text('venue_account_id').notNull(),
  /** Actor type: agent | bot | user | system */
  actorType: text('actor_type').notNull().default('system'),
  /** Stable identifier of the actor that submitted this plan */
  actorId: text('actor_id'),
  /** The venue + instrument this plan targets */
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  /** Planned action summary */
  action: text('action').notNull(),          // e.g. "open_long", "close_short", "reduce"
  /** Planned order parameters */
  plannedOrders: jsonb('planned_orders').notNull().$type<unknown[]>(),
  status: text('status').notNull().default('pending'),  // pending | executing | completed | failed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('idx_execution_plans_decision_id').on(t.decisionId),
  index('idx_execution_plans_venue_account_id').on(t.venueAccountId),
  index('idx_execution_plans_actor_id').on(t.actorId),
]);
