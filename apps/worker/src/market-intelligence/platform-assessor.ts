import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type { PriceCandle, RegimeResult } from '@herobids/market-data';
import type {
  MarketAssessmentIdentity,
  MarketAssessmentArtifact,
  PresetScorecardEntry,
  MarketAssessmentPresetRanking,
  AssessmentEvidenceSnapshot,
  EvidenceValue,
  VolatilityEvidence,
  LiquidityEvidence,
  BreadthEvidence,
  ScorecardInput,
  AssessmentData,
  AssessmentUnavailable,
  AssessmentMarketCohort,
  PresetEntry,
} from '@herobids/domain';
import { err, ok, type Result } from '@herobids/domain';
import type { AssessmentEvidencePorts } from './assessment-ports.js';
import { createPresetScorecardRunner } from './preset-scorecard-runner.js';
import { rankPresetsViaLlm, type LlmRankerConfig } from './llm-ranker.js';

// ── LLM Usage Types ────────────────────────────────────────────────────────

/** Per-call LLM usage from a single callLlm invocation. */
export interface LlmCallUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Aggregated LLM usage across all calls in a single assessment run. */
export interface AggregatedLlmUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  callCount: number;
  /** Estimated cost in microusd — never used for user billing (R12). */
  estimatedCostMicrousd: number;
}

// ── Config & Deps ───────────────────────────────────────────────────────────

export interface PlatformAssessorConfig {
  /** Enable/disable platform assessor. Default: true */
  enabled?: boolean;
  /** Maximum concurrent assessments. Default: 1 */
  maxConcurrentAssessments?: number;
  /** How long an artifact is considered fresh (ms). Default: 6 hours */
  cacheFreshnessMs?: number;
  /** Platform LLM ranking configuration. Required for 009 LLM ranking. */
  llm?: LlmRankerConfig;
}

export interface PlatformAssessorDeps {
  db: Database;
  redis: Redis;
  /** Evidence collection ports for market data. */
  evidencePorts: AssessmentEvidencePorts;
  /** Get all presets for a style tier (full PresetEntry objects). */
  getPresets(styleTier: string): Array<{ key: string; entry: PresetEntry }>;
  /** LLM provider for assessment ranking (used in 009). */
  callLlm(prompt: string): Promise<{ text: string; usage: LlmCallUsage }>;
  /** Logger instance */
  logger?: Logger;
}

// ── Implementation ─────────────────────────────────────────────────────────

const ASSESSOR_LOGGER_NAME = 'platform-assessor';

export class PlatformAssessor {
  private readonly config: Required<PlatformAssessorConfig>;
  private readonly deps: PlatformAssessorDeps;
  private readonly log: Logger;

  // TODO(002): Implement shadow-mode evidence tracking.
  // Shadow-mode metrics (assessment runs, scan health, preset rankings) should be
  // collected and validated for a full cycle before enabling live transitions.
  // This gives operators confidence that the platform assessor produces sensible
  // recommendations before any agent acts on them.

  constructor(config: PlatformAssessorConfig, deps: PlatformAssessorDeps) {
    this.config = {
      enabled: config.enabled ?? true,
      maxConcurrentAssessments: config.maxConcurrentAssessments ?? 1,
      cacheFreshnessMs: config.cacheFreshnessMs ?? 21_600_000, // 6 hours
      llm: config.llm as LlmRankerConfig,
    };
    this.deps = deps;
    this.log = deps.logger ?? createLogger(ASSESSOR_LOGGER_NAME);
  }

  // ── On-Demand Assessment ───────────────────────────────────────────────

  /**
   * Assess a single canonical identity on demand.
   *
   * Collects evidence, generates per-preset scorecards, ranks presets,
   * and returns the resulting artifact (or an error).
   */
  async assessIdentity(
    identity: MarketAssessmentIdentity,
  ): Promise<Result<{ artifact: MarketAssessmentArtifact; llmUsage: AggregatedLlmUsage }>> {
    if (!this.config.enabled) {
      return err({
        code: 'assessment.disabled',
        message: 'Platform assessor is disabled',
      });
    }

    this.log.info({ identity }, 'On-demand assessment started');

    try {
      // Step 1: Resolve supported provider policy (simple: always true for now)
      // TODO(009): implement venue-based provider policy resolution
      // const supported = this.resolveProviderPolicy(identity);

      // Step 2: Collect evidence
      const evidenceResult = await this.collectEvidence(identity);
      if (!evidenceResult.ok) {
        return evidenceResult;
      }
      const evidence = evidenceResult.data;

      // Step 3: Load presets for the style tier
      const presets = this.deps.getPresets(identity.styleTier);

      // Step 4: Extract candles from evidence snapshot for scorecard generation
      const candles = extractCandlesFromSnapshot(evidence);

      // Step 5: Generate scorecards using the deterministic runner
      const scorecardsResult = this.generateScorecards(identity, candles, presets);
      if (!scorecardsResult.ok) {
        return scorecardsResult; // propagate the error
      }
      const scorecards = scorecardsResult.data;

      // Step 6: Persist immutable evidence before LLM work
      // TODO(008): persist evidence snapshot and scorecards to DB
      // await this.persistEvidence(evidence, scorecards);

      // Step 7: Rank presets via LLM
      const rankingResult = await this.rankPresets(identity, evidence, scorecards, presets);
      if (!rankingResult.ok) {
        return rankingResult;
      }
      const { artifact, usage } = rankingResult.data;

      const aggregatedUsage = this.aggregateUsage(usage);

      this.log.info({ identity, artifactId: artifact.id }, 'On-demand assessment completed');

      return ok({ artifact, llmUsage: aggregatedUsage });
    } catch (caught) {
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      this.log.error({ err: caught, identity }, 'On-demand assessment failed');
      return err({
        code: 'assessment.failed',
        message: errorMessage,
      });
    }
  }

  // ── Evidence Collection ────────────────────────────────────────────────

  /** Collect deterministic evidence for a canonical identity via ports. */
  async collectEvidence(
    identity: MarketAssessmentIdentity,
  ): Promise<Result<AssessmentEvidenceSnapshot>> {
    const ports = this.deps.evidencePorts;
    const collectedAt = new Date().toISOString();

    // 1. Regime snapshot
    const regimeResult = await ports.regime.getRegime(identity);
    if (!regimeResult.ok) {
      this.log.warn({ err: regimeResult.error, identity }, 'Regime evidence unavailable');
      return err({
        code: 'assessment.evidence_unavailable',
        message: `Regime evidence unavailable: ${regimeResult.error.message}`,
      });
    }
    // NOTE: AssessmentData<T> uses `.data` (not `.value`) for the payload field.
    // See packages/domain/src/market-assessment.ts → AssessmentData<T>.
    if (isStale(regimeResult.data.expiresAt)) {
      return err({
        code: 'assessment.evidence_stale',
        message: 'Regime evidence is stale',
      });
    }
    const regime: EvidenceValue<RegimeResult> = makeAvailable(
      regimeResult.data.data,
      regimeResult.data.source,
    );

    // 2. Symbol candles
    const candlesResult = await ports.candles.getCandles({
      identity,
      interval: '15m',
      minimumCandles: 48,
    });
    if (!candlesResult.ok) {
      this.log.warn({ err: candlesResult.error, identity }, 'Candle evidence unavailable');
      return err({
        code: 'assessment.evidence_unavailable',
        message: `Candle evidence unavailable: ${candlesResult.error.message}`,
      });
    }
    if (isStale(candlesResult.data.expiresAt)) {
      return err({
        code: 'assessment.evidence_stale',
        message: 'Candle evidence is stale',
      });
    }
    const rawCandles = candlesResult.data.data;
    const symbolCandles: EvidenceValue<ReadonlyArray<PriceCandle>> = makeAvailable(
      rawCandles,
      candlesResult.data.source,
    );

    // 3. Liquidity
    const liquidityResult = await ports.liquidity.getLiquidity(identity);
    let liquidity: EvidenceValue<LiquidityEvidence>;
    if (liquidityResult.ok) {
      if (isStale(liquidityResult.data.expiresAt)) {
        this.log.warn({ identity }, 'Liquidity evidence is stale — treating as unavailable');
        liquidity = makeUnavailable(
          'assessment.evidence_stale',
          'Liquidity evidence is stale',
        );
      } else {
        liquidity = makeAvailable(liquidityResult.data.data, liquidityResult.data.source);
      }
    } else {
      // Liquidity is not mandatory for any venue in the current config;
      // construct an unavailable EvidenceValue.
      this.log.warn({ err: liquidityResult.error, identity }, 'Liquidity evidence unavailable');
      liquidity = makeUnavailable(
        'assessment.liquidity_unavailable',
        liquidityResult.error.message,
      );
    }

    // 4. Breadth
    const defaultCohort: AssessmentMarketCohort = {
      venueFamily: identity.venueFamily,
      instrumentKind: identity.instrumentKind,
      symbols: [],
      lookback: 30,
      membershipTimestamp: collectedAt,
      movingAveragePolicy: '200',
    };
    const breadthResult = await ports.breadth.getBreadth({
      identity,
      cohort: defaultCohort,
    });
    let breadth: EvidenceValue<BreadthEvidence>;
    if (breadthResult.ok) {
      const breadthData = breadthResult.data;
      if ('data' in breadthData) {
        const ad = breadthData as AssessmentData<BreadthEvidence>;
        if (isStale(ad.expiresAt)) {
          this.log.warn({ identity }, 'Breadth evidence is stale — treating as unavailable');
          breadth = makeUnavailable('assessment.evidence_stale', 'Breadth evidence is stale');
        } else {
          breadth = makeAvailable(ad.data, ad.source);
        }
      } else {
        // AssessmentUnavailable
        const unavailable = breadthData as AssessmentUnavailable;
        this.log.warn({ reason: unavailable.reasonCode, identity }, 'Breadth evidence unavailable');
        breadth = makeUnavailable(unavailable.reasonCode, unavailable.message);
      }
    } else {
      this.log.warn({ err: breadthResult.error, identity }, 'Breadth evidence unavailable');
      breadth = makeUnavailable(
        'assessment.breadth_unavailable',
        breadthResult.error.message,
      );
    }

    // 5. Compute volatility from candle data
    const volatility = computeVolatilityEvidence(rawCandles);

    // 6. Build scorecard input
    const candleArr = rawCandles as readonly PriceCandle[];
    const scorecardInput: EvidenceValue<ScorecardInput> = makeAvailable<ScorecardInput>(
      buildScorecardInput(identity, candleArr),
      'computed',
    );

    return ok({
      schemaVersion: 1,
      identity,
      collectedAt,
      regime,
      symbolCandles,
      volatility,
      liquidity,
      breadth,
      scorecardInput,
    });
  }

  // ── Scorecard Generation ───────────────────────────────────────────────

  /** Generate deterministic per-preset scorecards using PresetScorecardRunner. */
  generateScorecards(
    identity: MarketAssessmentIdentity,
    candles: PriceCandle[],
    presets: Array<{ key: string; entry: PresetEntry }>,
  ): Result<PresetScorecardEntry[]> {
    try {
      const runner = createPresetScorecardRunner({});
      const result = runner.generateScorecards({ identity, presets, candles });
      return ok(result);
    } catch (caught) {
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      return err({
        code: 'assessment.scorecard_failed',
        message: errorMessage,
      });
    }
  }

  // ── LLM Ranking ────────────────────────────────────────────────────────

  /**
   * Invoke the platform LLM to rank presets using the bounded projection
   * and deterministic artifact assembly from the llm-ranker module.
   *
   * Falls back to the Phase 1 placeholder when no LLM config is provided.
   */
  async rankPresets(
    identity: MarketAssessmentIdentity,
    evidence: AssessmentEvidenceSnapshot,
    scorecards: PresetScorecardEntry[],
    presets: Array<{ key: string; entry: PresetEntry }>,
  ): Promise<Result<{ artifact: MarketAssessmentArtifact; usage: LlmCallUsage }>> {
    // If no LLM config, return the Phase 1 placeholder artifact
    if (!this.config.llm) {
      this.log.warn({ identity }, 'No LLM config provided — returning placeholder artifact');
      return ok({
        artifact: this.buildPlaceholderArtifact(identity, scorecards),
        usage: {
          provider: 'none',
          model: 'none',
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      });
    }

    const result = await rankPresetsViaLlm(
      this.config.llm,
      { callLlm: this.deps.callLlm },
      identity,
      evidence,
      scorecards,
      presets.map((p) => ({
        key: p.key,
        entry: {
          name: p.entry.name,
          description: p.entry.description,
          strategy: {
            type: p.entry.strategy.type,
            decisionMode: p.entry.strategy.decisionMode,
          },
        },
      })),
      this.config.cacheFreshnessMs,
    );

    if (!result.ok) {
      this.log.error({ err: result.error, identity }, 'LLM ranking failed');
      return result;
    }

    this.log.info(
      {
        identity,
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        inputTokens: result.data.usage.inputTokens,
        outputTokens: result.data.usage.outputTokens,
        confidence: result.data.artifact.confidence,
        recommendedPreset: result.data.artifact.recommendedPreset,
      },
      'LLM ranking completed',
    );

    return ok({ artifact: result.data.artifact, usage: result.data.usage });
  }

  /** Build a Phase 1 placeholder artifact when no LLM config is available. */
  private buildPlaceholderArtifact(
    identity: MarketAssessmentIdentity,
    scorecards: PresetScorecardEntry[],
  ): MarketAssessmentArtifact {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.cacheFreshnessMs);

    const rankings: MarketAssessmentPresetRanking[] = scorecards.map((sc, idx) => ({
      presetKey: sc.presetKey,
      presetBehaviorVersion: sc.presetBehaviorVersion,
      rank: idx + 1,
      score: 0,
      scoreBand: 'N/A',
      pros: [],
      cons: [],
      fitNotes: null,
    }));

    return {
      id: crypto.randomUUID(),
      venueFamily: identity.venueFamily,
      styleTier: identity.styleTier,
      assessmentRunId: '',
      assessedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      maxActorUseAge: new Date(now.getTime() + this.config.cacheFreshnessMs).toISOString(),
      maxWakeAge: new Date(now.getTime() + this.config.cacheFreshnessMs / 2).toISOString(),
      assessmentVersion: 1,
      artifactVersion: 1,
      rankingPolicyVersion: 1,
      status: 'active',
      allowedPresets: scorecards.map((s) => s.presetKey),
      currentMarketSummary: 'Phase 1 scaffolding — market summary not yet implemented.',
      regimeSummary: 'Phase 1 scaffolding — regime summary not yet implemented.',
      scanHealthSummary: 'Phase 1 scaffolding — scan health not yet computed.',
      presetRankings: rankings,
      recommendedPreset: scorecards.length > 0 ? scorecards[0]!.presetKey : null,
      relativeUplift: null,
      confidence: 0,
      urgency: 'low',
      reasoningSummary: 'Phase 1 scaffolding — reasoning not yet implemented.',
      evidenceRefs: [],
    };
  }

  /** Aggregate a single LLM call usage into the AggregatedLlmUsage format. */
  private aggregateUsage(usage: LlmCallUsage): AggregatedLlmUsage {
    return {
      totalInputTokens: usage.inputTokens,
      totalOutputTokens: usage.outputTokens,
      totalReasoningTokens: usage.reasoningTokens,
      callCount: 1,
      estimatedCostMicrousd: 0,
    };
  }
}

// ── Evidence Value Helpers ──────────────────────────────────────────────────

/** Returns true when the evidence expiry has already passed. */
function isStale(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

function makeAvailable<T>(value: T, source: string): EvidenceValue<T> {
  return {
    state: 'available',
    value,
    source,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(), // 5 min
  };
}

function makeUnavailable(reasonCode: string, message: string): EvidenceValue<never> {
  return {
    state: 'unavailable',
    reasonCode,
    message,
    observedAt: new Date().toISOString(),
  };
}

// ── Volatility Computation ──────────────────────────────────────────────────

const ATR_LOOKBACK_PERIODS = 14;
const VOLATILITY_LOW_PERCENTILE = 25;
const VOLATILITY_HIGH_PERCENTILE = 75;
const VOLATILITY_EXTREME_PERCENTILE = 95;
const VOLATILITY_CALCULATION_VERSION = '1.0.0';

/** Compute ATR and classify volatility regime from candle data. */
function computeVolatilityEvidence(
  candles: readonly PriceCandle[],
): EvidenceValue<VolatilityEvidence> {
  if (candles.length < 2) {
    return makeUnavailable(
      'assessment.volatility_insufficient_data',
      `Need at least 2 candles for ATR, got ${candles.length}`,
    );
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    );
    trueRanges.push(tr);
  }

  const lookback = Math.min(ATR_LOOKBACK_PERIODS, trueRanges.length);
  const recentTRs = trueRanges.slice(-lookback);
  const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / recentTRs.length;

  // Classify regime by comparing current ATR against the candle distribution.
  // Use the most recent trueRange as the "current" ATR for classification.
  const currentATR = recentTRs[recentTRs.length - 1] ?? atr;

  // Build a sorted copy of true ranges for percentile computation
  const sortedTRs = [...trueRanges].sort((a, b) => a - b);

  let volatilityRegime: VolatilityEvidence['volatilityRegime'];
  if (currentATR >= percentileValue(sortedTRs, VOLATILITY_EXTREME_PERCENTILE)) {
    volatilityRegime = 'extreme';
  } else if (currentATR >= percentileValue(sortedTRs, VOLATILITY_HIGH_PERCENTILE)) {
    volatilityRegime = 'high';
  } else if (currentATR <= percentileValue(sortedTRs, VOLATILITY_LOW_PERCENTILE)) {
    volatilityRegime = 'low';
  } else {
    volatilityRegime = 'normal';
  }

  return makeAvailable<VolatilityEvidence>(
    {
      averageTrueRange: Math.round(atr * 1e8) / 1e8,
      volatilityRegime,
      calculationVersion: VOLATILITY_CALCULATION_VERSION,
    },
    'computed',
  );
}

/** Compute the value at a given percentile from a sorted array. */
function percentileValue(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = ((pct / 100) * (sorted.length - 1));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return (sorted[lo]! * (1 - frac)) + (sorted[hi]! * frac);
}

// ── Scorecard Input Builder ─────────────────────────────────────────────────

/** Resolve a canonical symbol string from a MarketAssessmentIdentity for scorecard input. */
function resolveSymbolForScorecard(identity: MarketAssessmentIdentity): string {
  switch (identity.instrumentKind) {
    case 'orderbook':
    case 'perp':
      return identity.symbol;
    case 'swap':
    case 'dex':
      return `${identity.network}:${identity.address}`;
    default:
      throw new Error(`Unknown instrumentKind: ${(identity as { instrumentKind: string }).instrumentKind}`);
  }
}

function buildScorecardInput(
  identity: MarketAssessmentIdentity,
  candles: readonly PriceCandle[],
): ScorecardInput {
  const symbol = resolveSymbolForScorecard(identity);

  const start = candles.length > 0 ? candles[0]!.timestamp : new Date(0).toISOString();
  const end =
    candles.length > 0
      ? candles[candles.length - 1]!.timestamp
      : new Date(0).toISOString();

  return {
    symbol,
    candleWindow: { start, end },
    candlesAvailable: candles.length,
  };
}

// ── Snapshot Helpers ────────────────────────────────────────────────────────

/** Extract candles array from an evidence snapshot for scorecard generation. */
function extractCandlesFromSnapshot(
  snapshot: AssessmentEvidenceSnapshot,
): PriceCandle[] {
  if (snapshot.symbolCandles.state === 'available') {
    return [...snapshot.symbolCandles.value];
  }
  return [];
}
