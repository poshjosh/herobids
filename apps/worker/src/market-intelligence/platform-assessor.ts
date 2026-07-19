import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type { RegimeResult } from '@herobids/market-data';
import type {
  MarketAssessmentIdentity,
  MarketAssessmentArtifact,
  PresetScorecardEntry,
  MarketAssessmentPresetRanking,
} from '@herobids/domain';
import { err, ok, type Result } from '@herobids/domain';

// ── Evidence Package Types ──────────────────────────────────────────────────

export interface EvidencePackage {
  identity: MarketAssessmentIdentity;
  collectedAt: string;
  regime: RegimeResult;
  breadth: BreadthEvidence;
  volatility: VolatilityEvidence;
  liquidityQuality: LiquidityQualityEvidence;
  scanHealth: ScanHealthEvidence;
}

export interface BreadthEvidence {
  symbolsAboveMA: number;
  totalSymbols: number;
  breadthRatio: number;
}

export interface VolatilityEvidence {
  averageTrueRange: number;
  volatilityRegime: 'low' | 'normal' | 'high' | 'extreme';
}

export interface LiquidityQualityEvidence {
  averageSpreadBps: number;
  averageDepthUsd: number;
  quality: 'good' | 'adequate' | 'poor';
}

export interface ScanHealthEvidence {
  candidatesDiscovered: number;
  candidatesScored: number;
  signalsGenerated: number;
  health: 'healthy' | 'degraded' | 'no_signal' | 'stale';
}

// ── Config & Deps ───────────────────────────────────────────────────────────

export interface PlatformAssessorConfig {
  /** Enable/disable platform assessor. Default: true */
  enabled?: boolean;
  /** Maximum concurrent assessments. Default: 1 */
  maxConcurrentAssessments?: number;
  /** Budget caps: max LLM calls per assessment cycle */
  maxLlmCallsPerCycle?: number;
  /** How long an artifact is considered fresh (ms). Default: 6 hours */
  cacheFreshnessMs?: number;
}

export interface PlatformAssessorDeps {
  db: Database;
  redis: Redis;
  /** Access to shared market data / regime computation */
  getRegimeSnapshot(identity: MarketAssessmentIdentity): Promise<RegimeResult>;
  /** Access to preset catalog */
  getPresetKeys(styleTier: string): Promise<string[]>;
  /** LLM provider for assessment */
  callLlm(prompt: string): Promise<string>;
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
      maxLlmCallsPerCycle: config.maxLlmCallsPerCycle ?? 20,
      cacheFreshnessMs: config.cacheFreshnessMs ?? 21_600_000, // 6 hours
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
  ): Promise<Result<MarketAssessmentArtifact>> {
    if (!this.config.enabled) {
      return err({
        code: 'assessment.disabled',
        message: 'Platform assessor is disabled',
      });
    }

    this.log.info({ identity }, 'On-demand assessment started');

    try {
      // Step 1: Collect evidence
      const evidence = await this.collectEvidence(identity);

      // Step 2: Generate per-preset scorecards
      const presetKeys = await this.deps.getPresetKeys(identity.styleTier);
      const scorecards = await this.generateScorecards(identity, evidence, presetKeys);

      // Step 3: Rank presets via LLM
      const artifact = await this.rankPresets(identity, evidence, scorecards);

      this.log.info({ identity, artifactId: artifact.id }, 'On-demand assessment completed');

      return ok(artifact);
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

  /** Collect deterministic evidence for a canonical identity */
  async collectEvidence(identity: MarketAssessmentIdentity): Promise<EvidencePackage> {
    // Phase 1 skeleton — returns placeholder data.
    // Full implementation will integrate with shared market data infrastructure.
    const regime = await this.deps.getRegimeSnapshot(identity).catch((err) => {
      this.log.warn({ err, identity }, 'Regime snapshot failed — using placeholder');
      return PLACEHOLDER_REGIME;
    });

    return {
      identity,
      collectedAt: new Date().toISOString(),
      regime,
      breadth: {
        symbolsAboveMA: 0,
        totalSymbols: 0,
        breadthRatio: 0,
      },
      volatility: {
        averageTrueRange: 0,
        volatilityRegime: 'normal',
      },
      liquidityQuality: {
        averageSpreadBps: 0,
        averageDepthUsd: 0,
        quality: 'adequate',
      },
      scanHealth: {
        candidatesDiscovered: 0,
        candidatesScored: 0,
        signalsGenerated: 0,
        health: 'stale',
      },
    };
  }

  // ── Scorecard Generation ───────────────────────────────────────────────

  /** Generate deterministic per-preset scorecards */
  async generateScorecards(
    _identity: MarketAssessmentIdentity,
    _evidence: EvidencePackage,
    presetKeys: string[],
  ): Promise<PresetScorecardEntry[]> {
    // Phase 1 skeleton — returns placeholder scorecards.
    // Full implementation will run deterministic dry-run scans per preset.
    return presetKeys.map((presetKey) => ({
      presetKey,
      presetBehaviorVersion: '000000000000', // placeholder — real impl will fetch from preset catalog
      candidatesDiscovered: 0,
      candidatesScored: 0,
      signalsGenerated: 0,
      topConfidence: null,
      scanHealth: 'stale' as const,
    }));
  }

  // ── LLM Ranking ────────────────────────────────────────────────────────

  /** Invoke the platform LLM to rank presets */
  async rankPresets(
    identity: MarketAssessmentIdentity,
    _evidence: EvidencePackage,
    scorecards: PresetScorecardEntry[],
  ): Promise<MarketAssessmentArtifact> {
    // Phase 1 skeleton — returns a basic artifact without LLM call.
    // Full implementation will construct a prompt and call the platform LLM.
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
      assessmentRunId: '', // filled by caller
      assessedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      maxActorUseAge: 'PT12H',
      maxWakeAge: 'PT6H',
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
}

// ── Placeholder Constants ──────────────────────────────────────────────────

const PLACEHOLDER_REGIME: RegimeResult = {
  pass: true,
  reasons: ['placeholder — regime not yet integrated'],
  details: {
    benchmarkSymbol: 'BTC',
    currentPrice: 0,
    emaFast: 0,
    emaSlow: 0,
    emaTrend: 0,
    emaAlignment: 'bullish',
    adxValue: 0,
    choppy: false,
    vwap: 0,
    priceAboveVwap: true,
    marketStructure: 'higherHighs',
  },
};
