import crypto from 'node:crypto';
import type { LlmProviderConfig, LlmResult } from '@herobids/llm';
import { callLlmProvider, stripEmptyValues } from '@herobids/llm';
import { z } from 'zod';
import { HybridAgentDecisionSchema, type HybridAgentDecision, type ScannerWakeContext } from '@herobids/domain';
import type { HybridPricingIdentity, RuntimeCompositionState, TechnicalScanState } from './runtime-composition.js';
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

/** 004: Determines whether the current tick should route through the single-shot
 *  hybrid evaluator instead of the full scout/judge loop.
 *
 *  - scanner_gated: only scanner wakes (reminders and user messages fall through to scout/judge).
 *  - mixed: only scanner wakes with a fresh technical scan. */
export function canRouteToHybridEvaluator(params: {
  isHybrid: boolean;
  isScannerGated: boolean;
  hasTradingCapability: boolean;
  hasWakeSignal?: boolean;
  isScannerWake: boolean;
  latestTechnicalScan?: TechnicalScanState;
  latestScannerContext?: ScannerWakeContext;
}): boolean {
  if (!params.isHybrid || !params.hasTradingCapability || !params.hasWakeSignal) {
    return false;
  }

  // preset_review scanner wakes must NOT route into the single-shot hybrid entry evaluator.
  // These wakes carry platform assessment recommendations, not trading signals.
  // They require multi-turn tool calls (assess → review results → decide → change)
  // which the single-shot hybrid evaluator cannot support. Falls through to scout/judge.
  if (params.isScannerWake && params.latestScannerContext?.scannerKind === 'preset_review') {
    return false;
  }

  // assessment_review scanner wakes must NOT route into the hybrid entry evaluator.
  // These wakes carry deterministic scanner pre-check advice, not trading signals.
  // They require multi-turn tool calls (assess_strategy_preset → review rankings →
  // change_strategy_preset) which the single-shot hybrid evaluator cannot support.
  // The scout/judge loop injects the assessment message into the LLM context and
  // supports the multi-turn workflow needed for preset assessment and transition.
  if (params.isScannerWake && params.latestScannerContext?.scannerKind === 'assessment_review') {
    return false;
  }

  if (params.isScannerGated) {
    return params.isScannerWake;
  }

  return params.isScannerWake
    && params.latestTechnicalScan !== undefined
    && isTechnicalScanFresh(params.latestTechnicalScan);
}

interface ResolvedDecisionIdentity {
  instrumentId: string;
  pricingIdentity?: HybridPricingIdentity;
}

function resolveDecisionInstrumentId(
  decision: HybridAgentDecision,
  input: HybridEvaluatorInput,
): ResolvedDecisionIdentity | null {
  if (decision.instrumentId) {
    const id = decision.instrumentId;
    const pricingIdentity = input.state.metrics.lastTechnicalScan?.pricingIdentities?.[id];
    return { instrumentId: id, pricingIdentity };
  }

  if (!decision.symbol) {
    return null;
  }

  const scan = input.state.metrics.lastTechnicalScan;
  if (scan) {
    const exactSignalMatch = scan.signals.find((signal) => signal.instrumentId === decision.symbol);
    if (exactSignalMatch) {
      const id = exactSignalMatch.instrumentId;
      const pricingIdentity = scan.pricingIdentities?.[id];
      return { instrumentId: id, pricingIdentity };
    }

    const symbolSignalMatch = scan.signals.find((signal) => signal.symbol === decision.symbol);
    if (symbolSignalMatch) {
      // Phase 4: DEX signals resolved by symbol-only may be ambiguous
      // (same ticker on different chains). Log a warning so operators
      // can detect when the LLM omits the exact instrument ID.
      if (symbolSignalMatch.venueType === 'swap') {
        input.logger.warn(
          {
            symbol: decision.symbol,
            resolvedInstrumentId: symbolSignalMatch.instrumentId,
            note: 'LLM resolved DEX signal by symbol only — potential ambiguity for same-ticker tokens on different chains',
          },
          'Hybrid evaluator: DEX signal resolved by display symbol — prefer exact instrumentId from the LLM',
        );
      }
      const id = symbolSignalMatch.instrumentId;
      const pricingIdentity = scan.pricingIdentities?.[id];
      return { instrumentId: id, pricingIdentity };
    }

    if (scan.positionIndicators.some((indicator) => indicator.symbol === decision.symbol)) {
      return { instrumentId: decision.symbol };
    }
  }

  const openPositionMatch = input.state.metrics.openPositions.find((position) => position.instrumentId === decision.symbol);
  return openPositionMatch ? { instrumentId: openPositionMatch.instrumentId } : null;
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface HybridEvaluatorInput {
  state: RuntimeCompositionState;
  llmConfig: LlmProviderConfig;
  maxPositions: number;
  /** Agent memory snapshot for hybrid prompt enrichment. */
  agentMemory?: Record<string, { value: unknown; updatedAt?: string }> | null;
  /** Max inline memory keys rendered in the hybrid prompt. */
  maxInlineMemoryKeys?: number;
  /** Recent judge responses (newest last) for context in the hybrid prompt. */
  recentJudgeResponses?: string[];
  /** Publish a decision to the inbound stream for engine processing.
   *  `pricingIdentity` is carried through from the scan layer so the hybrid
   *  runtime can convert USD-denominated size to base units using a
   *  chain/address-aware price lookup.
   *  Returns the decision ID assigned to the published decision. */
  submitDecision: (
    instrumentId: string,
    intent: string,
    sizeUsd?: number,
    pricingIdentity?: HybridPricingIdentity,
  ) => Promise<string>;
  /** Persist an LLM decision artifact for audit and cost tracking.
   *  Invoked after the LLM call resolves (success or failure). */
  onArtifact?: (artifact: {
    source: 'hybrid_evaluator';
    decisionIds: string[];
    contextHash: string;
    context: Record<string, unknown>;
    promptPayload: string;
    promptVersion: string;
    rawResponse: string | null;
    parseStatus: string;
    parseError?: string;
    provider: string;
    model: string;
    tokensUsed: number;
    latencyMs: number;
    cached: boolean;
  }) => Promise<void>;
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
    cachedInputTokens?: number;
  };
  /** LLM error when the call itself failed (timeout, server error, etc.) — populated instead of llmUsage. */
  llmError?: { code: string; message: string };
}

/**
 * Run a single-shot hybrid evaluation:
 * 1. Build a constrained prompt from scanner signals + portfolio state
 * 2. Call the LLM (no tools, single turn)
 * 3. Parse the structured JSON response
 * 4. Submit each decision via the engine intake
 */
export async function runHybridEvaluator(input: HybridEvaluatorInput): Promise<HybridEvaluatorResult> {
  const { state, llmConfig, maxPositions, submitDecision, onArtifact, logger } = input;

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
    agentMemory: input.agentMemory,
    maxInlineMemoryKeys: input.maxInlineMemoryKeys,
    recentJudgeResponses: input.recentJudgeResponses,
    venueSignals: state.metrics.venueSignals,
  };
  const prompt = buildHybridPrompt(promptInput);

  const promptVersion = 'hybrid-v2';
  const contextHash = computeHybridContextHash(prompt);

  // Build context snapshot for artifact persistence
  const artifactContext: Record<string, unknown> = {
    scannerSignals: scan.signals.length,
    openPositions: state.metrics.openPositions.length,
    portfolio: state.metrics.portfolio,
    maxPositions,
  };

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

    // Emit artifact for provider failure
    await emitHybridArtifact(onArtifact, buildHybridArtifact({
      decisionIds: [],
      contextHash,
      context: artifactContext,
      promptPayload: prompt,
      promptVersion,
      rawResponse: null,
      parseStatus: 'provider_error',
      parseError: msg,
      provider: llmConfig.provider,
      model: llmConfig.model,
      tokensUsed: 0,
      latencyMs: 0,
    }));

    return result;
  }

  if (!llmResult.ok) {
    logger.error({ error: llmResult.error }, 'Hybrid evaluator: LLM returned error');
    result.errors.push(`llm_error: ${llmResult.error.code} — ${llmResult.error.message}`);
    result.llmError = { code: llmResult.error.code, message: llmResult.error.message };

    // Emit artifact for provider error
    await emitHybridArtifact(onArtifact, buildHybridArtifact({
      decisionIds: [],
      contextHash,
      context: artifactContext,
      promptPayload: prompt,
      promptVersion,
      rawResponse: null,
      parseStatus: 'provider_error',
      parseError: llmResult.error.message,
      provider: llmConfig.provider,
      model: llmConfig.model,
      tokensUsed: 0,
      latencyMs: 0,
    }));

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
    cachedInputTokens: llmResult.data.cachedInputTokens,
  };

  // Extract JSON array from response (may be wrapped in markdown code fences)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
  const jsonStr = (jsonMatch[1] ?? content).trim();

  // Parse response
  let decisions: HybridAgentDecision[];
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    const cleaned = Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === 'object' && item !== null ? stripEmptyValues(item as Record<string, unknown>) : item))
      : parsed;
    const validated = HybridAgentResponseSchema.safeParse(cleaned);
    if (!validated.success) {
      logger.warn({ errors: validated.error.flatten(), rawResponse: content.slice(0, 500) },
        'Hybrid evaluator: LLM returned malformed JSON — skipping tick');
      result.errors.push(`malformed_response: ${validated.error.message}`);

      // Emit artifact for parse failure
      await emitHybridArtifact(onArtifact, buildHybridArtifact({
        decisionIds: [],
        contextHash,
        context: artifactContext,
        promptPayload: prompt,
        promptVersion,
        rawResponse: content,
        parseStatus: 'parse_error',
        parseError: validated.error.message,
        provider: llmResult.data.provider,
        model: llmResult.data.model,
        tokensUsed: llmResult.data.tokensUsed,
        latencyMs: llmResult.data.latencyMs,
        cached: llmResult.data.cached,
      }));

      return result;
    }
    decisions = validated.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, rawResponse: content.slice(0, 500) },
      'Hybrid evaluator: failed to parse LLM response as JSON');
    result.errors.push(`parse_failed: ${msg}`);

    // Emit artifact for parse failure
    await emitHybridArtifact(onArtifact, buildHybridArtifact({
      decisionIds: [],
      contextHash,
      context: artifactContext,
      promptPayload: prompt,
      promptVersion,
      rawResponse: content,
      parseStatus: 'parse_error',
      parseError: msg,
      provider: llmResult.data.provider,
      model: llmResult.data.model,
      tokensUsed: llmResult.data.tokensUsed,
      latencyMs: llmResult.data.latencyMs,
      cached: llmResult.data.cached,
    }));

    return result;
  }

  // Submit each decision, tracking IDs for artifact persistence
  const submittedDecisionIds: string[] = [];
  for (const decision of decisions) {
    // 'skip' = no action on an entry signal; 'hold' = keep existing position as-is.
    // Neither requires a submission to the engine.
    if (decision.intent === 'skip' || decision.intent === 'hold') {
      result.decisionsSkipped++;
      continue;
    }

    const resolved = resolveDecisionInstrumentId(decision, input);
    if (!resolved) {
      result.decisionsSkipped++;
      result.errors.push(`unresolved_instrument(${decision.symbol ?? 'missing'})`);
      logger.warn({ decision }, 'Hybrid evaluator: could not resolve decision instrumentId — skipping');
      continue;
    }

    const instrumentId = resolved.instrumentId;

    if (decision.intent === 'go_long' && decision.sizeUsd === undefined) {
      result.decisionsSkipped++;
      result.errors.push(`missing_size(${instrumentId})`);
      logger.warn({ instrumentId }, 'Hybrid evaluator: go_long decision missing sizeUsd — skipping');
      continue;
    }

    try {
      const decisionId = await submitDecision(instrumentId, decision.intent, decision.sizeUsd, resolved.pricingIdentity);
      submittedDecisionIds.push(decisionId);
      result.decisionsSubmitted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`submit_failed(${instrumentId}): ${msg}`);
      logger.error({ err, instrumentId, intent: decision.intent }, 'Hybrid evaluator: decision submission failed');
    }
  }

  // Emit artifact for successful evaluation
  await emitHybridArtifact(onArtifact, buildHybridArtifact({
    decisionIds: submittedDecisionIds,
    contextHash,
    context: artifactContext,
    promptPayload: prompt,
    promptVersion,
    rawResponse: content,
    parseStatus: 'success',
    provider: llmResult.data.provider,
    model: llmResult.data.model,
    tokensUsed: llmResult.data.tokensUsed,
    latencyMs: llmResult.data.latencyMs,
    cached: llmResult.data.cached,
  }));

  logger.info({
    decisionsSubmitted: result.decisionsSubmitted,
    decisionsSkipped: result.decisionsSkipped,
    errorCount: result.errors.length,
  }, 'Hybrid evaluator complete');

  return result;
}

/**
 * Fire-and-forget artifact persistence — catch errors so a failing
 * artifact write never blocks the evaluator's return path.
 */
async function emitHybridArtifact(
  onArtifact: HybridEvaluatorInput['onArtifact'],
  artifact: Parameters<NonNullable<HybridEvaluatorInput['onArtifact']>>[0],
): Promise<void> {
  if (!onArtifact) return;
  try {
    await onArtifact(artifact);
  } catch {
    // Silently ignore — artifact persistence is best-effort audit, not a control-plane dependency.
  }
}

/**
 * Compute a SHA-256 hash of the hybrid prompt for context deduplication.
 * Matches the hashing approach used by LlmStrategy.buildContextHash.
 */
function computeHybridContextHash(prompt: string): string {
  return `hybrid-${crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`;
}

/**
 * Build a hybrid evaluator artifact record. All artifact emission sites
 * share the same shape with a few varying fields — this helper reduces
 * duplication and ensures consistency across error/success paths.
 */
function buildHybridArtifact(overrides: {
  contextHash: string;
  context: Record<string, unknown>;
  promptPayload: string;
  promptVersion: string;
  parseStatus: string;
  parseError?: string;
  rawResponse: string | null;
  tokensUsed: number;
  latencyMs: number;
  provider: string;
  model: string;
  decisionIds: string[];
  cached?: boolean;
}): Parameters<NonNullable<HybridEvaluatorInput['onArtifact']>>[0] {
  return {
    source: 'hybrid_evaluator' as const,
    cached: false,
    ...overrides,
  };
}
