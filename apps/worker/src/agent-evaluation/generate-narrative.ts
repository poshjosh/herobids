import pino from 'pino';
import { callLlmWithRetry } from '../runtime-errors.js';
import { stripReasoningContent, type LlmProviderConfig, type LlmRequest } from '@herobids/llm';
import type { EvaluationScorecard, EvaluationFinding } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';

const logger = pino({ name: 'generate-narrative' });

// ── Public types ────────────────────────────────────────────────────────────

export interface NarrativeGenerationResult {
  /** The generated narrative text (null if generation failed) */
  text: string | null;
  /** Metadata for provenance — always present, even on failure */
  metadata: NarrativeGenerationMetadata;
}

export interface NarrativeGenerationMetadata {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrlUsed?: string;
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  generated: boolean;
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build base metadata populated from config — used as the starting point for both success and failure paths. */
function baseMetadata(config: ResolvedNarrativeLlmConfig): NarrativeGenerationMetadata {
  return {
    enabled: true,
    provider: config.provider,
    model: config.model,
    baseUrlUsed: config.baseUrl,
    tokensUsed: 0,
    latencyMs: 0,
    generated: false,
  };
}

/**
 * Build a concise prompt for the narrative LLM.
 * Uses only redacted deterministic inputs: scorecard, top findings, and report text.
 */
function buildNarrativePrompt(
  scorecard: EvaluationScorecard,
  topFindings: EvaluationFinding[],
  reportText: string,
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

  // Truncate report text to a reasonable length for the prompt (avoid token bloat).
  // The full report is still available as a standalone artifact.
  const maxReportChars = 8_000;
  const truncatedReport = reportText.length > maxReportChars
    ? reportText.slice(0, maxReportChars) + '\n\n[... report truncated for length ...]'
    : reportText;

  return `You are an expert trading system auditor writing a concise evaluation commentary.

Overall Score: ${scorecard.overallScore}/100

Section Scores:
${sectionLines.join('\n')}

Top Findings:
${findingLines.length > 0 ? findingLines.join('\n') : '- No significant findings.'}

Deterministic Report:
${truncatedReport}

Write a SHORT commentary (3-5 sentences) in Markdown format. Focus on the most important findings. Be direct and actionable. Do NOT use headings, lists, or code blocks — just plain paragraph text. Do NOT preface with "Here is the commentary" or similar meta-text.`;
}

/**
 * Generate LLM-powered evaluation narrative commentary.
 *
 * Best-effort: returns metadata on any failure so the evaluation can succeed
 * with the deterministic report alone.
 *
 * @returns Structured result with text (null on failure) and provenance metadata.
 */
export async function generateEvaluationNarrative(
  narrativeConfig: ResolvedNarrativeLlmConfig,
  scorecard: EvaluationScorecard,
  topFindings: EvaluationFinding[],
  reportText: string,
): Promise<NarrativeGenerationResult> {
  const meta = baseMetadata(narrativeConfig);

  const llmConfig: LlmProviderConfig = {
    provider: narrativeConfig.provider,
    model: narrativeConfig.model,
    maxTokens: narrativeConfig.maxTokens,
    timeoutMs: narrativeConfig.timeoutMs,
    baseUrl: narrativeConfig.baseUrl,
  };

  const prompt = buildNarrativePrompt(scorecard, topFindings, reportText);

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
      meta.error = result.error.message;
      return { text: null, metadata: meta };
    }

    const narrative = stripReasoningContent(result.data.content).trim();
    if (!narrative) {
      logger.warn('Narrative LLM returned empty content');
      meta.error = 'LLM returned empty content';
      return { text: null, metadata: meta };
    }

    meta.provider = result.data.provider;
    meta.model = result.data.model;
    meta.tokensUsed = result.data.tokensUsed;
    meta.inputTokens = result.data.inputTokens;
    meta.outputTokens = result.data.outputTokens;
    meta.latencyMs = result.data.latencyMs;
    meta.generated = true;

    logger.info(
      {
        provider: meta.provider,
        model: meta.model,
        tokensUsed: meta.tokensUsed,
        latencyMs: meta.latencyMs,
      },
      'Narrative generated successfully',
    );

    return { text: narrative, metadata: meta };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn(
      { err: message },
      'Narrative generation threw — continuing without commentary',
    );
    meta.error = message;
    return { text: null, metadata: meta };
  }
}
