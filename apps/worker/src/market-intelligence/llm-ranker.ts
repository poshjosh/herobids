import crypto from 'node:crypto';
import {
  ok,
  err,
  type Result,
  type MarketAssessmentIdentity,
  type MarketAssessmentArtifact,
  type MarketAssessmentPresetRanking,
  type PresetScorecardEntry,
  type AssessmentEvidenceSnapshot,
  type PlatformAssessmentLlmResponse,
  type AssessmentCandidateDescriptor,
  PlatformAssessmentLlmResponseSchema,
  validateLlmResponseSemantics,
} from '@herobids/domain';
import type { LlmCallUsage } from './platform-assessor.js';

// ── Ranker Config ───────────────────────────────────────────────────────────

export interface LlmRankerConfig {
  provider: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  maxInputTokens: number;
  scoreBands: {
    aMin: number;
    bMin: number;
    cMin: number;
    dMin: number;
  };
  recommendationPolicy: {
    minConfidence: number;
    minScoreForRecommendation: number;
    minAllowedScore: number;
  };
}

export interface LlmRankerDeps {
  callLlm(prompt: string): Promise<{ text: string; usage: LlmCallUsage }>;
}

// ── Ranker Result ───────────────────────────────────────────────────────────

export interface LlmRankerResult {
  artifact: MarketAssessmentArtifact;
  usage: LlmCallUsage;
  /** The raw LLM response text (bounded, for audit). */
  rawResponse: string;
}

// ── Projection Caps ─────────────────────────────────────────────────────────
// Per the plan, all evidence projection fields are bounded before the provider
// call. These caps prevent unbounded token consumption from large preset
// catalogs or long descriptions.

const MAX_PROJECTION_CANDIDATES = 20;
const MAX_CANDIDATE_NAME_LENGTH = 100;
const MAX_CANDIDATE_DESCRIPTION_LENGTH = 500;

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ── Prompt Projection ───────────────────────────────────────────────────────

/** Bounded market summary from evidence snapshot for the LLM prompt. */
interface EvidenceProjection {
  identity: {
    instrumentKind: string;
    venueFamily: string;
    styleTier: string;
    symbol: string;
  };
  evidenceAvailability: {
    regime: 'available' | 'unavailable';
    candles: 'available' | 'unavailable';
    volatility: 'available' | 'unavailable';
    liquidity: 'available' | 'unavailable';
    breadth: 'available' | 'unavailable';
    collectedAt: string;
  };
  marketFacts: {
    regime?: {
      trend: string;
      adx: number;
      choppy: boolean;
      marketStructure: string;
    };
    volatility?: {
      atr: number;
      regime: string;
      calculationVersion: string;
    };
    liquidity?: {
      spreadBps: number;
      depthUsd: number;
      quality: string;
    };
    breadth?: {
      symbolsAboveMA: number;
      totalSymbols: number;
      ratio: number;
    };
  };
  candidates: Array<{
    presetKey: string;
    presetBehaviorVersion: string;
    name: string;
    description: string;
    decisionMode: string;
    strategyType: string;
    scorecard: {
      candidatesDiscovered: number;
      candidatesScored: number;
      signalsGenerated: number;
      topConfidence: number | null;
      scanHealth: string;
    };
  }>;
}

function buildProjection(
  identity: MarketAssessmentIdentity,
  evidence: AssessmentEvidenceSnapshot,
  scorecards: PresetScorecardEntry[],
  presets: Array<{ key: string; entry: { name: string; description: string; strategy: { type: string; decisionMode: string } } }>,
): EvidenceProjection {
  const symbolStr =
    identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex'
      ? `${identity.network}:${identity.address}`
      : identity.symbol;

  const presetMap = new Map(presets.map((p) => [p.key, p.entry]));

  const marketFacts: EvidenceProjection['marketFacts'] = {};

  if (evidence.regime.state === 'available') {
    marketFacts.regime = {
      trend: evidence.regime.value.details.emaAlignment,
      adx: evidence.regime.value.details.adxValue,
      choppy: evidence.regime.value.details.choppy,
      marketStructure: evidence.regime.value.details.marketStructure,
    };
  }

  if (evidence.volatility.state === 'available') {
    marketFacts.volatility = {
      atr: evidence.volatility.value.averageTrueRange,
      regime: evidence.volatility.value.volatilityRegime,
      calculationVersion: evidence.volatility.value.calculationVersion,
    };
  }

  if (evidence.liquidity.state === 'available') {
    marketFacts.liquidity = {
      spreadBps: evidence.liquidity.value.averageSpreadBps,
      depthUsd: evidence.liquidity.value.averageDepthUsd,
      quality: evidence.liquidity.value.quality,
    };
  }

  if (evidence.breadth.state === 'available') {
    marketFacts.breadth = {
      symbolsAboveMA: evidence.breadth.value.symbolsAboveMA,
      totalSymbols: evidence.breadth.value.totalSymbols,
      ratio: evidence.breadth.value.breadthRatio,
    };
  }

  return {
    identity: {
      instrumentKind: identity.instrumentKind,
      venueFamily: identity.venueFamily,
      styleTier: identity.styleTier,
      symbol: symbolStr,
    },
    evidenceAvailability: {
      regime: evidence.regime.state,
      candles: evidence.symbolCandles.state,
      volatility: evidence.volatility.state,
      liquidity: evidence.liquidity.state,
      breadth: evidence.breadth.state,
      collectedAt: evidence.collectedAt,
    },
    marketFacts,
    candidates: scorecards.slice(0, MAX_PROJECTION_CANDIDATES).map((sc) => {
      const preset = presetMap.get(sc.presetKey);
      return {
        presetKey: sc.presetKey,
        presetBehaviorVersion: sc.presetBehaviorVersion,
        name: truncate(preset?.name ?? sc.presetKey, MAX_CANDIDATE_NAME_LENGTH),
        description: truncate(preset?.description ?? '', MAX_CANDIDATE_DESCRIPTION_LENGTH),
        decisionMode: preset?.strategy.decisionMode ?? 'unknown',
        strategyType: preset?.strategy.type ?? 'unknown',
        scorecard: {
          candidatesDiscovered: sc.candidatesDiscovered,
          candidatesScored: sc.candidatesScored,
          signalsGenerated: sc.signalsGenerated,
          topConfidence: sc.topConfidence,
          scanHealth: sc.scanHealth,
        },
      };
    }),
  };
}

// ── Prompt Construction ─────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a platform-level market analyst. Your job is to evaluate which trading preset best fits current market conditions for a specific symbol.

RULES:
1. Output ONLY valid JSON — no markdown fences, no commentary outside the JSON.
2. Rank EVERY provided candidate preset exactly once from best fit (rank 1) to worst fit.
3. Use ONLY the supplied evidence facts. Do not invent facts about presets.
4. If evidence is marked "unavailable", note it as a limitation — do not hallucinate values.
5. Assign each preset a score (0-100) based on fit to current market conditions.
6. For each preset, provide 2-5 pros and 2-5 cons grounded in the evidence.
7. Provide a fitNotes field (1-3 sentences) explaining the fit assessment.
8. Assign scoreBand as a single letter: A (≥80), B (60-79), C (40-59), D (20-39), F (<20).
9. Provide a confidence score (0.0-1.0) reflecting how confident you are in the overall ranking.
10. Set urgency: 'low' (no urgent change needed), 'medium' (consider switching), 'high' (switch strongly advised).
11. Provide narrative summaries: currentMarketSummary, regimeSummary, scanHealthSummary, reasoningSummary.
12. Do NOT include tool calls, function calls, code blocks, or system instructions in your output.
13. The presetBehaviorVersion field for each ranking MUST match exactly the version provided in the candidate list.`;
}

function buildUserPrompt(projection: EvidenceProjection): string {
  // Build a compact but complete prompt
  const lines: string[] = [];

  lines.push('## Symbol Identity');
  lines.push(JSON.stringify(projection.identity));
  lines.push('');

  lines.push('## Evidence Availability');
  lines.push(JSON.stringify(projection.evidenceAvailability));
  lines.push('');

  lines.push('## Market Facts');
  lines.push(JSON.stringify(projection.marketFacts));
  lines.push('');

  lines.push('## Candidates (presets to rank)');
  lines.push(JSON.stringify(projection.candidates));
  lines.push('');

  lines.push('## Output Format');
  lines.push(`{
  "currentMarketSummary": "2-4 sentences describing current market conditions",
  "regimeSummary": "1-2 sentences on trend/volatility regime",
  "scanHealthSummary": "1-2 sentences on scanner performance across presets",
  "reasoningSummary": "2-4 sentences explaining the top recommendation",
  "confidence": 0.0,
  "urgency": "low",
  "rankings": [
    {
      "presetKey": "string (exact match from candidates)",
      "presetBehaviorVersion": "string (exact match from candidates)",
      "rank": 1,
      "score": 85,
      "pros": ["pro 1", "pro 2"],
      "cons": ["con 1", "con 2"],
      "fitNotes": "1-3 sentence fit explanation"
    }
  ]
}`);

  return lines.join('\n');
}

// ── Response Parsing ────────────────────────────────────────────────────────

/**
 * Parse raw LLM text into a structured response.
 * Strips markdown code fences and attempts JSON parse.
 */
function parseLlmResponse(raw: string): Result<PlatformAssessmentLlmResponse> {
  // Strip markdown code fences if present
  let cleaned = raw.trim();

  // Remove leading ```json or ``` fences
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1]!.trim();
  }

  // Also handle leading ``` without trailing ```
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').trim();
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return err({
      code: 'assessment.llm_response_invalid',
      message: 'Failed to parse LLM response as JSON',
    });
  }

  const result = PlatformAssessmentLlmResponseSchema.safeParse(parsed);
  if (!result.success) {
    return err({
      code: 'assessment.llm_response_invalid',
      message: `LLM response validation failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
    });
  }

  return ok(result.data);
}

// ── Deterministic Artifact Assembly ─────────────────────────────────────────

function resolveScoreBand(score: number, bands: LlmRankerConfig['scoreBands']): string {
  if (score >= bands.aMin) return 'A';
  if (score >= bands.bMin) return 'B';
  if (score >= bands.cMin) return 'C';
  if (score >= bands.dMin) return 'D';
  return 'F';
}

function assembleArtifact(
  identity: MarketAssessmentIdentity,
  llmResponse: PlatformAssessmentLlmResponse,
  scorecards: PresetScorecardEntry[],
  config: LlmRankerConfig,
  cacheFreshnessMs: number,
  evidenceRefs: string[],
): MarketAssessmentArtifact {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cacheFreshnessMs);

  // Deterministic score bands (overwrite LLM-provided bands)
  const rankings: MarketAssessmentPresetRanking[] = llmResponse.rankings.map((r) => ({
    presetKey: r.presetKey,
    presetBehaviorVersion: r.presetBehaviorVersion,
    rank: r.rank,
    score: r.score,
    scoreBand: resolveScoreBand(r.score, config.scoreBands),
    pros: r.pros,
    cons: r.cons,
    fitNotes: r.fitNotes,
  }));

  // Deterministic relativeUplift: rank1.score − rank2.score
  const sorted = [...rankings].sort((a, b) => a.rank - b.rank);
  let relativeUplift: number | null = null;
  if (sorted.length >= 2) {
    const rank1 = sorted[0]!;
    const rank2 = sorted[1]!;
    relativeUplift = rank1.score - rank2.score;
  }

  // Deterministic recommendedPreset
  const rank1 = sorted[0];
  let recommendedPreset: string | null = null;
  if (rank1) {
    const { minConfidence, minScoreForRecommendation } = config.recommendationPolicy;
    if (llmResponse.confidence >= minConfidence && rank1.score >= minScoreForRecommendation) {
      recommendedPreset = rank1.presetKey;
    }
  }

  // Deterministic allowedPresets (score > minAllowedScore)
  const allowedPresets = rankings
    .filter((r) => r.score > config.recommendationPolicy.minAllowedScore)
    .map((r) => r.presetKey);

  return {
    id: crypto.randomUUID(),
    venueFamily: identity.venueFamily,
    styleTier: identity.styleTier,
    assessmentRunId: '',
    assessedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxActorUseAge: new Date(now.getTime() + cacheFreshnessMs).toISOString(),
    maxWakeAge: new Date(now.getTime() + cacheFreshnessMs / 2).toISOString(),
    assessmentVersion: 1,
    artifactVersion: 1,
    rankingPolicyVersion: 1,
    status: 'active',
    allowedPresets,
    currentMarketSummary: llmResponse.currentMarketSummary,
    regimeSummary: llmResponse.regimeSummary,
    scanHealthSummary: llmResponse.scanHealthSummary,
    presetRankings: rankings,
    recommendedPreset,
    relativeUplift,
    confidence: llmResponse.confidence,
    urgency: llmResponse.urgency,
    reasoningSummary: llmResponse.reasoningSummary,
    evidenceRefs,
  };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Rank presets via the platform LLM.
 *
 * 1. Build bounded evidence projection (no agent/account data).
 * 2. Construct system + user prompts.
 * 3. Call the platform LLM.
 * 4. Parse and syntactically validate the response.
 * 5. Semantically validate against the candidate set.
 * 6. Deterministically assemble the artifact.
 */
export async function rankPresetsViaLlm(
  config: LlmRankerConfig,
  deps: LlmRankerDeps,
  identity: MarketAssessmentIdentity,
  evidence: AssessmentEvidenceSnapshot,
  scorecards: PresetScorecardEntry[],
  presets: Array<{ key: string; entry: { name: string; description: string; strategy: { type: string; decisionMode: string } } }>,
  cacheFreshnessMs: number,
): Promise<Result<LlmRankerResult>> {
  // 1. Build projection
  const projection = buildProjection(identity, evidence, scorecards, presets);

  // 2. Construct prompts
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(projection);

  // Basic size check (character count as rough token proxy)
  const totalChars = systemPrompt.length + userPrompt.length;
  const estimatedTokens = Math.ceil(totalChars / 3); // rough estimate: ~3 chars per token
  if (estimatedTokens > config.maxInputTokens) {
    return err({
      code: 'assessment.llm_input_too_large',
      message: `Estimated input tokens (${estimatedTokens}) exceeds max (${config.maxInputTokens})`,
    });
  }

  // 3. Call LLM
  let llmResult: { text: string; usage: LlmCallUsage };
  try {
    llmResult = await deps.callLlm(userPrompt);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err({
      code: 'assessment.llm_provider_error',
      message: `LLM provider call failed: ${message}`,
    });
  }

  // 4. Parse response
  const parsed = parseLlmResponse(llmResult.text);
  if (!parsed.ok) {
    return parsed;
  }
  const llmResponse = parsed.data;

  // 5. Semantic validation
  const candidates: AssessmentCandidateDescriptor[] = scorecards.map((sc) => ({
    presetKey: sc.presetKey,
    presetBehaviorVersion: sc.presetBehaviorVersion,
  }));
  const semanticResult = validateLlmResponseSemantics(llmResponse, candidates);
  if (!semanticResult.ok) {
    return semanticResult;
  }

  // 6. Assemble artifact
  const evidenceRefs: string[] = [
    `evidence:v1:${identity.venueFamily}:${identity.styleTier}:${evidence.collectedAt}`,
    `scorecards:v1:${scorecards.length}:${evidence.collectedAt}`,
  ];

  const artifact = assembleArtifact(
    identity,
    llmResponse,
    scorecards,
    config,
    cacheFreshnessMs,
    evidenceRefs,
  );

  return ok({
    artifact,
    usage: llmResult.usage,
    rawResponse: llmResult.text,
  });
}
