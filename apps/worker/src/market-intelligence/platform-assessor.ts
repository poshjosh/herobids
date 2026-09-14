import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import { marketAssessmentRuns } from '@herobids/db';
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
import { createPresetScorecardRunner, type ScoreCandidateBoundary } from './preset-scorecard-runner.js';
import { rankPresetsViaLlm, type LlmRankerConfig } from './llm-ranker.js';
import { eq } from 'drizzle-orm';

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

/**
 * Runtime operational config for the PlatformAssessor class.
 *
 * Derived from the domain {@link import('@herobids/domain').PlatformAssessorConfig}
 * at construction time by the assessor factory. This is a focused subset — the
 * domain schema is the single source of truth for defaults and validation.
 */
export interface PlatformAssessorRuntimeConfig {
  /** Enable/disable platform assessor. Derived from operator config. */
  enabled: boolean;
  /** Maximum concurrent assessments. Derived from operator config. */
  maxConcurrentAssessments: number;
  /** How long an artifact is considered fresh (ms). Derived from operator config. */
  cacheFreshnessMs: number;
  /** Platform LLM ranking configuration. Required for 009 LLM ranking. */
  llm?: LlmRankerConfig;
}

/** @deprecated Use {@link PlatformAssessorRuntimeConfig} instead. */
export type PlatformAssessorConfig = PlatformAssessorRuntimeConfig;

export interface PlatformAssessorDeps {
  db: Database;
  redis: Redis;
  /** Evidence collection ports for market data. */
  evidencePorts: AssessmentEvidencePorts;
  /** Get all presets for a style tier (full PresetEntry objects). */
  getPresets(styleTier: string): Array<{ key: string; entry: PresetEntry }>;
  /** LLM provider for assessment ranking (used in 009). */
  callLlm(prompt: string): Promise<{ text: string; usage: LlmCallUsage }>;
  /**
   * The `score_candidate` read boundary for orderbook/perp preset scoring (L3
   * Q2 re-point). Bound to a SYSTEM subject by the worker composition root.
   * Optional — when absent, orderbook scoring returns a propagated error rather
   * than scoring in-process (the boundary owns candle fetching + scoring).
   */
  scoreCandidateBoundary?: ScoreCandidateBoundary;
  /** Logger instance */
  logger?: Logger;
}

// ── Implementation ─────────────────────────────────────────────────────────

const ASSESSOR_LOGGER_NAME = 'platform-assessor';

export class PlatformAssessor {
  private readonly config: Required<PlatformAssessorRuntimeConfig>;
  private readonly deps: PlatformAssessorDeps;
  private readonly log: Logger;

  // TODO(002): Implement shadow-mode evidence tracking.
  // Shadow-mode metrics (assessment runs, scan health, preset rankings) should be
  // collected and validated for a full cycle before enabling live transitions.
  // This gives operators confidence that the platform assessor produces sensible
  // recommendations before any agent acts on them.

  constructor(config: PlatformAssessorRuntimeConfig, deps: PlatformAssessorDeps) {
    this.config = {
      enabled: config.enabled,
      maxConcurrentAssessments: config.maxConcurrentAssessments,
      cacheFreshnessMs: config.cacheFreshnessMs,
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
    runId?: string,
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
      const scorecardsResult = await this.generateScorecards(identity, candles, presets);
      if (!scorecardsResult.ok) {
        return scorecardsResult; // propagate the error
      }
      const scorecards = scorecardsResult.data;

      // Step 6: Persist immutable evidence before LLM work
      if (runId) {
        await this.persistEvidence(runId, evidence, scorecards);
      }

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

    // 2. Derived candle evidence (D1-b).
    //
    // The candle port now returns DERIVED scalars sourced over the Traderton
    // boundary (volatility + candle-window/count) — NEVER raw OHLCV. The raw
    // candle array that this path used to carry is dropped: it was stored on the
    // snapshot's `symbolCandles.value` and fed to `generateScorecards`, but
    // NEITHER consumer read the OHLCV bodies (the ranker reads only
    // `symbolCandles.state`, and the scorecard runner routes over `score_candidate`
    // ignoring the passed candles). Feeding the same derived scalars is therefore
    // behaviour-preserving for the ranker. Dropping the unconsumed raw array is an
    // accepted Intentional-divergence (004 "Q2").
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
    const derivedCandles = candlesResult.data.data;
    // `symbolCandles` is kept as an availability FLAG (human-approved sub-choice):
    // the field's shape is unchanged (`EvidenceValue<ReadonlyArray<PriceCandle>>`
    // per the domain snapshot type) but carries an EMPTY array — no OHLCV bodies.
    // `candlesEvaluated > 0` behind the boundary is the availability signal.
    const symbolCandles: EvidenceValue<ReadonlyArray<PriceCandle>> =
      derivedCandles.candlesEvaluated > 0
        ? makeAvailable<ReadonlyArray<PriceCandle>>([], candlesResult.data.source)
        : makeUnavailable(
            'assessment.candles_unavailable',
            'No candles were evaluated behind the boundary',
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

    // 5. Volatility — consumed from the boundary-derived read (D1-b rework). The
    // FULL derivation (absolute-units ATR + percentile-classified regime) happens
    // behind the boundary (get_volatility); the port passes the resulting
    // VolatilityEvidence through verbatim. A null reading means no usable
    // volatility. No local classification here.
    const volatility: EvidenceValue<VolatilityEvidence> =
      derivedCandles.volatility !== null
        ? makeAvailable<VolatilityEvidence>(derivedCandles.volatility, 'boundary-derived')
        : makeUnavailable(
            'assessment.volatility_insufficient_data',
            'No usable volatility reading from the boundary',
          );

    // 6. Build scorecard input from the boundary-derived candle-window + count.
    const scorecardInput: EvidenceValue<ScorecardInput> = makeAvailable<ScorecardInput>(
      buildScorecardInput(identity, derivedCandles.candleWindow, derivedCandles.candlesEvaluated),
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

  /**
   * Generate deterministic per-preset scorecards using PresetScorecardRunner.
   *
   * Async because orderbook/perp scoring now routes over the Traderton
   * `score_candidate` boundary (candles fetched behind the boundary). Swap/dex
   * scoring stays in-process from the pre-fetched `candles` (the swap re-point
   * is deferred; see the runner). Boundary infrastructure failures propagate as
   * an error Result rather than being reported as a scan-health outcome.
   */
  async generateScorecards(
    identity: MarketAssessmentIdentity,
    candles: PriceCandle[],
    presets: Array<{ key: string; entry: PresetEntry }>,
  ): Promise<Result<PresetScorecardEntry[]>> {
    try {
      const runner = createPresetScorecardRunner({
        scoreCandidateBoundary: this.deps.scoreCandidateBoundary,
      });
      return await runner.generateScorecards({ identity, presets, candles });
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

  /**
   * Persist evidence snapshot and scorecards into market_assessment_runs.
   * Best-effort: logs a warning on failure but does not throw.
   */
  private async persistEvidence(
    runId: string,
    evidence: AssessmentEvidenceSnapshot,
    scorecards: PresetScorecardEntry[],
  ): Promise<void> {
    try {
      const evidenceRefs = buildEvidenceRefs(evidence);
      const calculationVersions: Record<string, unknown> = {
        assessmentVersion: 1,
        scorecardVersion: '1.0',
        evidenceSchemaVersion: evidence.schemaVersion,
      };

      await this.deps.db
        .update(marketAssessmentRuns)
        .set({
          evidenceSnapshot: evidence as unknown as Record<string, unknown>,
          scorecardSnapshots: scorecards as unknown as Record<string, unknown>[],
          calculationVersions,
          evidenceRefs,
        })
        .where(eq(marketAssessmentRuns.id, runId));
    } catch (caught) {
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      this.log.warn({ err: caught, runId }, `Failed to persist evidence: ${errorMessage}`);
    }
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
  candleWindow: { start: string; end: string } | null,
  candlesEvaluated: number,
): ScorecardInput {
  const symbol = resolveSymbolForScorecard(identity);

  const window = candleWindow ?? {
    start: new Date(0).toISOString(),
    end: new Date(0).toISOString(),
  };

  return {
    symbol,
    candleWindow: window,
    candlesAvailable: candlesEvaluated,
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

/** Build an array of source references from the evidence snapshot for audit tracing. */
function buildEvidenceRefs(evidence: AssessmentEvidenceSnapshot): string[] {
  const refs: string[] = [];

  if (evidence.regime.state === 'available') {
    refs.push(`regime:${evidence.regime.source}`);
  } else {
    refs.push(`regime:unavailable:${evidence.regime.reasonCode}`);
  }

  if (evidence.symbolCandles.state === 'available') {
    refs.push(`candles:${evidence.symbolCandles.source}`);
  } else {
    refs.push(`candles:unavailable:${evidence.symbolCandles.reasonCode}`);
  }

  refs.push(`volatility:${evidence.volatility.state}`);

  if (evidence.liquidity.state === 'available') {
    refs.push(`liquidity:${evidence.liquidity.source}`);
  } else {
    refs.push(`liquidity:unavailable:${evidence.liquidity.reasonCode}`);
  }

  if (evidence.breadth.state === 'available') {
    refs.push(`breadth:${evidence.breadth.source}`);
  } else {
    refs.push(`breadth:unavailable:${evidence.breadth.reasonCode}`);
  }

  refs.push(`scorecardInput:${evidence.scorecardInput.state}`);

  return refs;
}
