import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from './index.js';
import { llmDecisionArtifacts } from './schema/index.js';

/**
 * Source discriminator for llm_decision_artifacts.
 * - llm_strategy: 1 artifact : 1 decision (traditional LlmStrategy path)
 * - hybrid_evaluator: 1 artifact : N decisions (scanner-gated hybrid evaluator)
 */
export type LlmArtifactSource = 'llm_strategy' | 'hybrid_evaluator';

export interface InsertLlmArtifact {
  /** Single decision ID (null for hybrid_evaluator 1:N) */
  decisionId: string | null;
  /** Array of decision UUIDs (null for llm_strategy 1:1) */
  decisionIds: string[] | null;
  source: LlmArtifactSource;
  contextHash: string;
  context: Record<string, unknown>;
  promptPayload: string;
  promptVersion: string;
  rawResponse: string | null;
  parsedDecision: Record<string, unknown> | null;
  parseStatus: string;
  parseError?: string | null;
  provider: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  cached: boolean;
}

export class LlmArtifactRepository {
  constructor(private readonly db: Database) {}

  async insert(artifact: InsertLlmArtifact): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(llmDecisionArtifacts).values({
      id,
      decisionId: artifact.decisionId,
      decisionIds: artifact.decisionIds,
      source: artifact.source,
      contextHash: artifact.contextHash,
      context: artifact.context,
      promptPayload: artifact.promptPayload,
      promptVersion: artifact.promptVersion,
      rawResponse: artifact.rawResponse,
      parsedDecision: artifact.parsedDecision,
      parseStatus: artifact.parseStatus,
      parseError: artifact.parseError ?? null,
      provider: artifact.provider,
      model: artifact.model,
      tokensUsed: artifact.tokensUsed,
      latencyMs: artifact.latencyMs,
      cached: artifact.cached,
    });
    return id;
  }

  async getByDecisionId(decisionId: string) {
    const [row] = await this.db
      .select()
      .from(llmDecisionArtifacts)
      .where(eq(llmDecisionArtifacts.decisionId, decisionId))
      .limit(1);
    return row ?? null;
  }
}
