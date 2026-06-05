import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Decision contexts — normalized input data that produced a decision.
 * Used for replay validation: re-running a strategy against the same context
 * should produce the same decision.
 */
export const decisionContexts = pgTable('decision_contexts', {
  id: text('id').primaryKey(),
  decisionId: text('decision_id').notNull(),
  // tradingInstanceId REMOVED — contexts are actor-scoped
  /** Venue account the decision context belongs to */
  venueAccountId: text('venue_account_id').notNull(),
  /** Actor type: agent | bot | user | system */
  actorType: text('actor_type').notNull().default('system'),
  /** Stable identifier of the actor */
  actorId: text('actor_id'),
  /** Hash of the normalized context for deduplication */
  contextHash: text('context_hash').notNull(),
  /** Full normalized context payload */
  context: jsonb('context').notNull().$type<{
    snapshot: { symbol: string; price: string; timestamp: string; data?: Record<string, unknown> };
    position: { side: string; size: string; entryPrice: string; realizedPnl: string } | null;
    referenceMark: { price: string; source: string } | null;
    balanceSnapshot: { balances: Array<{ asset: string; free: string; locked: string; total: string }> } | null;
    strategyParams: Record<string, unknown>;
  }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_decision_contexts_decision_id').on(t.decisionId),
  index('idx_decision_contexts_context_hash').on(t.contextHash),
  index('idx_decision_contexts_venue_account_id').on(t.venueAccountId),
  index('idx_decision_contexts_actor_id').on(t.actorId),
]);
