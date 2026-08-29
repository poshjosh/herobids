import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

interface ClosableDatabaseClient {
  end(options?: { timeout?: number }): Promise<void>;
}

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export async function closeDatabase(db: Database): Promise<void> {
  await (db as Database & { $client: ClosableDatabaseClient }).$client.end();
}

export * from './schema/index.js';
export { PgJournal } from './journal-pg.js';
export { FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, DecisionRepository, BotRepository } from './repositories.js';
export type { InsertFill, UpsertPosition, InsertExecutionPlan, UpsertOrder, InsertBalanceSnapshot, InsertDecision } from './repositories.js';
export { ReconciliationEventRepository } from './reconciliation-repository.js';
export type { InsertReconciliationEvent, ReconciliationEventQuery } from './reconciliation-repository.js';
export { BacktestingRepository } from './backtesting-repository.js';
export type { InsertDecisionContext, InsertCorpus, InsertMarketEvent } from './backtesting-repository.js';
export { LlmArtifactRepository } from './llm-artifact-repository.js';
export type { InsertLlmArtifact, LlmArtifactSource } from './llm-artifact-repository.js';
export { AlertDeliveryRepository } from './alert-delivery-repository.js';
export type { InsertAlertDelivery, DeliveryStatus } from './alert-delivery-repository.js';
export { BillingRepository } from './billing-repository.js';
export type { UpsertSubscription, BillingCustomerRow, BillingSubscriptionRow } from './billing-repository.js';
export { UsageBillingRepository } from './usage-billing-repository.js';
export type { InsertUsageEvent, InsertLedgerEntry, RecordUsageBatchInput, UsageSummaryFilters, UsageEventFilters, SpendCaps, OpenTopUpCreditInput, AccountStatus, CanSpendNowResult, BillingAccountRow, RateCardSeedItem } from './usage-billing-repository.js';
export { AgentRepository } from './agent-repository.js';
export type { InsertAgent, UpdateAgent, InsertAgentRuntimeSession, UpdateAgentRuntimeSession, LaunchableStartingSession, InsertAgentMessage, InsertAgentArtifact, InsertAgentOutboundMessage } from './agent-repository.js';
export { InstrumentRepository } from './instrument-repository.js';
export type { InstrumentSearchParams, InstrumentRow, UpsertInstrumentRow } from './instrument-repository.js';
export { resolveRuntimeCapabilityDescriptor, buildRuntimeDescriptor, deriveReadiness, chooseLatest } from './agent-runtime-descriptor.js';
export type { RuntimeCapabilityDescriptor, RuntimeAssignmentRow } from './agent-runtime-descriptor.js';
export { TokenSafetyOverrideRepository } from './token-safety-override-repository.js';
export type { IssueOverrideParams, TokenSafetyOverrideRow } from './token-safety-override-repository.js';
export { DecisionFailureRepository } from './decision-failure-repository.js';
export type { InsertDecisionFailure, DecisionFailureQuery } from './decision-failure-repository.js';
export { DecisionApprovalRepository } from './decision-approval-repository.js';
export type { InsertDecisionApproval, ResolutionInfo, DecisionApprovalRow } from './decision-approval-repository.js';
export { AgentDocumentsRepository } from './agent-documents-repository.js';
export type { InsertAgentDocument, UpdateAgentDocument, DocumentSource, ExtractionStatus, DocumentLifecycleState } from './agent-documents-repository.js';
export {
  loadAgentBotIds,
  loadAgentFills,
  loadAgentJournalEvents,
  loadAgentRuntimeSessions,
  loadAgentPositions,
} from './agent-evidence-loaders.js';
export type { LoaderTimeFilter, LoadPositionsOpts } from './agent-evidence-loaders.js';
export {
  NoSessionForScopeError,
  resolveScope,
  normalizeScopeKey,
  hasActiveRunForScope,
  createRun,
  markRunning,
  markSucceeded,
  markFailed,
  markRetrying,
  markTimedOut,
  getRun,
  listByAgent,
} from './agent-evaluation-repository.js';
export { EVALUATION_QUEUE_NAME } from './agent-evaluation-job.js';
export type { EvaluationJobData, ResolvedNarrativeLlmConfig } from './agent-evaluation-job.js';
export { FsEvaluationArtifactStore } from './agent-evaluation-storage-fs.js';
export { MANUAL_REVIEW_QUEUE_NAME } from './manual-review-job.js';
export type { ManualReviewJobData } from './manual-review-job.js';
export {
  createManualReviewRun,
  markManualReviewRunning,
  markManualReviewSucceeded,
  markManualReviewFailed,
  getManualReviewRun,
  getLatestManualReviewRun,
  hasActiveManualReviewRun,
} from './manual-review-repository.js';
export type { ManualReviewRunRow, ManualReviewResultSummary } from './manual-review-repository.js';
export { isSkillSelectableForUser, resolveSkillIdsBySlugOrId, resolveSkillAssignmentsForUser, syncAgentSkillAssignments } from './skill-assignment.js';
export type { SkillAssignmentResolution } from './skill-assignment.js';
