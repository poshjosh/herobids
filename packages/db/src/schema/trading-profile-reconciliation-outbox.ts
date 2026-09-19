import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export type TradingProfileOutboxState = 'pending_remote' | 'remote_applied' | 'local_committed' | 'finalizing' | 'rollback_pending' | 'completed' | 'failed';

export interface TradingProfileOutboxAction {
  actionId: string;
  kind: 'set' | 'clear';
  venueAccountId: string;
  state: 'pending' | 'applied' | 'failed';
  attempts: number;
  error: string | null;
}

/** Metadata-only durable coordinator record; Traderton remains profile-state authority. */
export const tradingProfileReconciliationOutbox = pgTable('trading_profile_reconciliation_outbox', {
  id: text('id').primaryKey(),
  operationId: text('operation_id').notNull(),
  localMutationId: text('local_mutation_id').notNull(),
  ownerId: text('owner_id').notNull(),
  actorId: text('actor_id').notNull(),
  state: text('state').$type<TradingProfileOutboxState>().notNull(),
  actions: jsonb('actions').$type<TradingProfileOutboxAction[]>().notNull(),
  lastError: text('last_error'),
  claimToken: text('claim_token'),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('uq_trading_profile_reconciliation_outbox_operation').on(table.operationId),
  uniqueIndex('uq_trading_profile_reconciliation_outbox_local_mutation').on(table.localMutationId),
  index('idx_trading_profile_reconciliation_outbox_recovery').on(table.state, table.claimExpiresAt, table.updatedAt),
]);