import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type { RegimeResult } from '@herobids/market-data';
import type {
  MarketAssessmentSegmentKey,
  MarketAssessmentRun,
  MarketAssessmentArtifact,
  PresetScorecardEntry,
  MarketAssessmentPresetRanking,
} from '@herobids/domain';
import { marketAssessmentRuns, marketAssessmentArtifacts } from '@herobids/db';
import { eq, and, sql } from 'drizzle-orm';
import { createLeaderElection, type LeaderElection } from './leader-election.js';

// ── Evidence Package Types ──────────────────────────────────────────────────

export interface EvidencePackage {
  segmentKey: MarketAssessmentSegmentKey;
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
  /** Assessment interval in ms. Default: 6 hours */
  assessmentIntervalMs?: number;
  /** Maximum concurrent assessments. Default: 1 */
  maxConcurrentAssessments?: number;
  /** Budget caps: max LLM calls per assessment cycle */
  maxLlmCallsPerCycle?: number;
  /** Staleness duration for artifacts. Default: 12 hours */
  artifactStalenessMs?: number;
  /** Configured segment families to assess. Empty = all. */
  segmentFamilies?: string[];
  /** Configured venue families to assess. Empty = all. */
  venueFamilies?: string[];
  /** Style tiers to run assessments for. Default: all three */
  styleTiers?: ('economy' | 'standard' | 'premium')[];
  /** Worker ID for leader election. Required for multi-worker deployments. */
  workerId?: string;
}

export interface PlatformAssessorDeps {
  db: Database;
  redis: Redis;
  /** Access to shared market data / regime computation */
  getRegimeSnapshot(segmentKey: MarketAssessmentSegmentKey): Promise<RegimeResult>;
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
  private readonly config: Required<Omit<PlatformAssessorConfig, 'segmentFamilies' | 'venueFamilies' | 'workerId'>> & {
    segmentFamilies: string[];
    venueFamilies: string[];
  };
  private readonly deps: PlatformAssessorDeps;
  private readonly log: Logger;
  private readonly workerId: string | undefined;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private runningCycle: Promise<void> | undefined;
  private leaderElection: LeaderElection | undefined;
  private isLeader = false;

  constructor(config: PlatformAssessorConfig, deps: PlatformAssessorDeps) {
    this.config = {
      enabled: config.enabled ?? true,
      assessmentIntervalMs: config.assessmentIntervalMs ?? 21_600_000, // 6 hours
      maxConcurrentAssessments: config.maxConcurrentAssessments ?? 1,
      maxLlmCallsPerCycle: config.maxLlmCallsPerCycle ?? 20,
      artifactStalenessMs: config.artifactStalenessMs ?? 43_200_000, // 12 hours
      segmentFamilies: config.segmentFamilies ?? [],
      venueFamilies: config.venueFamilies ?? [],
      styleTiers: config.styleTiers ?? ['economy', 'standard', 'premium'],
    };
    this.deps = deps;
    this.log = deps.logger ?? createLogger(ASSESSOR_LOGGER_NAME);
    this.workerId = config.workerId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the scheduler loop with leader election */
  start(): void {
    if (!this.config.enabled) {
      this.log.info('Platform assessor disabled');
      return;
    }
    if (!this.workerId) {
      this.log.warn('Platform assessor has no workerId — leader election disabled, running standalone');
      this.isLeader = true;
      this.scheduleNextCycle();
      this.intervalId = setInterval(() => {
        if (this.stopped) return;
        this.scheduleNextCycle();
      }, this.config.assessmentIntervalMs);
      return;
    }
    this.stopped = false;
    this.log.info({ intervalMs: this.config.assessmentIntervalMs }, 'Platform assessor starting with leader election');
    this.leaderElection = createLeaderElection(this.deps.redis, { workerId: this.workerId });
    this.leaderElection.start(
      this.onLeaderAcquired.bind(this),
      this.onLeaderLost.bind(this),
    );
  }

  /** Stop the scheduler loop and release leadership */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    await this.leaderElection?.stop();
    this.isLeader = false;
    // Wait for any in-flight cycle to complete
    if (this.runningCycle) {
      await this.runningCycle;
      this.runningCycle = undefined;
    }
    this.log.info('Platform assessor stopped');
  }

  // ── Leader Election Handlers ──────────────────────────────────────────

  private onLeaderAcquired(): void {
    this.log.info('Acquired platform assessor leadership');
    this.isLeader = true;
    this.scheduleNextCycle();
    this.intervalId = setInterval(() => {
      if (this.stopped) return;
      this.scheduleNextCycle();
    }, this.config.assessmentIntervalMs);
  }

  private onLeaderLost(): void {
    this.log.warn('Lost platform assessor leadership — stopping assessment cycle');
    this.isLeader = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    // Note: any in-flight cycle is allowed to complete; only the interval is cancelled.
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  private scheduleNextCycle(): void {
    if (this.runningCycle) {
      this.log.debug('Assessment cycle already running — skipping');
      return;
    }
    this.runningCycle = this.runAssessmentCycle().finally(() => {
      this.runningCycle = undefined;
    });
  }

  // ── Assessment Cycle ───────────────────────────────────────────────────

  /** Run a single assessment cycle (exposed for testing) */
  async runAssessmentCycle(): Promise<void> {
    if (!this.isLeader) {
      this.log.debug('Not leader — skipping assessment cycle');
      return;
    }

    const segments = await this.resolveSegments();
    if (segments.length === 0) {
      this.log.debug('No segments to assess');
      return;
    }

    this.log.info({ segmentCount: segments.length }, 'Starting assessment cycle');
    // Tracks number of segments processed in this cycle.
    // Actual LLM call counting will be wired when rankPresets calls callLlm.
    let segmentsProcessed = 0;

    for (const segmentKey of segments) {
      if (this.stopped) break;
      if (segmentsProcessed >= this.config.maxLlmCallsPerCycle) {
        this.log.warn(
          { maxLlmCallsPerCycle: this.config.maxLlmCallsPerCycle, remaining: segments.length - segments.indexOf(segmentKey) },
          'Budget exhausted — stopping assessment cycle',
        );
        break;
      }

      try {
        await this.assessSegment(segmentKey);
        segmentsProcessed++;
      } catch (err) {
        this.log.error({ err, segmentKey }, 'Failed to assess segment');
      }
    }

    this.log.info({ segmentsProcessed }, 'Assessment cycle complete');
  }

  // ── Segment Resolution ─────────────────────────────────────────────────

  /**
   * Resolve which segments need assessment.
   * In phase 1, returns all configured segment combinations.
   * Future: query DB for stale segments.
   */
  private async resolveSegments(): Promise<MarketAssessmentSegmentKey[]> {
    const segments: MarketAssessmentSegmentKey[] = [];

    for (const venueFamily of this.config.venueFamilies) {
      for (const styleTier of this.config.styleTiers) {
        segments.push({
          venueFamily,
          styleTier,
          // Placeholder universeScopeHash — real implementation will derive from config
          universeScopeHash: crypto.createHash('sha256').update(`${venueFamily}:${styleTier}`).digest('hex').slice(0, 16),
        });
      }
    }

    return segments;
  }

  // ── Single Segment Assessment ──────────────────────────────────────────

  /** Assess a single segment (exposed for testing) */
  async assessSegment(segmentKey: MarketAssessmentSegmentKey): Promise<MarketAssessmentRun> {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Create assessment run record
    await this.deps.db.insert(marketAssessmentRuns).values({
      id: runId,
      segmentKey: segmentKey,
      venueFamily: segmentKey.venueFamily,
      styleTier: segmentKey.styleTier,
      universeScopeHash: segmentKey.universeScopeHash,
      startedAt: new Date(startedAt),
      status: 'in_progress',
      evidenceRefs: [],
      errorMessage: null,
      assessmentVersion: 1,
    });

    this.log.info({ runId, segmentKey }, 'Assessment run started');

    try {
      // Step 1: Collect evidence
      const evidence = await this.collectEvidence(segmentKey);

      // Step 2: Generate per-preset scorecards
      const presetKeys = await this.deps.getPresetKeys(segmentKey.styleTier);
      const scorecards = await this.generateScorecards(segmentKey, evidence, presetKeys);

      // Step 3: Rank presets via LLM
      const artifact = await this.rankPresets(segmentKey, evidence, scorecards);

      // Step 4: Persist artifact
      await this.deps.db.insert(marketAssessmentArtifacts).values({
        id: artifact.id,
        segmentKey: artifact.segmentKey,
        venueFamily: artifact.venueFamily,
        styleTier: artifact.styleTier,
        universeScopeHash: artifact.universeScopeHash,
        assessmentRunId: runId,
        assessedAt: new Date(artifact.assessedAt),
        expiresAt: new Date(artifact.expiresAt),
        maxActorUseAge: artifact.maxActorUseAge,
        maxWakeAge: artifact.maxWakeAge,
        assessmentVersion: artifact.assessmentVersion,
        artifactVersion: artifact.artifactVersion,
        rankingPolicyVersion: artifact.rankingPolicyVersion,
        status: artifact.status,
        allowedPresets: artifact.allowedPresets,
        currentMarketSummary: artifact.currentMarketSummary,
        regimeSummary: artifact.regimeSummary,
        scanHealthSummary: artifact.scanHealthSummary,
        presetRankings: artifact.presetRankings,
        recommendedPreset: artifact.recommendedPreset,
        relativeUplift: artifact.relativeUplift?.toString() ?? null,
        confidence: artifact.confidence.toString(),
        urgency: artifact.urgency,
        reasoningSummary: artifact.reasoningSummary,
        evidenceRefs: artifact.evidenceRefs,
      });

      // Mark any previous active artifacts for this segment as superseded
      await this.deps.db
        .update(marketAssessmentArtifacts)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(marketAssessmentArtifacts.venueFamily, segmentKey.venueFamily),
            eq(marketAssessmentArtifacts.styleTier, segmentKey.styleTier),
            eq(marketAssessmentArtifacts.universeScopeHash, segmentKey.universeScopeHash),
            eq(marketAssessmentArtifacts.status, 'active'),
            sql`${marketAssessmentArtifacts.id} != ${artifact.id}`,
          ),
        );

      // Update run to completed
      await this.deps.db
        .update(marketAssessmentRuns)
        .set({
          status: 'completed',
          completedAt: new Date(),
          evidenceRefs: evidence.segmentKey ? [`evidence:${runId}`] : [],
        })
        .where(eq(marketAssessmentRuns.id, runId));

      this.log.info({ runId, segmentKey, artifactId: artifact.id }, 'Assessment run completed');

      return {
        id: runId,
        segmentKey,
        venueFamily: segmentKey.venueFamily,
        styleTier: segmentKey.styleTier,
        universeScopeHash: segmentKey.universeScopeHash,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'completed',
        evidenceRefs: [`evidence:${runId}`],
        errorMessage: null,
        assessmentVersion: 1,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log.error({ err, runId, segmentKey }, 'Assessment run failed');

      await this.deps.db
        .update(marketAssessmentRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errorMessage,
        })
        .where(eq(marketAssessmentRuns.id, runId));

      return {
        id: runId,
        segmentKey,
        venueFamily: segmentKey.venueFamily,
        styleTier: segmentKey.styleTier,
        universeScopeHash: segmentKey.universeScopeHash,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        evidenceRefs: [],
        errorMessage,
        assessmentVersion: 1,
      };
    }
  }

  // ── Evidence Collection ────────────────────────────────────────────────

  /** Collect deterministic evidence for a segment */
  async collectEvidence(segmentKey: MarketAssessmentSegmentKey): Promise<EvidencePackage> {
    // Phase 1 skeleton — returns placeholder data.
    // Full implementation will integrate with shared market data infrastructure.
    const regime = await this.deps.getRegimeSnapshot(segmentKey).catch((err) => {
      this.log.warn({ err, segmentKey }, 'Regime snapshot failed — using placeholder');
      return PLACEHOLDER_REGIME;
    });

    return {
      segmentKey,
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
    _segmentKey: MarketAssessmentSegmentKey,
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
    segmentKey: MarketAssessmentSegmentKey,
    _evidence: EvidencePackage,
    scorecards: PresetScorecardEntry[],
  ): Promise<MarketAssessmentArtifact> {
    // Phase 1 skeleton — returns a basic artifact without LLM call.
    // Full implementation will construct a prompt and call the platform LLM.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.artifactStalenessMs);

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
      segmentKey,
      venueFamily: segmentKey.venueFamily,
      styleTier: segmentKey.styleTier,
      universeScopeHash: segmentKey.universeScopeHash,
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
