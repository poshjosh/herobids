import type { AgentCreateRule } from './agent-create-policy.js';

/**
 * Closed outcome set for `create_child_agent` attempts. Labels are bounded: no ids, no free text.
 * Recorded as one structured log line per attempt (see docs/tech/architecture/observability.md).
 */
export const CREATE_AGENT_OUTCOMES = [
  'success',
  'rate',
  'allowance',
  'depth',
  'plan_total',
  'limiter_unavailable',
  'grant_refused',
  'field_refused',
  'duplicate',
  'other',
] as const;

export type CreateAgentOutcome = (typeof CREATE_AGENT_OUTCOMES)[number];

const outcomeSet = new Set<string>(CREATE_AGENT_OUTCOMES);

export function isCreateAgentOutcome(value: string): value is CreateAgentOutcome {
  return outcomeSet.has(value);
}

/** Structural logger, so tests need no Fastify instance. Fastify's request logger satisfies it. */
export interface CreateAgentMetricsLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

/** Emits one `agent.create_attempt` line. A value outside the closed set is dropped, not recorded. */
export function recordCreateAgentAttempt(log: CreateAgentMetricsLogger, outcome: string): boolean {
  if (!isCreateAgentOutcome(outcome)) return false;
  log.info({ evt: 'agent.create_attempt', outcome }, 'create_child_agent attempt');
  return true;
}

/** Maps a policy refusal rule onto its metric outcome. Ownership and permission refusals count as `other`. */
export function createAgentOutcomeForRule(rule: AgentCreateRule): CreateAgentOutcome {
  switch (rule) {
    case 'rate': return 'rate';
    case 'limiter': return 'limiter_unavailable';
    case 'allowance': return 'allowance';
    case 'depth': return 'depth';
    case 'plan_total': return 'plan_total';
    case 'grant': return 'grant_refused';
    case 'ownership':
    case 'permission': return 'other';
  }
}

const outcomeByRequest = new WeakMap<object, CreateAgentOutcome>();

/** The route sets the outcome at each refusal and at success. The route's onResponse hook records it once. */
export function setCreateAgentOutcome(request: object, outcome: CreateAgentOutcome): void {
  outcomeByRequest.set(request, outcome);
}

export function takeCreateAgentOutcome(request: object): CreateAgentOutcome {
  return outcomeByRequest.get(request) ?? 'other';
}
