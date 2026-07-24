import { pgTable, text, timestamp, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';

/**
 * LLM decision artifacts — audit trail for every LLM strategy / hybrid evaluator call.
 * Records prompt, response, parsing result, and provider details.
 *
 * Two source paths:
 * - llm_strategy: 1 artifact : 1 decision (decisionId set, decisionIds null)
 * - hybrid_evaluator: 1 artifact : N decisions (decisionId null, decisionIds set)
 */
export const llmDecisionArtifacts = pgTable('llm_decision_artifacts', {
  id: text('id').primaryKey(),
  /** Single decision ID — null for hybrid_evaluator (1:N). Use the nullable column directly; the old NOT NULL constraint is dropped by migration. */
  decisionId: text('decision_id'),
  /** Array of decision UUIDs — null for llm_strategy (1:1). */
  decisionIds: jsonb('decision_ids').$type<string[]>(),
  /** Discriminator: 'llm_strategy' | 'hybrid_evaluator' */
  source: text('source').notNull().default('llm_strategy'),
  contextHash: text('context_hash').notNull(),
  /** Normalized context that produced the prompt */
  context: jsonb('context').notNull().$type<Record<string, unknown>>(),
  /** The actual prompt sent to the provider */
  promptPayload: text('prompt_payload').notNull(),
  /** Prompt version identifier */
  promptVersion: text('prompt_version').notNull(),
  /** Raw provider response text (null on provider error) */
  rawResponse: text('raw_response'),
  /** Parsed structured decision (null on error) */
  parsedDecision: jsonb('parsed_decision').$type<Record<string, unknown>>(),
  /** Parse status: success | parse_error | provider_error */
  parseStatus: text('parse_status').notNull(),
  /** Parse error details (null on success) */
  parseError: text('parse_error'),
  /** Provider name */
  provider: text('provider').notNull(),
  /** Model identifier */
  model: text('model').notNull(),
  /** Tokens consumed */
  tokensUsed: integer('tokens_used').notNull().default(0),
  /** Response latency in milliseconds */
  latencyMs: integer('latency_ms').notNull().default(0),
  /** Whether the response was served from cache */
  cached: boolean('cached').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_llm_decision_artifacts_decision_id').on(t.decisionId),
  index('idx_llm_decision_artifacts_decision_ids').on(t.decisionIds),
  index('idx_llm_decision_artifacts_context_hash').on(t.contextHash),
]);
