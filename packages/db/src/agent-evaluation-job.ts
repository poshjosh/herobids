import type { ResolvedEvaluationScope } from '@herobids/domain';

/**
 * BullMQ queue name for agent evaluation jobs.
 */
export const EVALUATION_QUEUE_NAME = 'agent-evaluations';

/**
 * Job data contract shared by the API (enqueue) and worker (consume).
 *
 * The resolved scope is always concrete — `latestSession` has been expanded
 * to a concrete session ID before enqueue.
 */
export interface EvaluationJobData {
  runId: string;
  agentId: string;
  resolvedScope: ResolvedEvaluationScope;
  includeNarrative: boolean;
}
