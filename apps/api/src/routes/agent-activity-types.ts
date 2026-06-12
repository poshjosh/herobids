// ---------------------------------------------------------------------------
// Canonical Agent Activity DTO — shared contract for agent observability.
// Consumed by: agent detail timeline, Mission Control, shared Activity page.
// ---------------------------------------------------------------------------

export type AgentActivityCategory =
  | 'runtime'
  | 'decision'
  | 'tool'
  | 'tick'
  | 'message'
  | 'artifact'
  | 'risk'
  | 'system';

export type AgentActivitySeverity = 'info' | 'warn' | 'critical';

export type AgentActivityEventType =
  | 'runtime.started'
  | 'runtime.unhealthy'
  | 'runtime.recovered'
  | 'runtime.failed'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'message.authored'
  | 'system.alert'
  | 'artifact.published'
  | 'tick.started'
  | 'tick.skipped'
  | 'scout.held'
  | 'scout.escalated'
  | 'llm.dispatch'
  | 'llm.completed'
  | 'tool.called'
  | 'tool.result';

export interface AgentActivityEntry {
  id: string;
  agentId: string;
  timestamp: string;
  category: AgentActivityCategory;
  severity: AgentActivitySeverity;
  eventType: AgentActivityEventType;
  title: string;
  summary: string;
  detail: Record<string, unknown>;

  // Operator metadata — hidden by default, shown in expanded view
  sessionId: string | null;
  direction: string | null;
  processingStatus: string | null;
  correlationId: string | null;
  traceId: string | null;
}

export interface AgentActivityFeedResponse {
  entries: AgentActivityEntry[];
  hasMore: boolean;
}
