import { z } from 'zod';

/**
 * Agent protocol message schemas — canonical v1 Zod definitions.
 * Derived from docs/tech/agents/message-catalog.md.
 */

// --- Envelope ---

export const ActorTypeSchema = z.enum(['agent', 'bot', 'user', 'system']);

export const MessageEnvelopeSchema = z.object({
  schemaVersion: z.string().default('v1'),
  messageId: z.string().min(1),
  correlationId: z.string().min(1),
  initiatorType: ActorTypeSchema,
  initiatorId: z.string().min(1),
  originType: ActorTypeSchema.optional(),
  originId: z.string().optional(),
  /** Agent that owns this message stream (primary grouping key). Optional for backwards compat. */
  agentId: z.string().optional(),
  /** @deprecated Use botId instead. Kept for backwards-compat with older envelope senders. */
  tradingInstanceId: z.string().optional(),
  /** Bot this message is scoped to (nullable — null for agent-level messages) */
  botId: z.string().optional(),
  type: z.string().min(1),
  createdAt: z.string().datetime(),
  payload: z.record(z.unknown()),
  traceId: z.string().optional(),
  sequence: z.number().int().optional(),
});

export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

// --- Agent → Trading Instance Messages ---

export const DecisionSubmitPayloadSchema = z.object({
  decisionId: z.string().min(1),
  instrumentId: z.string().min(1),
  intent: z.enum(['go_long', 'go_short', 'go_flat', 'increase', 'decrease']),
  targetSize: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a decimal string'),
  limitPrice: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  contextHash: z.string().optional(),
  rationaleSummary: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  artifacts: z.array(z.record(z.unknown())).optional(),
  metadata: z.record(z.unknown()).optional(),
  safetyOverrideId: z.string().min(1).optional(),
});

export type DecisionSubmitPayload = z.infer<typeof DecisionSubmitPayloadSchema>;

export const PauseRequestPayloadSchema = z.object({
  reason: z.string().min(1),
  requestedBy: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type PauseRequestPayload = z.infer<typeof PauseRequestPayloadSchema>;

export const StopRequestPayloadSchema = z.object({
  reason: z.string().min(1),
  mode: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type StopRequestPayload = z.infer<typeof StopRequestPayloadSchema>;

export const HeartbeatPayloadSchema = z.object({
  sessionId: z.string().min(1),
  status: z.enum(['starting', 'ready', 'busy', 'degraded']),
  reasonCode: z.string().min(1).optional(),
  cpuPct: z.number().optional(),
  memoryBytes: z.number().optional(),
  toolActivity: z.string().optional(),
});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

export const SessionEndedPayloadSchema = z.object({
  sessionId: z.string().min(1),
  reasonCode: z.string().min(1),
});

export type SessionEndedPayload = z.infer<typeof SessionEndedPayloadSchema>;

export const ArtifactPublishPayloadSchema = z.object({
  artifactId: z.string().min(1),
  artifactType: z.string().min(1),
  contentType: z.string().min(1),
  summary: z.string().min(1),
  location: z.object({
    bucket: z.string().optional(),
    key: z.string().optional(),
    url: z.string().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ArtifactPublishPayload = z.infer<typeof ArtifactPublishPayloadSchema>;

/**
 * Brokered outbound user message — agent requests the platform send a message to the user.
 * The platform owns recipient resolution. Body is bounded. Always available in the MVP.
 */
export const SendMessagePayloadSchema = z.object({
  /** Optional short subject or category (max 200 chars) */
  subject: z.string().max(200).optional(),
  /** Message body — bounded at 2000 chars */
  body: z.string().min(1).max(2000),
  /** Optional reference to a decision ID or context hash */
  contextRef: z.string().optional(),
  /**
   * Message urgency class.
   * - routine: general updates, commentary, progress notes (default)
   * - alert: urgent or important attention-needed message
   * - reminder: time-based or scheduled reminder intended to prompt action
   */
  messageClass: z.enum(['routine', 'alert', 'reminder']).optional(),
  /**
   * Whether the agent is requesting email fanout in addition to inbox persistence.
   * - never: inbox only (default)
   * - if_allowed: agent requests email fanout; broker decides based on policy
   */
  emailDelivery: z.enum(['never', 'if_allowed']).optional(),
});

export type SendMessagePayload = z.infer<typeof SendMessagePayloadSchema>;

/** Brokered tool: agent requests creation (and optionally auto-start) of a bot. */
export const ManageBotPayloadSchema = z.object({
  action: z.enum(['create_and_start', 'stop', 'start', 'adjust_config']),
  /** For create_and_start — the target venue account */
  venueAccountId: z.string().min(1).optional(),
  /** For create_and_start — full bot config (strategy, risk params, execution mode) */
  config: z.record(z.unknown()).optional(),
  /** For stop — the bot ID to stop */
  botId: z.string().min(1).optional(),
  /** Human-readable summary of why this action is being taken */
  rationale: z.string().max(500).optional(),
});

export type ManageBotPayload = z.infer<typeof ManageBotPayloadSchema>;

/** Brokered bot query payload used to fetch read-only data from the platform. */
export const BotQueryPayloadSchema = z.object({
  action: z.enum(['list_bots', 'get_bot_status', 'get_analytics', 'list_positions']),
  botId: z.string().min(1).optional(),
  days: z.number().int().min(1).max(90).optional(),
});

export type BotQueryPayload = z.infer<typeof BotQueryPayloadSchema>;

// --- Trading Instance → Agent Messages ---

export const ContextSnapshotPayloadSchema = z.object({
  snapshotId: z.string().min(1),
  symbol: z.string().min(1),
  price: z.string(),
  timestamp: z.string().datetime(),
  marketData: z.record(z.unknown()).optional(),
  position: z.object({
    side: z.string(),
    size: z.string(),
    entryPrice: z.string(),
    realizedPnl: z.string(),
  }).nullable(),
  /** Per-instrument unrealized PnL in USD. Computed as (markPrice - entryPrice) * size * direction.
   * Used by the runtime tick gate and composition layer for portfolio-level aggregation.
   * Omitted when mark price is unavailable (degraded snapshots). */
  pnl: z.union([z.string(), z.number()]).optional(),
  referenceMark: z.object({
    price: z.string(),
    source: z.string(),
  }),
  strategyParams: z.record(z.unknown()),
  executionMode: z.enum(['paper', 'shadow', 'live']),
  guardrails: z.record(z.unknown()),
  artifacts: z.array(z.record(z.unknown())).optional(),
});

export type ContextSnapshotPayload = z.infer<typeof ContextSnapshotPayloadSchema>;

export const DecisionAcceptedPayloadSchema = z.object({
  decisionId: z.string().min(1),
  acceptedAt: z.string().datetime(),
  normalizedDecision: z.record(z.unknown()),
});

export type DecisionAcceptedPayload = z.infer<typeof DecisionAcceptedPayloadSchema>;

export const DecisionRejectedPayloadSchema = z.object({
  decisionId: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export type DecisionRejectedPayload = z.infer<typeof DecisionRejectedPayloadSchema>;

export const PlanStatusPayloadSchema = z.object({
  decisionId: z.string().min(1),
  planId: z.string().min(1),
  status: z.enum(['created', 'executing', 'completed', 'failed']),
  action: z.string().min(1),
  venue: z.string().min(1),
  symbol: z.string().min(1),
  orderCount: z.number().int().min(0),
  reason: z.string().optional(),
});

export type PlanStatusPayload = z.infer<typeof PlanStatusPayloadSchema>;

export const ExecutionResultPayloadSchema = z.object({
  decisionId: z.string().min(1),
  planId: z.string().min(1),
  orders: z.array(z.record(z.unknown())),
  fills: z.array(z.record(z.unknown())),
  positionAfter: z.record(z.unknown()),
  executionFailed: z.boolean(),
  completedAt: z.string().datetime(),
});

export type ExecutionResultPayload = z.infer<typeof ExecutionResultPayloadSchema>;

export const GuardrailTriggeredPayloadSchema = z.object({
  scope: z.enum(['agent_guardrail', 'risk_gate']),
  code: z.string().min(1),
  message: z.string().min(1),
  decisionId: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export type GuardrailTriggeredPayload = z.infer<typeof GuardrailTriggeredPayloadSchema>;

export const ReconciliationNoticePayloadSchema = z.object({
  severity: z.enum(['info', 'warn', 'critical']),
  eventType: z.enum(['match', 'observed_variance', 'drift_detected', 'drift_within_threshold', 'correction']),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime(),
});

export type ReconciliationNoticePayload = z.infer<typeof ReconciliationNoticePayloadSchema>;

export const InstanceStatusPayloadSchema = z.object({
  status: z.enum(['starting', 'running', 'paused', 'stopped', 'degraded', 'recovering']),
  reason: z.string().optional(),
  liveState: z.string().optional(),
  updatedAt: z.string().datetime(),
  /** Bots managed by this agent — injected after lifecycle changes so the agent has current status. */
  managedBots: z.array(z.object({
    id: z.string(),
    status: z.string(),
    strategyPreset: z.string().optional(),
    symbol: z.string().optional(),
  })).optional(),
});

export type InstanceStatusPayload = z.infer<typeof InstanceStatusPayloadSchema>;

/** Tool-result message emitted by the platform back to an agent. */
export const ToolResultPayloadSchema = z.object({
  tool: z.string().min(1),
  status: z.enum(['ok', 'error']),
  message: z.string().min(1),
  botId: z.string().optional(),
  data: z.unknown().optional(),
});

export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;

// --- Market Monitor Payload Schemas ---

export const MarketWatchTriggeredPayloadSchema = z.object({
  eventId: z.string().min(1),
  monitorType: z.literal('watch_threshold'),
  watchId: z.string().min(1),
  symbol: z.string().min(1),
  chain: z.string().min(1),
  condition: z.enum(['above', 'below']),
  thresholdPrice: z.number(),
  currentPrice: z.number(),
  priceSource: z.string().min(1),
  stale: z.boolean(),
  note: z.string().optional(),
  triggeredAt: z.string().datetime(),
});

export type MarketWatchTriggeredPayload = z.infer<typeof MarketWatchTriggeredPayloadSchema>;

export const MarketDiscoveryDetectedPayloadSchema = z.object({
  eventId: z.string().min(1),
  monitorType: z.literal('discovery_delta'),
  symbol: z.string().min(1),
  network: z.string().min(1),
  address: z.string().min(1),
  reason: z.enum(['entered_top_set', 'reappeared_after_cooldown', 'multi_vector_confirmation']),
  rank: z.number().int().optional(),
  liquidityUsd: z.number().optional(),
  volume24hUsd: z.number().optional(),
  discoveryVectors: z.array(z.string()).optional(),
  detectedAt: z.string().datetime(),
});

export type MarketDiscoveryDetectedPayload = z.infer<typeof MarketDiscoveryDetectedPayloadSchema>;

export const MarketRegimeChangedPayloadSchema = z.object({
  eventId: z.string().min(1),
  monitorType: z.literal('regime_change'),
  benchmarkSymbol: z.string().min(1),
  previousState: z.string().min(1),
  currentState: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  changedAt: z.string().datetime(),
});

export type MarketRegimeChangedPayload = z.infer<typeof MarketRegimeChangedPayloadSchema>;

export const WakePrioritySchema = z.enum(['low', 'normal', 'high']);
export type WakePriority = z.infer<typeof WakePrioritySchema>;

export const AgentMarketWakeSourceSchema = z.enum(['reminder', 'watch_threshold', 'discovery_delta', 'regime_change']);
export type AgentMarketWakeSource = z.infer<typeof AgentMarketWakeSourceSchema>;

// --- Source-specific wake context schemas ---

export const ReminderWakeContextSchema = z.object({
  reminderId: z.string().min(1),
  message: z.string().min(1),
  scheduledBy: z.enum(['scout', 'judge']),
});
export type ReminderWakeContext = z.infer<typeof ReminderWakeContextSchema>;

export const WatchThresholdWakeContextSchema = z.object({
  watchId: z.string().min(1),
  symbol: z.string().min(1),
  chain: z.string().min(1),
  condition: z.enum(['above', 'below']),
  thresholdPrice: z.number(),
  currentPrice: z.number(),
  stale: z.boolean(),
  triggeredAt: z.string().datetime(),
  note: z.string().optional(),
});
export type WatchThresholdWakeContext = z.infer<typeof WatchThresholdWakeContextSchema>;

export const DiscoveryDeltaWakeContextSchema = z.object({
  symbol: z.string().min(1),
  network: z.string().min(1),
  address: z.string().min(1),
  reason: z.string().min(1),
  rank: z.number().int().optional(),
  liquidityUsd: z.number().optional(),
  volume24hUsd: z.number().optional(),
  detectedAt: z.string().datetime(),
});
export type DiscoveryDeltaWakeContext = z.infer<typeof DiscoveryDeltaWakeContextSchema>;

export const RegimeChangeWakeContextSchema = z.object({
  benchmarkSymbol: z.string().min(1),
  previousState: z.string().min(1),
  currentState: z.string().min(1),
  changedAt: z.string().datetime(),
  details: z.unknown().optional(),
});
export type RegimeChangeWakeContext = z.infer<typeof RegimeChangeWakeContextSchema>;

const AgentMarketWakePayloadBaseSchema = z.object({
  wakeId: z.string().min(1),
  reason: z.string().min(1),
  eventIds: z.array(z.string().min(1)),
  priority: WakePrioritySchema,
  requestedAt: z.string().datetime(),
  notBefore: z.string().datetime().optional(),
});

export const AgentMarketWakePayloadSchema = z.discriminatedUnion('source', [
  AgentMarketWakePayloadBaseSchema.extend({ source: z.literal('reminder'), context: ReminderWakeContextSchema }),
  AgentMarketWakePayloadBaseSchema.extend({ source: z.literal('watch_threshold'), context: WatchThresholdWakeContextSchema }),
  AgentMarketWakePayloadBaseSchema.extend({ source: z.literal('discovery_delta'), context: DiscoveryDeltaWakeContextSchema }),
  AgentMarketWakePayloadBaseSchema.extend({ source: z.literal('regime_change'), context: RegimeChangeWakeContextSchema }),
]);

export type AgentMarketWakePayload = z.infer<typeof AgentMarketWakePayloadSchema>;

// --- Message Type Constants ---

export const AGENT_MESSAGE_TYPES = {
  DECISION_SUBMIT: 'agent.decision.submit',
  LIFECYCLE_PAUSE: 'agent.lifecycle.pause_request',
  LIFECYCLE_STOP: 'agent.lifecycle.stop_request',
  RUNTIME_HEARTBEAT: 'agent.runtime.heartbeat',
  RUNTIME_SESSION_ENDED: 'agent.runtime.session_ended',
  PUBLISH_ARTIFACT: 'agent.artifact.publish',
  SEND_MESSAGE: 'agent.message.send',
  MANAGE_BOT: 'agent.manage_bot',
  BOT_QUERY: 'agent.bot.query',
} as const;

export const INSTANCE_MESSAGE_TYPES = {
  CONTEXT_SNAPSHOT: 'instance.context.snapshot',
  DECISION_ACCEPTED: 'instance.decision.accepted',
  DECISION_REJECTED: 'instance.decision.rejected',
  PLAN_STATUS: 'instance.plan.status',
  EXECUTION_RESULT: 'instance.execution.result',
  GUARDRAIL_TRIGGERED: 'instance.guardrail.triggered',
  RECONCILIATION_NOTICE: 'instance.reconciliation.notice',
  STATUS: 'instance.status',
  TOOL_RESULT: 'instance.tool.result',
} as const;

export const MARKET_MONITOR_MESSAGE_TYPES = {
  WATCH_TRIGGERED: 'market.watch.triggered',
  DISCOVERY_DETECTED: 'market.discovery.detected',
  REGIME_CHANGED: 'market.regime.changed',
  AGENT_WAKE: 'agent.market.wake',
} as const;

// --- Runtime Activity Audit Event Types ---

/**
 * Curated operator-meaningful runtime audit events published by the agent
 * container into the inbound stream. These are persist-only with no business
 * side effects — they exist solely to populate the activity feed.
 */
export const AGENT_RUNTIME_ACTIVITY_TYPES = {
  TICK_STARTED: 'agent.tick.started',
  TICK_SKIPPED: 'agent.tick.skipped',
  SCOUT_HELD: 'agent.scout.held',
  SCOUT_ESCALATED: 'agent.scout.escalated',
  LLM_DISPATCH: 'agent.llm.dispatch',
  LLM_COMPLETED: 'agent.llm.completed',
  TOOL_CALL: 'agent.tool.call',
  TOOL_RESULT: 'agent.tool.result',
} as const;

// --- Runtime Activity Payload Schemas ---

export const TickStartedPayloadSchema = z.object({
  tickId: z.string().min(1),
  trigger: z.string().min(1),
  positionSide: z.string().optional(),
  hasWakeSignal: z.boolean(),
});
export type TickStartedPayload = z.infer<typeof TickStartedPayloadSchema>;

export const TickSkippedPayloadSchema = z.object({
  tickId: z.string().min(1),
  reason: z.string().min(1),
  gate: z.string().optional(),
  trigger: z.string().optional(),
  positionSide: z.string().optional(),
});
export type TickSkippedPayload = z.infer<typeof TickSkippedPayloadSchema>;

export const ScoutHeldPayloadSchema = z.object({
  tickId: z.string().min(1),
  reason: z.string().min(1),
});
export type ScoutHeldPayload = z.infer<typeof ScoutHeldPayloadSchema>;

export const ScoutEscalatedPayloadSchema = z.object({
  tickId: z.string().min(1),
  reason: z.string().min(1),
});
export type ScoutEscalatedPayload = z.infer<typeof ScoutEscalatedPayloadSchema>;

export const LlmDispatchPayloadSchema = z.object({
  tickId: z.string().min(1),
  phase: z.enum(['scout', 'judge']),
  model: z.string().min(1),
  maxTurns: z.number().int().min(1),
});
export type LlmDispatchPayload = z.infer<typeof LlmDispatchPayloadSchema>;

export const LlmCompletedPayloadSchema = z.object({
  tickId: z.string().min(1),
  phase: z.enum(['scout', 'judge']),
  model: z.string().min(1),
  turnsUsed: z.number().int().min(0),
  finishReason: z.string().min(1),
  tokensUsed: z.number().int().min(0).optional(),
  thinkingTokens: z.number().int().min(0).optional(),
});
export type LlmCompletedPayload = z.infer<typeof LlmCompletedPayloadSchema>;

export const RuntimeToolCallPayloadSchema = z.object({
  tickId: z.string().min(1),
  phase: z.enum(['scout', 'judge']),
  toolName: z.string().min(1),
  correlationId: z.string().min(1),
});
export type RuntimeToolCallPayload = z.infer<typeof RuntimeToolCallPayloadSchema>;

export const RuntimeToolResultPayloadSchema = z.object({
  tickId: z.string().min(1),
  phase: z.enum(['scout', 'judge']),
  toolName: z.string().min(1),
  status: z.enum(['ok', 'error']),
  correlationId: z.string().min(1),
  summary: z.string().max(500).optional(),
});
export type RuntimeToolResultPayload = z.infer<typeof RuntimeToolResultPayloadSchema>;

/** Map message type to its payload schema for validation */
export const MESSAGE_PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  [AGENT_MESSAGE_TYPES.DECISION_SUBMIT]: DecisionSubmitPayloadSchema,
  [AGENT_MESSAGE_TYPES.LIFECYCLE_PAUSE]: PauseRequestPayloadSchema,
  [AGENT_MESSAGE_TYPES.LIFECYCLE_STOP]: StopRequestPayloadSchema,
  [AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT]: HeartbeatPayloadSchema,
  [AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED]: SessionEndedPayloadSchema,
  [AGENT_MESSAGE_TYPES.PUBLISH_ARTIFACT]: ArtifactPublishPayloadSchema,
  [AGENT_MESSAGE_TYPES.SEND_MESSAGE]: SendMessagePayloadSchema,
  [AGENT_MESSAGE_TYPES.MANAGE_BOT]: ManageBotPayloadSchema,
  [AGENT_MESSAGE_TYPES.BOT_QUERY]: BotQueryPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.CONTEXT_SNAPSHOT]: ContextSnapshotPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.DECISION_ACCEPTED]: DecisionAcceptedPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.DECISION_REJECTED]: DecisionRejectedPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.PLAN_STATUS]: PlanStatusPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.EXECUTION_RESULT]: ExecutionResultPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.GUARDRAIL_TRIGGERED]: GuardrailTriggeredPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.RECONCILIATION_NOTICE]: ReconciliationNoticePayloadSchema,
  [INSTANCE_MESSAGE_TYPES.STATUS]: InstanceStatusPayloadSchema,
  [INSTANCE_MESSAGE_TYPES.TOOL_RESULT]: ToolResultPayloadSchema,
  [MARKET_MONITOR_MESSAGE_TYPES.WATCH_TRIGGERED]: MarketWatchTriggeredPayloadSchema,
  [MARKET_MONITOR_MESSAGE_TYPES.DISCOVERY_DETECTED]: MarketDiscoveryDetectedPayloadSchema,
  [MARKET_MONITOR_MESSAGE_TYPES.REGIME_CHANGED]: MarketRegimeChangedPayloadSchema,
  [MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE]: AgentMarketWakePayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED]: TickStartedPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED]: TickSkippedPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_HELD]: ScoutHeldPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_ESCALATED]: ScoutEscalatedPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH]: LlmDispatchPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.LLM_COMPLETED]: LlmCompletedPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL]: RuntimeToolCallPayloadSchema,
  [AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_RESULT]: RuntimeToolResultPayloadSchema,
};

/**
 * Validate a full message envelope including its type-specific payload.
 */
export function validateMessage(raw: unknown): z.SafeParseReturnType<unknown, MessageEnvelope> {
  const envelopeResult = MessageEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) return envelopeResult;

  const payloadSchema = MESSAGE_PAYLOAD_SCHEMAS[envelopeResult.data.type];
  if (!payloadSchema) {
    return {
      success: false,
      error: new z.ZodError([{
        code: 'custom',
        message: `Unknown message type: ${envelopeResult.data.type}`,
        path: ['type'],
      }]),
    };
  }

  const payloadResult = payloadSchema.safeParse(envelopeResult.data.payload);
  if (!payloadResult.success) {
    return {
      success: false,
      error: payloadResult.error,
    };
  }

  return envelopeResult;
}
