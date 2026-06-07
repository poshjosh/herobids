import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export * from './schema/index.js';
export { PgJournal } from './journal-pg.js';
export { FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, DecisionRepository, BotRepository } from './repositories.js';
export type { InsertFill, UpsertPosition, InsertExecutionPlan, UpsertOrder, InsertBalanceSnapshot, InsertDecision } from './repositories.js';
export { ReconciliationEventRepository } from './reconciliation-repository.js';
export type { InsertReconciliationEvent, ReconciliationEventQuery } from './reconciliation-repository.js';
export { BacktestingRepository } from './backtesting-repository.js';
export type { InsertDecisionContext, InsertCorpus, InsertMarketEvent } from './backtesting-repository.js';
export { AlertDeliveryRepository } from './alert-delivery-repository.js';
export type { InsertAlertDelivery, DeliveryStatus } from './alert-delivery-repository.js';
export { BillingRepository } from './billing-repository.js';
export type { UpsertSubscription, BillingCustomerRow, BillingSubscriptionRow } from './billing-repository.js';
export { AgentRepository } from './agent-repository.js';
export type { InsertAgent, UpdateAgent, InsertAgentRuntimeSession, UpdateAgentRuntimeSession, LaunchableStartingSession, InsertAgentMessage, InsertAgentArtifact, InsertAgentOutboundMessage } from './agent-repository.js';
export { resolveRuntimeCapabilityDescriptor, buildRuntimeDescriptor } from './agent-runtime-descriptor.js';
export type { RuntimeCapabilityDescriptor } from './agent-runtime-descriptor.js';
