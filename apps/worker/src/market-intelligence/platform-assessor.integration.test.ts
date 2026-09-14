import { describe, it, expect, vi } from 'vitest';
import { PlatformAssessor } from './platform-assessor.js';
import type { PlatformAssessorRuntimeConfig, PlatformAssessorDeps } from './platform-assessor.js';
import type { AssessmentEvidencePorts, DerivedCandleEvidence } from './assessment-ports.js';
import type {
  MarketAssessmentIdentity,
  PresetEntry,
  RegimeResult,
  AssessmentData,
  LiquidityEvidence,
  BreadthEvidence,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { PriceCandle } from '@herobids/market-data';

// ── Helpers (mirrors platform-assessor.test.ts) ────────────────────────────

function makeIdentity(
  overrides?: Partial<Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>>,
): MarketAssessmentIdentity {
  return {
    instrumentKind: 'perp',
    venueFamily: 'hyperliquid-orderbook',
    styleTier: 'standard',
    symbol: 'BTC',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PlatformAssessorRuntimeConfig>): PlatformAssessorRuntimeConfig {
  return { enabled: true, maxConcurrentAssessments: 1, cacheFreshnessMs: 60_000, ...overrides };
}

// D1-b: derived candle evidence over the boundary (no raw OHLCV).
function makeDerivedCandles(overrides?: Partial<DerivedCandleEvidence>): DerivedCandleEvidence {
  return {
    volatility: { averageTrueRange: 0.75, volatilityRegime: 'normal', calculationVersion: '1.0.0' },
    candleWindow: { start: '2026-07-19T09:00:00.000Z', end: '2026-07-19T10:00:00.000Z' },
    candlesEvaluated: 48,
    ...overrides,
  };
}

function makeMockPresetEntry(key: string, strategyType: string, signalBias: string): PresetEntry {
  return {
    name: key,
    description: 'Test preset',
    strategy: {
      type: strategyType,
      decisionMode: 'mechanical',
      params: {
        indicators: { rsi: { enabled: true }, macd: { enabled: true } },
        signalBias,
        candleInterval: '15m',
        candleLimit: 48,
      },
    },
  };
}

function makeDbMock() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    select: vi.fn(),
  };
}

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async () => 1),
  };
}

function makeRegimeResult(): RegimeResult {
  return {
    pass: true,
    reasons: ['Strong bullish alignment', 'ADX confirms trend strength'],
    details: {
      benchmarkSymbol: 'BTC',
      currentPrice: 50200,
      emaFast: 49800,
      emaSlow: 49000,
      emaTrend: 48500,
      emaAlignment: 'bullish',
      adxValue: 28,
      choppy: false,
      vwap: 49700,
      priceAboveVwap: true,
      marketStructure: 'higherHighs',
    },
  };
}

function makeAvailableAssessmentData<T>(data: T, source: string): AssessmentData<T> {
  return {
    data,
    source,
    provider: 'test',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

function makeDeps(overrides?: Partial<PlatformAssessorDeps>): PlatformAssessorDeps {
  const defaultEvidencePorts: AssessmentEvidencePorts = {
    regime: {
      getRegime: vi.fn(async () => ok(makeAvailableAssessmentData(makeRegimeResult(), 'test-regime'))),
    },
    candles: {
      getCandles: vi.fn(async () => ok(makeAvailableAssessmentData(makeDerivedCandles(), 'test-candles'))),
    },
    liquidity: {
      getLiquidity: vi.fn(async () =>
        ok(
          makeAvailableAssessmentData<LiquidityEvidence>(
            { averageSpreadBps: 3, averageDepthUsd: 100_000, quality: 'good' },
            'test-liquidity',
          ),
        ),
      ),
    },
    breadth: {
      getBreadth: vi.fn(async () =>
        ok(
          makeAvailableAssessmentData<BreadthEvidence>(
            { symbolsAboveMA: 5, totalSymbols: 10, breadthRatio: 0.5 },
            'test-breadth',
          ),
        ),
      ),
    },
  };

  return {
    db: makeDbMock() as unknown as PlatformAssessorDeps['db'],
    redis: makeRedisMock() as unknown as PlatformAssessorDeps['redis'],
    evidencePorts: defaultEvidencePorts,
    getPresets: vi.fn((_styleTier: string) => [
      { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      { key: 'mean_reversion_v1', entry: makeMockPresetEntry('mean_reversion_v1', 'range', 'mean-reverting') },
      { key: 'trend_following_v1', entry: makeMockPresetEntry('trend_following_v1', 'swing', 'trend-following') },
    ]),
    callLlm: vi.fn(async (_prompt: string) => ({
      text: '{}',
      usage: { provider: 'test', model: 'test', inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    })),
    // Orderbook/perp preset scoring routes over this boundary (L3 Q2). A fixed
    // signal + candles-evaluated gives deterministic, reproducible scorecards.
    scoreCandidateBoundary: {
      invoke: vi.fn(async () => ({ kind: 'success' as const, data: { signal: { confidence: 0.5 }, candlesEvaluated: 100 } })),
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PlatformAssessor integration', () => {
  // ── Test 1: Full pipeline ───────────────────────────────────────────────

  describe('full pipeline — evidence collection through scorecard generation', () => {
    it('produces evidence snapshot with all required fields', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();

      const evidenceResult = await assessor.collectEvidence(identity);

      expect(evidenceResult.ok).toBe(true);
      if (!evidenceResult.ok) throw new Error('expected ok');
      const snapshot = evidenceResult.data;

      // Required top-level fields
      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.identity).toEqual(identity);
      expect(snapshot.collectedAt).toBeDefined();

      // Evidence slots populated (all available in default mocks)
      expect(snapshot.regime.state).toBe('available');
      if (snapshot.regime.state === 'available') {
        expect(snapshot.regime.value.pass).toBe(true);
        expect(snapshot.regime.value.details.benchmarkSymbol).toBe('BTC');
      }

      // D1-b: symbolCandles is an availability FLAG (empty array, no OHLCV).
      expect(snapshot.symbolCandles.state).toBe('available');
      if (snapshot.symbolCandles.state === 'available') {
        expect(snapshot.symbolCandles.value).toHaveLength(0);
      }

      expect(snapshot.volatility.state).toBe('available');
      if (snapshot.volatility.state === 'available') {
        expect(snapshot.volatility.value.volatilityRegime).toBeDefined();
        expect(snapshot.volatility.value.averageTrueRange).toBeGreaterThan(0);
      }

      expect(snapshot.liquidity.state).toBe('available');
      expect(snapshot.breadth.state).toBe('available');
      expect(snapshot.scorecardInput.state).toBe('available');
    });

    it('returns a complete artifact with rankings for every preset', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const { artifact } = result.data;

      // Artifact identity matches
      expect(artifact.venueFamily).toBe(identity.venueFamily);
      expect(artifact.styleTier).toBe(identity.styleTier);
      expect(artifact.status).toBe('active');

      // Rankings cover all presets (3 in default mocks)
      expect(artifact.presetRankings).toHaveLength(3);
      const rankedKeys = artifact.presetRankings.map((r) => r.presetKey).sort();
      expect(rankedKeys).toEqual(['mean_reversion_v1', 'momentum_v1', 'trend_following_v1']);

      // allowedPresets matches
      expect(artifact.allowedPresets.sort()).toEqual(rankedKeys);

      // recommendedPreset is set
      expect(artifact.recommendedPreset).toBe('momentum_v1');

      // No placeholder summaries — all summary fields are non-empty strings
      expect(artifact.currentMarketSummary.length).toBeGreaterThan(0);
      expect(artifact.regimeSummary.length).toBeGreaterThan(0);
      expect(artifact.scanHealthSummary.length).toBeGreaterThan(0);
      expect(artifact.reasoningSummary.length).toBeGreaterThan(0);
    });

    it('contains no placeholder data in rankings', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const { artifact } = result.data;

      for (const ranking of artifact.presetRankings) {
        expect(ranking.presetKey.length).toBeGreaterThan(0);
        expect(ranking.presetBehaviorVersion.length).toBeGreaterThan(0);
        expect(ranking.rank).toBeGreaterThan(0);
        // No N/A placeholder scoreBand when real data is present
        expect(ranking.scoreBand).toBeDefined();
      }
    });
  });

  // ── Test 5: Shared artifact immunity ────────────────────────────────────

  describe('shared artifact immunity — second agent cannot influence result', () => {
    it('two assessors with same evidence ports produce identical results', async () => {
      // Shared evidence ports — both assessors see the same derived market data
      const sharedDerivedCandles = makeDerivedCandles();
      const sharedRegime = makeRegimeResult();

      const makeSharedEvidencePorts = (): AssessmentEvidencePorts => ({
        regime: {
          getRegime: vi.fn(async () => ok(makeAvailableAssessmentData(sharedRegime, 'shared-regime'))),
        },
        candles: {
          getCandles: vi.fn(async () =>
            ok(makeAvailableAssessmentData({ ...sharedDerivedCandles }, 'shared-candles')),
          ),
        },
        liquidity: {
          getLiquidity: vi.fn(async () =>
            ok(
              makeAvailableAssessmentData<LiquidityEvidence>(
                { averageSpreadBps: 2.5, averageDepthUsd: 200_000, quality: 'good' },
                'shared-liquidity',
              ),
            ),
          ),
        },
        breadth: {
          getBreadth: vi.fn(async () =>
            ok(
              makeAvailableAssessmentData<BreadthEvidence>(
                { symbolsAboveMA: 8, totalSymbols: 12, breadthRatio: 0.67 },
                'shared-breadth',
              ),
            ),
          ),
        },
      });

      const sharedPresets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
        { key: 'mean_reversion_v1', entry: makeMockPresetEntry('mean_reversion_v1', 'range', 'mean-reverting') },
      ];

      const sharedCallLlm = vi.fn(async (_prompt: string) => ({
        text: '{}',
        usage: { provider: 'test', model: 'test', inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      }));

      // Create TWO separate PlatformAssessor instances
      // Shared boundary: same fixed scoring outcome for both assessors, so the
      // orderbook/perp preset scorecards are identical.
      const makeSharedScoreBoundary = () => ({
        invoke: vi.fn(async () => ({ kind: 'success' as const, data: { signal: { confidence: 0.5 }, candlesEvaluated: 100 } })),
      });

      const assessorA = new PlatformAssessor(makeConfig(), {
        db: makeDbMock() as unknown as PlatformAssessorDeps['db'],
        redis: makeRedisMock() as unknown as PlatformAssessorDeps['redis'],
        evidencePorts: makeSharedEvidencePorts(),
        getPresets: vi.fn(() => sharedPresets),
        callLlm: sharedCallLlm,
        scoreCandidateBoundary: makeSharedScoreBoundary(),
      });

      const assessorB = new PlatformAssessor(makeConfig(), {
        db: makeDbMock() as unknown as PlatformAssessorDeps['db'],
        redis: makeRedisMock() as unknown as PlatformAssessorDeps['redis'],
        evidencePorts: makeSharedEvidencePorts(),
        getPresets: vi.fn(() => sharedPresets),
        callLlm: sharedCallLlm,
        scoreCandidateBoundary: makeSharedScoreBoundary(),
      });

      const identity = makeIdentity();

      const resultA = await assessorA.assessIdentity(identity);
      const resultB = await assessorB.assessIdentity(identity);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);

      if (!resultA.ok || !resultB.ok) throw new Error('expected ok');

      const artifactA = resultA.data.artifact;
      const artifactB = resultB.data.artifact;

      // Same rankings (same order, same keys)
      expect(artifactA.presetRankings).toHaveLength(artifactB.presetRankings.length);
      for (let i = 0; i < artifactA.presetRankings.length; i++) {
        expect(artifactA.presetRankings[i]!.presetKey).toBe(artifactB.presetRankings[i]!.presetKey);
        expect(artifactA.presetRankings[i]!.rank).toBe(artifactB.presetRankings[i]!.rank);
      }

      // Same recommended preset
      expect(artifactA.recommendedPreset).toBe(artifactB.recommendedPreset);

      // Same allowedPresets
      expect(artifactA.allowedPresets.sort()).toEqual(artifactB.allowedPresets.sort());

      // Same venueFamily and styleTier
      expect(artifactA.venueFamily).toBe(artifactB.venueFamily);
      expect(artifactA.styleTier).toBe(artifactB.styleTier);
    });
  });

  // ── Test 6: Snapshot immutability ───────────────────────────────────────

  describe('snapshot immutability — scorecards reproducible from snapshot', () => {
    it('generates identical scorecards over the boundary regardless of the (empty) snapshot candles', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok(makeAvailableAssessmentData(makeDerivedCandles(), 'test-candles')),
      );

      const assessor = new PlatformAssessor(makeConfig(), deps);
      const identity = makeIdentity();

      // Collect evidence once
      const evidenceResult = await assessor.collectEvidence(identity);
      expect(evidenceResult.ok).toBe(true);
      if (!evidenceResult.ok) throw new Error('expected ok');

      // D1-b: symbolCandles is an availability flag carrying an empty array.
      const snapshot = evidenceResult.data;
      expect(snapshot.symbolCandles.state).toBe('available');
      if (snapshot.symbolCandles.state !== 'available') throw new Error('expected available candles');

      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
        { key: 'mean_reversion_v1', entry: makeMockPresetEntry('mean_reversion_v1', 'range', 'mean-reverting') },
        { key: 'trend_following_v1', entry: makeMockPresetEntry('trend_following_v1', 'swing', 'trend-following') },
      ];

      // Generate scorecards twice from the same candles
      const result1 = await assessor.generateScorecards(identity, snapshot.symbolCandles.value as PriceCandle[], presets);
      const result2 = await assessor.generateScorecards(identity, snapshot.symbolCandles.value as PriceCandle[], presets);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) throw new Error('expected ok');

      const scorecards1 = result1.data;
      const scorecards2 = result2.data;

      // Same number of entries
      expect(scorecards1).toHaveLength(scorecards2.length);

      // Each entry is identical
      for (let i = 0; i < scorecards1.length; i++) {
        const s1 = scorecards1[i]!;
        const s2 = scorecards2[i]!;
        expect(s1.presetKey).toBe(s2.presetKey);
        expect(s1.presetBehaviorVersion).toBe(s2.presetBehaviorVersion);
        expect(s1.candidatesDiscovered).toBe(s2.candidatesDiscovered);
        expect(s1.candidatesScored).toBe(s2.candidatesScored);
        expect(s1.signalsGenerated).toBe(s2.signalsGenerated);
        expect(s1.topConfidence).toBe(s2.topConfidence);
        expect(s1.scanHealth).toBe(s2.scanHealth);
        expect(s1.evaluationScope).toBe(s2.evaluationScope);
      }
    });
  });

  // ── Test 7: Error-path — assessIdentity when regime is unavailable ──────

  describe('assessIdentity error paths', () => {
    it('returns structured error when regime is unavailable', async () => {
      const deps = makeDeps();
      deps.evidencePorts.regime.getRegime = vi.fn(async () =>
        err({ code: 'test.regime_down', message: 'Regime source is down' }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_unavailable');
      }
    });

    it('returns structured error when candles are stale', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok({
          data: makeDerivedCandles(),
          source: 'test-candles',
          provider: 'test',
          observedAt: new Date(Date.now() - 600_000).toISOString(),
          expiresAt: new Date(Date.now() - 1).toISOString(), // expired 1ms ago
        }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_stale');
      }
    });
  });
});
