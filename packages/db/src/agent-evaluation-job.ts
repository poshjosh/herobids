import type { ResolvedEvaluationScope, OpenRouterProviderControlsConfig } from '@herobids/domain';

/**
 * BullMQ queue name for agent evaluation jobs.
 */
export const EVALUATION_QUEUE_NAME = 'agent-evaluations';

/**
 * Fully resolved narrative LLM configuration carried in the job payload.
 * This is resolved at enqueue time so the worker never needs to
 * re-derive provider/model selection.
 */
export interface ResolvedNarrativeLlmConfig {
  provider: string;
  model: string;
  /** Base URL override (set when using operator-configured provider). */
  baseUrl?: string;
  /** LLM call timeout in milliseconds. */
  timeoutMs: number;
  /** Maximum tokens for the narrative generation response. */
  maxTokens: number;
  /** OpenRouter provider controls for privacy enforcement. */
  openRouterProviderControls?: OpenRouterProviderControlsConfig;
}

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
  /** Fully resolved narrative LLM config. Resolved at enqueue time when includeNarrative is true and resolution succeeds. */
  narrativeLlm?: ResolvedNarrativeLlmConfig;
}
