import type { LlmProviderConfig, LlmResult } from '@herobids/llm';
import { callLlmProvider } from '@herobids/llm';
import { z } from 'zod';
import { HybridAgentDecisionSchema, type HybridAgentDecision } from '@herobids/domain';
import type { RuntimeCompositionState, TechnicalScanState } from './runtime-composition.js';
import { buildHybridPrompt, type HybridPromptInput } from './hybrid-agent-prompt.js';

// ─── Response schemas ────────────────────────────────────────────────────────

const HybridAgentResponseSchema = z.array(HybridAgentDecisionSchema);

export function isTechnicalScanFresh(scan: TechnicalScanState, nowMs = Date.now()): boolean {
  const scanTimestampMs = Date.parse(scan.timestamp);
  if (!Number.isFinite(scanTimestampMs)) {
    return false;
  }

  return nowMs - scanTimestampMs <= 2 * scan.scanIntervalMs;
}

function resolveDecisionInstrumentId(
  decision: HybridAgentDecision,
  input: HybridEvaluatorInput,
): string | null {
  if (decision.instrumentId) {
    return decision.instrumentId;
  }

  if (!decision.symbol) {
    return null;
  }

  const scan = input.state.metrics.lastTechnicalScan;
  if (scan) {
    const exactSignalMatch = scan.signals.find((signal) => signal.instrumentId === decision.symbol);
    if (exactSignalMatch) {
      return exactSignalMatch.instrumentId;
    }

    const symbolSignalMatch = scan.signals.find((signal) => signal.symbol === decision.symbol);
    if (symbolSignalMatch) {
      return symbolSignalMatch.instrumentId;
    }

    if (scan.positionIndicators.some((indicator) => indicator.symbol === decision.symbol)) {
      return decision.symbol;
    }
  }

  const openPositionMatch = input.state.metrics.openPositions.find((position) => position.instrumentId === decision.symbol);
  return openPositionMatch?.instrumentId ?? null;
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface HybridEvaluatorInput {
  state: RuntimeCompositionState;
  llmConfig: LlmProviderConfig;
  maxPositions: number;
  /** Publish a decision to the inbound stream for engine processing */
  submitDecision: (instrumentId: string, intent: string, sizeUsd?: number) => Promise<void>;
  logger: {
    info: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    error: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

export interface HybridEvaluatorResult {
  decisionsSubmitted: number;
  decisionsSkipped: number;
  errors: string[];
  /** LLM usage metadata from the single-shot call — populated when the LLM call succeeds. */
  llmUsage?: {
    tokensUsed: number;
    thinkingTokens?: number;
    model: string;
    provider: string;
    responseId?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Run a single-shot hybrid evaluation:
 * 1. Build a constrained prompt from scanner signals + portfolio state
 * 2. Call the LLM (no tools, single turn)
 * 3. Parse the structured JSON response
 * 4. Submit each decision via the engine intake
 */
export async function runHybridEvaluator(input: HybridEvaluatorInput): Promise<HybridEvaluatorResult> {
  const { state, llmConfig, maxPositions, submitDecision, logger } = input;

  const result: HybridEvaluatorResult = {
    decisionsSubmitted: 0,
    decisionsSkipped: 0,
    errors: [],
  };

  // Guard: require scanner data
  const scan = state.metrics.lastTechnicalScan;
  if (!scan) {
    logger.warn('Hybrid evaluator: no technical scan data available — skipping');
    result.errors.push('missing_scan');
    return result;
  }

  if (!isTechnicalScanFresh(scan)) {
    logger.warn({ timestamp: scan.timestamp, scanIntervalMs: scan.scanIntervalMs },
      'Hybrid evaluator: technical scan data is stale — skipping');
    result.errors.push('stale_scan');
    return result;
  }

  // Build prompt
  const promptInput: HybridPromptInput = {
    scan,
    portfolio: state.metrics.portfolio,
    openPositions: state.metrics.openPositions,
    maxPositions,
  };
  const prompt = buildHybridPrompt(promptInput);

  // Call LLM (single-shot, no tools)
  let llmResult: LlmResult;
  try {
    llmResult = await callLlmProvider(llmConfig, {
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Evaluate the signals above and respond with a JSON array of decisions.' },
      ],
      maxTokens: llmConfig.maxTokens,
      temperature: 0,
      toolChoice: 'none',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Hybrid evaluator: LLM call failed');
    result.errors.push(`llm_call_failed: ${msg}`);
    return result;
  }

  if (!llmResult.ok) {
    logger.error({ error: llmResult.error }, 'Hybrid evaluator: LLM returned error');
    result.errors.push(`llm_error: ${llmResult.error.code} — ${llmResult.error.message}`);
    return result;
  }

  const content = llmResult.data.content;
  logger.info({
    tokensUsed: llmResult.data.tokensUsed,
    latencyMs: llmResult.data.latencyMs,
  }, 'Hybrid evaluator: LLM response received');

  // Populate LLM usage metadata so the caller can record session cost + billing.
  result.llmUsage = {
    tokensUsed: llmResult.data.tokensUsed,
    thinkingTokens: llmResult.data.thinkingTokens,
    model: llmResult.data.model,
    provider: llmResult.data.provider,
    responseId: llmResult.data.responseId,
    inputTokens: llmResult.data.inputTokens,
    outputTokens: llmResult.data.outputTokens,
  };

  // Extract JSON array from response (may be wrapped in markdown code fences)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
  const jsonStr = (jsonMatch[1] ?? content).trim();

  // Parse response
  let decisions: HybridAgentDecision[];
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    const validated = HybridAgentResponseSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn({ errors: validated.error.flatten(), rawResponse: content.slice(0, 500) },
        'Hybrid evaluator: LLM returned malformed JSON — skipping tick');
      result.errors.push(`malformed_response: ${validated.error.message}`);
      return result;
    }
    decisions = validated.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, rawResponse: content.slice(0, 500) },
      'Hybrid evaluator: failed to parse LLM response as JSON');
    result.errors.push(`parse_failed: ${msg}`);
    return result;
  }

  // Submit each decision
  for (const decision of decisions) {
    // 'skip' = no action on an entry signal; 'hold' = keep existing position as-is.
    // Neither requires a submission to the engine.
    if (decision.intent === 'skip' || decision.intent === 'hold') {
      result.decisionsSkipped++;
      continue;
    }

    const instrumentId = resolveDecisionInstrumentId(decision, input);
    if (!instrumentId) {
      result.decisionsSkipped++;
      result.errors.push(`unresolved_instrument(${decision.symbol ?? 'missing'})`);
      logger.warn({ decision }, 'Hybrid evaluator: could not resolve decision instrumentId — skipping');
      continue;
    }

    if (decision.intent === 'go_long' && decision.sizeUsd === undefined) {
      result.decisionsSkipped++;
      result.errors.push(`missing_size(${instrumentId})`);
      logger.warn({ instrumentId }, 'Hybrid evaluator: go_long decision missing sizeUsd — skipping');
      continue;
    }

    try {
      await submitDecision(instrumentId, decision.intent, decision.sizeUsd);
      result.decisionsSubmitted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`submit_failed(${instrumentId}): ${msg}`);
      logger.error({ err, instrumentId, intent: decision.intent }, 'Hybrid evaluator: decision submission failed');
    }
  }

  logger.info({
    decisionsSubmitted: result.decisionsSubmitted,
    decisionsSkipped: result.decisionsSkipped,
    errorCount: result.errors.length,
  }, 'Hybrid evaluator complete');

  return result;
}
