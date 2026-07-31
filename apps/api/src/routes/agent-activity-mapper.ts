// ---------------------------------------------------------------------------
// Agent Activity Mapper — converts raw protocol messages, runtime sessions,
// outbound messages, and artifacts into the canonical AgentActivityEntry shape.
// ---------------------------------------------------------------------------

import { AGENT_MESSAGE_TYPES, INSTANCE_MESSAGE_TYPES, AGENT_RUNTIME_ACTIVITY_TYPES } from '@herobids/domain';
import type { AgentActivityEntry, AgentActivityCategory, AgentActivitySeverity, AgentActivityEventType } from './agent-activity-types.js';

// ---------------------------------------------------------------------------
// Message type → activity classification
// ---------------------------------------------------------------------------

interface ActivityClassification {
  category: AgentActivityCategory;
  severity: AgentActivitySeverity;
  eventType: AgentActivityEventType;
  title: string;
  summaryFn: (row: RawAgentMessage) => string;
}

function isRuntimeActivityWarn(row: RawAgentMessage): boolean {
  if (!row.payload) {
    return false;
  }

  if (row.type === AGENT_RUNTIME_ACTIVITY_TYPES.LLM_COMPLETED) {
    const finishReason = row.payload['finishReason'];
    const phase = row.payload['phase'];
    return finishReason === 'error' || (finishReason === 'turn_limit' && phase === 'judge');
  }

  if (row.type === AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_RESULT) {
    return row.payload['status'] === 'error';
  }

  return false;
}

export interface RawAgentMessage {
  id: string;
  messageId: string;
  correlationId: string;
  actorType: string;
  actorId: string;
  agentId: string;
  botId: string | null;
  type: string;
  direction: string;
  schemaVersion: string;
  sequence: number | null;
  traceId: string | null;
  processingStatus: string;
  errorDetail: { code: string; message: string } | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface RawRuntimeSession {
  id: string;
  agentId: string;
  status: string;
  lastHeartbeatAt: Date | null;
  cpuPct: number | null;
  memoryBytes: number | null;
  startedAt: Date;
  stoppedAt: Date | null;
}

export interface RawOutboundMessage {
  id: string;
  agentId: string;
  sessionId: string | null;
  authoredBy: string;
  subject: string | null;
  body: string;
  contextRef: string | null;
  messageClass: string;
  deliveryStatus: string;
  createdAt: Date;
}

export interface RawArtifact {
  id: string;
  agentId: string;
  sessionId: string | null;
  artifactType: string;
  contentType: string;
  summary: string | null;
  createdAt: Date;
}

export const SUPPRESSED_PROTOCOL_MESSAGE_TYPES = [
  'agent.heartbeat',
  'agent.runtime.heartbeat',
] as const;

export function isSuppressedProtocolMessageType(type: string): boolean {
  return SUPPRESSED_PROTOCOL_MESSAGE_TYPES.includes(type as (typeof SUPPRESSED_PROTOCOL_MESSAGE_TYPES)[number]);
}

// ---------------------------------------------------------------------------
// Classification table for protocol message types
// ---------------------------------------------------------------------------

const MESSAGE_CLASSIFICATIONS: Record<string, ActivityClassification> = {
  'agent.heartbeat': {
    category: 'runtime',
    severity: 'info',
    eventType: 'runtime.started',
    title: 'Heartbeat',
    summaryFn: (row) => row.processingStatus === 'failed'
      ? 'Agent heartbeat reported a problem.'
      : 'Agent runtime reported healthy status.',
  },
  [AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED]: {
    category: 'runtime',
    severity: 'warn',
    eventType: 'runtime.failed',
    title: 'Session ended',
    summaryFn: (row) => row.errorDetail?.message ?? 'Agent session terminated.',
  },
  [AGENT_MESSAGE_TYPES.DECISION_SUBMIT]: {
    category: 'decision',
    severity: 'info',
    eventType: 'decision.accepted',
    title: 'Decision submitted',
    summaryFn: () => 'Agent submitted a trading decision for evaluation.',
  },
  [INSTANCE_MESSAGE_TYPES.DECISION_ACCEPTED]: {
    category: 'decision',
    severity: 'info',
    eventType: 'decision.accepted',
    title: 'Decision accepted',
    summaryFn: () => 'Trading decision was accepted and queued for execution.',
  },
  [INSTANCE_MESSAGE_TYPES.DECISION_REJECTED]: {
    category: 'decision',
    severity: 'warn',
    eventType: 'decision.rejected',
    title: 'Decision rejected',
    summaryFn: (row) => row.errorDetail?.message ?? 'Decision was rejected by the platform.',
  },
  [INSTANCE_MESSAGE_TYPES.DECISION_PENDING_APPROVAL]: {
    category: 'decision',
    severity: 'info',
    eventType: 'decision.pending_approval',
    title: 'Decision pending approval',
    summaryFn: (row) => {
      const p = row.payload as Record<string, unknown> | null;
      const instrument = typeof p?.['instrumentId'] === 'string' ? p['instrumentId'] : 'unknown';
      const intent = typeof p?.['intent'] === 'string' ? p['intent'] : 'unknown';
      const code = typeof p?.['shortCode'] === 'string' ? p['shortCode'] : '????';
      return `Trade decision for ${instrument} (${intent}) requires approval. Use /yes ${code} or /no ${code}.`;
    },
  },
  [INSTANCE_MESSAGE_TYPES.GUARDRAIL_TRIGGERED]: {
    category: 'risk',
    severity: 'warn',
    eventType: 'decision.rejected',
    title: 'Guardrail triggered',
    summaryFn: (row) => row.errorDetail?.message ?? 'A platform guardrail blocked or constrained agent activity.',
  },
  [INSTANCE_MESSAGE_TYPES.TOOL_RESULT]: {
    category: 'tool',
    severity: 'info',
    eventType: 'system.alert',
    title: 'Tool result',
    summaryFn: (row) => row.processingStatus === 'failed'
      ? 'Tool result processing failed.'
      : 'Platform recorded a tool result.',
  },
  [AGENT_MESSAGE_TYPES.SEND_MESSAGE]: {
    category: 'message',
    severity: 'info',
    eventType: 'message.authored',
    title: 'Message authored',
    summaryFn: () => 'Agent authored a user-facing message.',
  },
  [AGENT_MESSAGE_TYPES.PUBLISH_ARTIFACT]: {
    category: 'artifact',
    severity: 'info',
    eventType: 'artifact.published',
    title: 'Artifact published',
    summaryFn: () => 'Agent published an artifact.',
  },
  [AGENT_MESSAGE_TYPES.MANAGE_BOT]: {
    category: 'tool',
    severity: 'info',
    eventType: 'system.alert',
    title: 'Bot management',
    summaryFn: () => 'Agent issued a bot management action.',
  },
  [INSTANCE_MESSAGE_TYPES.STATUS]: {
    category: 'system',
    severity: 'info',
    eventType: 'system.alert',
    title: 'Instance status update',
    summaryFn: () => 'Platform updated runtime state.',
  },
  [INSTANCE_MESSAGE_TYPES.CONTEXT_SNAPSHOT]: {
    category: 'system',
    severity: 'info',
    eventType: 'system.alert',
    title: 'Context updated',
    summaryFn: () => 'Platform delivered a runtime context update to the agent.',
  },
  [AGENT_MESSAGE_TYPES.LIFECYCLE_PAUSE]: {
    category: 'runtime',
    severity: 'warn',
    eventType: 'runtime.failed',
    title: 'Pause requested',
    summaryFn: () => 'Agent requested to be paused.',
  },
  [AGENT_MESSAGE_TYPES.LIFECYCLE_STOP]: {
    category: 'runtime',
    severity: 'warn',
    eventType: 'runtime.failed',
    title: 'Stop requested',
    summaryFn: () => 'Agent requested to stop.',
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED]: {
    category: 'tick',
    severity: 'info',
    eventType: 'tick.started',
    title: 'Tick started',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'Agent tick started.';
      const trigger = typeof p['trigger'] === 'string' ? p['trigger'] : 'scheduled';
      const side = typeof p['positionSide'] === 'string' ? ` (position: ${p['positionSide']})` : '';
      return `Tick started — trigger: ${trigger}${side}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED]: {
    category: 'tick',
    severity: 'info',
    eventType: 'tick.skipped',
    title: 'Tick skipped',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'Tick skipped.';
      const reason = typeof p['reason'] === 'string' ? p['reason'] : 'unknown';
      const gate = typeof p['gate'] === 'string' ? ` (gate: ${p['gate']})` : '';
      return `Tick skipped — ${reason}${gate}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_HELD]: {
    category: 'tick',
    severity: 'info',
    eventType: 'scout.held',
    title: 'Scout held',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'Scout decided to hold — no judge dispatch this tick.';
      const reason = typeof p['reason'] === 'string' ? p['reason'] : 'unspecified';
      return `Scout held — ${reason}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_ESCALATED]: {
    category: 'tick',
    severity: 'info',
    eventType: 'scout.escalated',
    title: 'Scout escalated',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'Scout escalated to judge.';
      const reason = typeof p['reason'] === 'string' ? p['reason'] : 'unspecified';
      return `Scout escalated to judge — ${reason}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH]: {
    category: 'tick',
    severity: 'info',
    eventType: 'llm.dispatch',
    title: 'LLM dispatched',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'LLM call dispatched.';
      const phase = typeof p['phase'] === 'string' ? p['phase'] : 'unknown';
      const model = typeof p['model'] === 'string' ? p['model'] : 'unknown';
      return `${phase} LLM dispatched — model: ${model}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.LLM_COMPLETED]: {
    category: 'tick',
    severity: 'info',
    eventType: 'llm.completed',
    title: 'LLM completed',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'LLM call completed.';
      const phase = typeof p['phase'] === 'string' ? p['phase'] : 'unknown';
      const model = typeof p['model'] === 'string' ? p['model'] : 'unknown';
      const turns = typeof p['turnsUsed'] === 'number' ? p['turnsUsed'] : '?';
      const finish = typeof p['finishReason'] === 'string' ? p['finishReason'] : 'unknown';
      return `${phase} LLM completed — model: ${model}, turns: ${turns}, finish: ${finish}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL]: {
    category: 'tool',
    severity: 'info',
    eventType: 'tool.called',
    title: 'Tool called',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'Agent invoked a tool.';
      const toolName = typeof p['toolName'] === 'string' ? p['toolName'] : 'unknown';
      const phase = typeof p['phase'] === 'string' ? p['phase'] : 'unknown';
      return `${phase}: called ${toolName}.`;
    },
  },
  [AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_RESULT]: {
    category: 'tool',
    severity: 'info',
    eventType: 'tool.result',
    title: 'Tool result',
    summaryFn: (row) => {
      const p = row.payload;
      if (!p) return 'Tool result received.';
      const toolName = typeof p['toolName'] === 'string' ? p['toolName'] : 'unknown';
      const status = typeof p['status'] === 'string' ? p['status'] : 'unknown';
      const summary = typeof p['summary'] === 'string' ? ` — ${p['summary']}` : '';
      return `${toolName}: ${status}${summary}`;
    },
  },
};

// ---------------------------------------------------------------------------
// Mapper: protocol message → activity entry
// ---------------------------------------------------------------------------

export function mapProtocolMessage(row: RawAgentMessage): AgentActivityEntry {
  const classification = MESSAGE_CLASSIFICATIONS[row.type];

  if (classification) {
    const severity: AgentActivitySeverity =
      row.processingStatus === 'failed' || row.processingStatus === 'rejected' || isRuntimeActivityWarn(row)
        ? 'warn'
        : classification.severity;

    return {
      id: row.id,
      agentId: row.agentId,
      timestamp: row.createdAt.toISOString(),
      category: classification.category,
      severity,
      eventType: classification.eventType,
      title: classification.title,
      summary: classification.summaryFn(row),
      detail: {
        messageType: row.type,
        actorType: row.actorType,
        ...(row.botId ? { botId: row.botId } : {}),
        ...(row.errorDetail ? { errorCode: row.errorDetail.code, errorMessage: row.errorDetail.message } : {}),
        ...(row.payload ? { payload: row.payload } : {}),
      },
      sessionId: null,
      direction: row.direction,
      processingStatus: row.processingStatus,
      correlationId: row.correlationId,
      traceId: row.traceId,
    };
  }

  // Fallback: unrecognized message type
  return {
    id: row.id,
    agentId: row.agentId,
    timestamp: row.createdAt.toISOString(),
    category: 'system',
    severity: row.processingStatus === 'failed' ? 'warn' : 'info',
    eventType: 'runtime.started',
    title: row.type.replace(/\./g, ' '),
    summary: `Protocol message: ${row.type}`,
    detail: {
      messageType: row.type,
      actorType: row.actorType,
      direction: row.direction,
    },
    sessionId: null,
    direction: row.direction,
    processingStatus: row.processingStatus,
    correlationId: row.correlationId,
    traceId: row.traceId,
  };
}

// ---------------------------------------------------------------------------
// Mapper: runtime session → activity entries (start, health transitions)
// ---------------------------------------------------------------------------

export function mapRuntimeSession(session: RawRuntimeSession): AgentActivityEntry[] {
  const entries: AgentActivityEntry[] = [];

  // Session started
  entries.push({
    id: `session-start-${session.id}`,
    agentId: session.agentId,
    timestamp: session.startedAt.toISOString(),
    category: 'runtime',
    severity: 'info',
    eventType: 'runtime.started',
    title: 'Session started',
    summary: 'Agent runtime launched and heartbeat monitoring is active.',
    detail: { sessionStatus: session.status },
    sessionId: session.id,
    direction: null,
    processingStatus: null,
    correlationId: null,
    traceId: null,
  });

  // Session unhealthy
  if (session.status === 'unhealthy') {
    entries.push({
      id: `session-unhealthy-${session.id}`,
      agentId: session.agentId,
      timestamp: (session.lastHeartbeatAt ?? session.startedAt).toISOString(),
      category: 'runtime',
      severity: 'warn',
      eventType: 'runtime.unhealthy',
      title: 'Runtime unhealthy',
      summary: 'Agent runtime heartbeat missed or health check degraded.',
      detail: { sessionStatus: session.status },
      sessionId: session.id,
      direction: null,
      processingStatus: null,
      correlationId: null,
      traceId: null,
    });
  }

  // Session crashed
  if (session.status === 'crashed') {
    entries.push({
      id: `session-crashed-${session.id}`,
      agentId: session.agentId,
      timestamp: (session.stoppedAt ?? session.lastHeartbeatAt ?? session.startedAt).toISOString(),
      category: 'runtime',
      severity: 'critical',
      eventType: 'runtime.failed',
      title: 'Runtime crashed',
      summary: 'Agent runtime process terminated unexpectedly.',
      detail: { sessionStatus: session.status },
      sessionId: session.id,
      direction: null,
      processingStatus: null,
      correlationId: null,
      traceId: null,
    });
  }

  // Session stopped normally
  if (session.status === 'stopped' && session.stoppedAt) {
    entries.push({
      id: `session-stopped-${session.id}`,
      agentId: session.agentId,
      timestamp: session.stoppedAt.toISOString(),
      category: 'runtime',
      severity: 'info',
      eventType: 'runtime.started',
      title: 'Session stopped',
      summary: 'Agent runtime shut down gracefully.',
      detail: { sessionStatus: session.status },
      sessionId: session.id,
      direction: null,
      processingStatus: null,
      correlationId: null,
      traceId: null,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Mapper: outbound message → activity entry
// ---------------------------------------------------------------------------

export function mapOutboundMessage(msg: RawOutboundMessage): AgentActivityEntry {
  return {
    id: `msg-${msg.id}`,
    agentId: msg.agentId,
    timestamp: msg.createdAt.toISOString(),
    category: 'message',
    severity: 'info',
    eventType: 'message.authored',
    title: msg.authoredBy === 'platform' ? 'Platform message' : 'Agent message',
    summary: msg.subject ?? msg.body.slice(0, 100),
    detail: {
      authoredBy: msg.authoredBy,
      messageClass: msg.messageClass,
      deliveryStatus: msg.deliveryStatus,
      ...(msg.subject ? { subject: msg.subject } : {}),
    },
    sessionId: msg.sessionId,
    direction: 'outbound',
    processingStatus: msg.deliveryStatus,
    correlationId: null,
    traceId: null,
  };
}

// ---------------------------------------------------------------------------
// Mapper: artifact → activity entry
// ---------------------------------------------------------------------------

export function mapArtifact(artifact: RawArtifact): AgentActivityEntry {
  return {
    id: `artifact-${artifact.id}`,
    agentId: artifact.agentId,
    timestamp: artifact.createdAt.toISOString(),
    category: 'artifact',
    severity: 'info',
    eventType: 'artifact.published',
    title: 'Artifact published',
    summary: artifact.summary ?? `Published ${artifact.artifactType} (${artifact.contentType})`,
    detail: {
      artifactType: artifact.artifactType,
      contentType: artifact.contentType,
    },
    sessionId: artifact.sessionId,
    direction: null,
    processingStatus: null,
    correlationId: null,
    traceId: null,
  };
}
