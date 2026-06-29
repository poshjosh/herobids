import pino from 'pino';
import { callLlmWithRetry } from '../runtime-errors.js';
import { stripReasoningContent, type LlmProviderConfig, type LlmRequest } from '@herobids/llm';
import type { EvaluationScorecard, EvaluationFinding } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';

const logger = pino({ name: 'generate-narrative' });

/**
 * Build a concise prompt for the narrative LLM.
 * Uses only redacted deterministic inputs: scorecard + top findings.
 */
function buildNarrativePrompt(
  scorecard: EvaluationScorecard,
  topFindings: EvaluationFinding[],
): string {
  const sectionLines = scorecard.sections
    .filter((s) => s.applicable)
    .map((s) => {
      const label = s.section.replace(/_/g, ' ');
      return `- ${label}: ${s.score}/100`;
    });

  const findingLines = topFindings.map((f) => {
    return `- [${f.severity.toUpperCase()}] ${f.code}: ${f.title} — ${f.detail}`;
  });

  return `You are an expert trading system auditor writing a concise evaluation commentary.

Overall Score: ${scorecard.overallScore}/100

Section Scores:
${sectionLines.join('\n')}

Top Findings:
${findingLines.length > 0 ? findingLines.join('\n') : '- No significant findings.'}

Write a SHORT commentary (3-5 sentences) in Markdown format. Focus on the most important findings. Be direct and actionable. Do NOT use headings, lists, or code blocks — just plain paragraph text. Do NOT preface with "Here is the commentary" or similar meta-text.`;
}

/**
 * Generate LLM-powered evaluation narrative commentary.
 *
 * Best-effort: returns null on any failure so the evaluation can succeed
 * with the deterministic report alone.
 *
 * @returns The generated narrative text, or null if generation failed.
 */
export async function generateEvaluationNarrative(
  narrativeConfig: ResolvedNarrativeLlmConfig,
  scorecard: EvaluationScorecard,
  topFindings: EvaluationFinding[],
): Promise<string | null> {
  const llmConfig: LlmProviderConfig = {
    provider: narrativeConfig.provider,
    model: narrativeConfig.model,
    maxTokens: narrativeConfig.maxTokens,
    timeoutMs: narrativeConfig.timeoutMs,
    baseUrl: narrativeConfig.baseUrl,
  };

  const prompt = buildNarrativePrompt(scorecard, topFindings);

  const request: LlmRequest = {
    messages: [
      { role: 'user', content: prompt },
    ],
    maxTokens: narrativeConfig.maxTokens,
    temperature: 0,
    toolChoice: 'none',
  };

  try {
    logger.info(
      { provider: narrativeConfig.provider, model: narrativeConfig.model },
      'Calling LLM for evaluation narrative',
    );

    const { result } = await callLlmWithRetry(llmConfig, request, {
      maxRetries: 1, // Single retry for narrative (best-effort)
      timeoutBackoffMs: [5_000],
    });

    if (!result.ok) {
      logger.warn(
        { error: result.error },
        'Narrative LLM call failed — continuing without commentary',
      );
      return null;
    }

    const narrative = stripReasoningContent(result.data.content).trim();
    if (!narrative) {
      logger.warn('Narrative LLM returned empty content');
      return null;
    }

    logger.info(
      {
        provider: result.data.provider,
        model: result.data.model,
        tokensUsed: result.data.tokensUsed,
        latencyMs: result.data.latencyMs,
      },
      'Narrative generated successfully',
    );

    return narrative;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      'Narrative generation threw — continuing without commentary',
    );
    return null;
  }
}
