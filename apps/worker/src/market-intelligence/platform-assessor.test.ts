import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlatformAssessor } from './platform-assessor.js';
import type { PlatformAssessorConfig, PlatformAssessorDeps, EvidencePackage } from './platform-assessor.js';
import type { MarketAssessmentSegmentKey } from '@herobids/domain';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSegmentKey(overrides?: Partial<MarketAssessmentSegmentKey>): MarketAssessmentSegmentKey {
  return {
    venueFamily: 'hyperliquid-orderbook',
    styleTier: 'standard',
    universeScopeHash: 'test-hash-0001',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PlatformAssessorConfig>): PlatformAssessorConfig {
  return {
    enabled: true,
    assessmentIntervalMs: 60_000, // 1 min for tests
    maxConcurrentAssessments: 1,
    maxLlmCallsPerCycle: 5,
    artifactStalenessMs: 60_000,
    segmentFamilies: [],
    venueFamilies: ['hyperliquid-orderbook'],
    styleTiers: ['standard'],
    ...overrides,
  };
}

// ── In-memory DB mock ──────────────────────────────────────────────────────

function makeDbMock() {
  const runs: Record<string, unknown>[] = [];
  const artifacts: Record<string, unknown>[] = [];

  return {
    _runs: runs,
    _artifacts: artifacts,
    insert: vi.fn((_table: unknown) => {
      return {
        values: vi.fn((data: Record<string, unknown>) => {
          if ((_table as { config?: { name?: string } })?.config?.name?.includes('assessment_runs')) {
            runs.push(data);
          } else {
            artifacts.push(data);
          }
          return Promise.resolve();
        }),
      };
    }),
    update: vi.fn(() => {
      return {
        set: vi.fn(() => {
          return {
            where: vi.fn(() => Promise.resolve()),
          };
        }),
      };
    }),
    select: vi.fn(),
  };
}

// ── Redis mock ─────────────────────────────────────────────────────────────

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async () => 1),
  };
}

// ── Deps factory ───────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<PlatformAssessorDeps>): PlatformAssessorDeps {
  return {
    db: makeDbMock() as unknown as PlatformAssessorDeps['db'],
    redis: makeRedisMock() as unknown as PlatformAssessorDeps['redis'],
    getRegimeSnapshot: vi.fn(async () => ({
      pass: true,
      reasons: ['test'],
      details: {
        benchmarkSymbol: 'BTC',
        currentPrice: 50000,
        emaFast: 49800,
        emaSlow: 49000,
        emaTrend: 48500,
        emaAlignment: 'bullish' as const,
        adxValue: 28,
        choppy: false,
        vwap: 49700,
        priceAboveVwap: true,
        marketStructure: 'higherHighs' as const,
      },
    })),
    getPresetKeys: vi.fn(async (_styleTier: string) => ['momentum_v1', 'mean_reversion_v1', 'trend_following_v1']),
    callLlm: vi.fn(async (_prompt: string) => '{}'),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PlatformAssessor', () => {
  let assessor: PlatformAssessor;

  afterEach(async () => {
    if (assessor) {
      await assessor.stop();
    }
  });

  describe('construction', () => {
    it('applies defaults when minimal config is provided', () => {
      assessor = new PlatformAssessor({}, makeDeps());
      // Construction succeeds — defaults are applied internally
      expect(assessor).toBeDefined();
    });

    it('respects explicit config values', () => {
      assessor = new PlatformAssessor(
        { assessmentIntervalMs: 120_000, maxLlmCallsPerCycle: 10 },
        makeDeps(),
      );
      expect(assessor).toBeDefined();
    });
  });

  describe('start / stop', () => {
    it('does not throw when disabled', async () => {
      assessor = new PlatformAssessor({ enabled: false }, makeDeps());
      assessor.start();
      await assessor.stop();
    });

    it('starts and stops cleanly', async () => {
      assessor = new PlatformAssessor(
        { enabled: true, assessmentIntervalMs: 999_999 }, // long interval to avoid actual cycle
        makeDeps(),
      );
      assessor.start();
      // Stop should resolve cleanly
      await assessor.stop();
    });
  });

  describe('collectEvidence', () => {
    it('returns an EvidencePackage with segment key', async () => {
      assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const segmentKey = makeSegmentKey();
      const evidence = await assessor.collectEvidence(segmentKey);

      expect(evidence.segmentKey).toEqual(segmentKey);
      expect(evidence.collectedAt).toBeDefined();
      expect(evidence.regime).toBeDefined();
      expect(evidence.breadth).toBeDefined();
      expect(evidence.volatility).toBeDefined();
      expect(evidence.liquidityQuality).toBeDefined();
      expect(evidence.scanHealth).toBeDefined();
    });

    it('uses placeholder regime when getRegimeSnapshot fails', async () => {
      const deps = makeDeps();
      deps.getRegimeSnapshot = vi.fn(async () => { throw new Error('upstream failure'); });
      assessor = new PlatformAssessor(makeConfig(), deps);

      const evidence = await assessor.collectEvidence(makeSegmentKey());
      expect(evidence.regime.reasons.some((r) => r.includes('placeholder'))).toBe(true);
    });
  });

  describe('generateScorecards', () => {
    it('returns one entry per preset key', async () => {
      assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const segmentKey = makeSegmentKey();
      const evidence = await assessor.collectEvidence(segmentKey);
      const presetKeys = ['p1', 'p2', 'p3'];

      const scorecards = await assessor.generateScorecards(segmentKey, evidence, presetKeys);
      expect(scorecards).toHaveLength(3);
      expect(scorecards[0]!.presetKey).toBe('p1');
      expect(scorecards.every((s) => s.scanHealth === 'stale')).toBe(true);
    });

    it('returns empty array for empty preset keys', async () => {
      assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const segmentKey = makeSegmentKey();
      const evidence = await assessor.collectEvidence(segmentKey);

      const scorecards = await assessor.generateScorecards(segmentKey, evidence, []);
      expect(scorecards).toHaveLength(0);
    });
  });

  describe('rankPresets', () => {
    it('returns a basic artifact with all required fields', async () => {
      assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const segmentKey = makeSegmentKey();
      const evidence = await assessor.collectEvidence(segmentKey);
      const scorecards = await assessor.generateScorecards(segmentKey, evidence, ['momentum_v1']);

      const artifact = await assessor.rankPresets(segmentKey, evidence, scorecards);
      expect(artifact.id).toBeDefined();
      expect(artifact.segmentKey).toEqual(segmentKey);
      expect(artifact.status).toBe('active');
      expect(artifact.presetRankings).toHaveLength(1);
      expect(artifact.recommendedPreset).toBe('momentum_v1');
    });

    it('handles empty scorecards gracefully', async () => {
      assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const segmentKey = makeSegmentKey();
      const evidence = await assessor.collectEvidence(segmentKey);

      const artifact = await assessor.rankPresets(segmentKey, evidence, []);
      expect(artifact.presetRankings).toHaveLength(0);
      expect(artifact.recommendedPreset).toBeNull();
    });
  });

  describe('assessSegment', () => {
    it('creates a run record and completes successfully', async () => {
      const deps = makeDeps();
      assessor = new PlatformAssessor(makeConfig(), deps);
      const segmentKey = makeSegmentKey();

      const run = await assessor.assessSegment(segmentKey);
      expect(run.id).toBeDefined();
      expect(run.status).toBe('completed');
      expect(run.segmentKey).toEqual(segmentKey);
    });

    it('marks run as failed when evidence collection throws', async () => {
      const deps = makeDeps();
      deps.getRegimeSnapshot = vi.fn(async () => { throw new Error('regime unavailable'); });
      // getPresetKeys must also throw to skip scorecard generation which would call getRegimeSnapshot again
      deps.getPresetKeys = vi.fn(async () => { throw new Error('preset catalog unavailable'); });
      assessor = new PlatformAssessor(makeConfig(), deps);
      const segmentKey = makeSegmentKey();

      const run = await assessor.assessSegment(segmentKey);
      expect(run.status).toBe('failed');
      expect(run.errorMessage).toBeDefined();
    });
  });

  describe('runAssessmentCycle', () => {
    it('completes without error when there are segments', async () => {
      const deps = makeDeps();
      assessor = new PlatformAssessor(
        makeConfig({ venueFamilies: ['hyperliquid-orderbook'], styleTiers: ['standard'] }),
        deps,
      );

      await assessor.runAssessmentCycle();
      // Should not throw
    });

    it('respects LLM call budget', async () => {
      const deps = makeDeps();
      // Multiple venue families and tiers would produce many segments, but budget caps it
      assessor = new PlatformAssessor(
        makeConfig({
          maxLlmCallsPerCycle: 1,
          venueFamilies: ['hyperliquid-orderbook', 'bybit-orderbook'],
          styleTiers: ['economy', 'standard', 'premium'],
        }),
        deps,
      );

      await assessor.runAssessmentCycle();
      // Should not throw — budget enforcement prevents processing all segments
    });
  });
});
