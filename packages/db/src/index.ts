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
export * from './trading-profiles/index.js';
export * from './agents/agent-config-service.js';
export { TradingProfileReconciliationOutboxRepository } from './trading-profile-reconciliation-outbox-repository.js';
export type { DatabaseTransaction, TradingProfileReconciliationOutboxRow } from './trading-profile-reconciliation-outbox-repository.js';
export { ConnectionOwnershipRepository } from './repositories.js';
export { AlertDeliveryRepository } from './alert-delivery-repository.js';
export { PushSubscriptionRepository, toPushSubscriptionRecord } from './push-subscription-repository.js';
export type { PushSubscriptionRecord, UpsertPushSubscriptionInput } from './push-subscription-repository.js';
export { ConversationRepository, toConversationMessage } from './conversation-repository.js';
export { NotificationDeliveryRepository, EMAIL_CAP_COUNTED_STATUSES } from './notification-delivery-repository.js';
export type { RecordNotificationDeliveryInput } from './notification-delivery-repository.js';
export type { InsertAlertDelivery, DeliveryStatus } from './alert-delivery-repository.js';
export { BillingRepository } from './billing-repository.js';
export type { UpsertSubscription, BillingCustomerRow, BillingSubscriptionRow } from './billing-repository.js';
export { UsageBillingRepository } from './usage-billing-repository.js';
export type { InsertUsageEvent, InsertLedgerEntry, RecordUsageBatchInput, UsageSummaryFilters, UsageEventFilters, SpendCaps, OpenTopUpCreditInput, AccountStatus, CanSpendNowResult, BillingAccountRow, RateCardSeedItem } from './usage-billing-repository.js';
export { AgentRepository, setChatAddress, revokeChatAddress, normalizeChatAddress, listChatAddressesForOutput } from './agent-repository.js';
export type { InsertAgent, UpdateAgent, InsertAgentRuntimeSession, UpdateAgentRuntimeSession, LaunchableStartingSession, InsertAgentMessage, InsertAgentArtifact, InsertAgentOutboundMessage, ChatAddressScope, ChatAddressOutput } from './agent-repository.js';
export { AGENT_API_KEY_PREFIX, generateAgentApiKey, hashAgentApiKey, isAgentApiKey } from './agent-api-key.js';
export type { GeneratedAgentApiKey } from './agent-api-key.js';
export { resolveRuntimeCapabilityDescriptor, buildRuntimeDescriptor, deriveReadiness, chooseLatest } from './agent-runtime-descriptor.js';
export type { RuntimeCapabilityDescriptor, RuntimeAssignmentRow } from './agent-runtime-descriptor.js';
export { DecisionApprovalRepository } from './decision-approval-repository.js';
export type { InsertDecisionApproval, ResolutionInfo, DecisionApprovalRow } from './decision-approval-repository.js';
export { AgentDocumentsRepository } from './agent-documents-repository.js';
export type { InsertAgentDocument, UpdateAgentDocument, DocumentSource, ExtractionStatus, DocumentLifecycleState } from './agent-documents-repository.js';
export { loadAgentRuntimeSessions } from './agent-evidence-loaders.js';
export type { LoaderTimeFilter } from './agent-evidence-loaders.js';
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
export { isSkillSelectableForUser, resolveSkillIdsBySlugOrId, resolveSkillAssignmentsForUser, syncAgentSkillAssignments } from './skill-assignment.js';
export type { SkillAssignmentResolution } from './skill-assignment.js';
export { upsertExternalSkill, normalizeSourceRefToSlug, deriveSourceKind, ensureExternalSkillIds, externalSkillIdForRef, setExternalSkillCapabilityFamilies, findExternalSourceRefs } from './external-skill-catalog.js';
export type { ExternalSkillUpsert, ExternalSkillRow } from './external-skill-catalog.js';
export * from './plan-guards.js';
export * from './trading-setup/trading-provider-link.js';
export { recordAgentAuditEvent, AGENT_AUDIT_ACTIONS } from './agent-audit.js';
export type { AgentAuditAction, AgentAuditActorType, AgentAuditDetail, AgentAuditEventInput } from './agent-audit.js';
