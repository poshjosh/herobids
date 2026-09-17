import { describe, it, expect, vi } from 'vitest';
import { PlatformAssessor } from './platform-assessor.js';
import type { PlatformAssessorRuntimeConfig, PlatformAssessorDeps } from './platform-assessor.js';
import type { AssessmentEvidencePorts, DerivedCandleEvidence } from './assessment-ports.js';
import { ok, err } from '@herobids/domain';
import {
  AssessmentEvidenceSnapshotSchema,
  EvidenceValueSchema,
  RegimeResultSchema,
  PresetScorecardEntrySchema,
} from '@herobids/domain';
import type {
  PresetEntry,
  MarketAssessmentIdentity,
  AssessmentData,
  AssessmentUnavailable,
  PresetScorecardEntry,
  AssessmentEvidenceSnapshot,
  EvidenceValue,
  RegimeResult,
  ScorecardInput,
  VolatilityEvidence,
  LiquidityEvidence,
  BreadthEvidence,
} from '@herobids/domain';
import type { PriceCandle } from '@herobids/domain';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeIdentity(overrides?: Partial<Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>>): MarketAssessmentIdentity {
  return {
    instrumentKind: 'perp',
    venueFamily: 'hyperliquid-orderbook',
    styleTier: 'standard',
    symbol: 'BTC',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PlatformAssessorRuntimeConfig>): PlatformAssessorRuntimeConfig {
  return {
    enabled: true,
    maxConcurrentAssessments: 1,
    cacheFreshnessMs: 60_000,
    ...overrides,
  };
}

function makeExpiredAssessmentData<T>(data: T, source: string): AssessmentData<T> {
  return {
    data,
    source,
    provider: 'test',
    observedAt: new Date(Date.now() - 600_000).toISOString(),
    expiresAt: new Date(Date.now() - 1).toISOString(), // expired 1ms ago
  };
}

function makeAssessmentUnavailable(reasonCode: string): AssessmentUnavailable {
  return {
    reasonCode,
    message: `Test: ${reasonCode}`,
    observedAt: new Date().toISOString(),
  };
}

// ── In-memory DB mock ──────────────────────────────────────────────────────

function makeDbMock() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
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

// ── Mock candles ───────────────────────────────────────────────────────────

function makeMockCandles(count: number): PriceCandle[] {
  const candles: PriceCandle[] = [];
  let price = 50000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (Math.random() - 0.5) * 200;
    const high = Math.max(open, close) + Math.random() * 100;
    const low = Math.min(open, close) - Math.random() * 100;
    candles.push({
      timestamp: new Date(Date.now() - (count - i) * 3600000).toISOString(),
      open,
      high,
      low,
      close,
      volume: Math.random() * 100,
    });
    price = close;
  }
  return candles;
}

// ── Mock derived candle evidence ─────────────────────────────────────────────
//
// D1-b: the candle port returns DERIVED scalars over the boundary, not raw
// OHLCV. This mirrors the shape createEvidencePorts produces from get_volatility
// (volatility) + score_candidate (candleWindow + count).

function makeDerivedCandles(overrides?: Partial<DerivedCandleEvidence>): DerivedCandleEvidence {
  return {
    volatility: { averageTrueRange: 0.75, volatilityRegime: 'normal', calculationVersion: '1.0.0' },
    candleWindow: { start: '2026-07-19T09:00:00.000Z', end: '2026-07-19T10:00:00.000Z' },
    candlesEvaluated: 48,
    ...overrides,
  };
}

// ── Mock preset entry ──────────────────────────────────────────────────────

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

// ── Mock regime result ─────────────────────────────────────────────────────

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

// ── Deps factory ───────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<PlatformAssessorDeps>): PlatformAssessorDeps {
  const defaultEvidencePorts: AssessmentEvidencePorts = {
    regime: {
      getRegime: vi.fn(async () => ok({
        data: {
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
        },
        source: 'test-regime',
        provider: 'test',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })),
    },
    candles: {
      getCandles: vi.fn(async () => ok({
        data: makeDerivedCandles(),
        source: 'test-candles',
        provider: 'test',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })),
    },
    liquidity: {
      getLiquidity: vi.fn(async () => ok({
        data: { averageSpreadBps: 3, averageDepthUsd: 100000, quality: 'good' as const },
        source: 'test-liquidity',
        provider: 'test',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })),
    },
    breadth: {
      getBreadth: vi.fn(async () => ok({
        data: { symbolsAboveMA: 5, totalSymbols: 10, breadthRatio: 0.5 },
        source: 'test-breadth',
        provider: 'test',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })),
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
    callLlm: vi.fn(async (_prompt: string) => ({ text: '{}', usage: { provider: 'test', model: 'test', inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } })),
    // Orderbook/perp preset scoring routes over this boundary (L3 Q2). Default:
    // a signal + candles evaluated → scanHealth 'healthy'.
    scoreCandidateBoundary: {
      invoke: vi.fn(async () => ({ kind: 'success' as const, data: { signal: { confidence: 0.5 }, candlesEvaluated: 100 } })),
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PlatformAssessor', () => {
  describe('construction', () => {
    it('applies defaults when minimal config is provided', () => {
      const assessor = new PlatformAssessor({}, makeDeps());
      expect(assessor).toBeDefined();
    });

    it('respects explicit config values', () => {
      const assessor = new PlatformAssessor(
        { cacheFreshnessMs: 120_000 },
        makeDeps(),
      );
      expect(assessor).toBeDefined();
    });
  });

  describe('assessIdentity', () => {
    it('returns an ok result with an artifact for a valid identity', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.artifact.id).toBeDefined();
        expect(result.data.artifact.status).toBe('active');
        expect(result.data.artifact.venueFamily).toBe(identity.venueFamily);
        expect(result.data.artifact.styleTier).toBe(identity.styleTier);
        expect(result.data.artifact.presetRankings).toHaveLength(3);
        expect(result.data.artifact.recommendedPreset).toBe('momentum_v1');
      }
    });

    it('returns an err result when disabled', async () => {
      const assessor = new PlatformAssessor({ enabled: false }, makeDeps());
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.disabled');
      }
    });

    it('returns an err result when evidence is unavailable', async () => {
      const deps = makeDeps();
      deps.evidencePorts.regime.getRegime = vi.fn(async () => err({ code: 'test.error', message: 'regime down' }));
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.assessIdentity(makeIdentity());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_unavailable');
      }
    });

    it('handles swap/dex identity', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc123',
      };

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.artifact.venueFamily).toBe('jupiter');
        expect(result.data.artifact.styleTier).toBe('economy');
      }
    });
  });

  describe('collectEvidence', () => {
    it('returns an ok result with an AssessmentEvidenceSnapshot', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const result = await assessor.collectEvidence(identity);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.identity).toEqual(identity);
        expect(result.data.collectedAt).toBeDefined();
        expect(result.data.regime.state).toBe('available');
        expect(result.data.symbolCandles.state).toBe('available');
        expect(result.data.volatility.state).toBe('available');
        expect(result.data.breadth.state).toBe('available');
      }
    });

    it('returns err when regime is unavailable', async () => {
      const deps = makeDeps();
      deps.evidencePorts.regime.getRegime = vi.fn(async () => err({ code: 'test.error', message: 'regime down' }));
      const assessor = new PlatformAssessor(makeConfig(), deps);
      const result = await assessor.collectEvidence(makeIdentity());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_unavailable');
      }
    });

    it('returns assessment.evidence_stale when regime is stale', async () => {
      const deps = makeDeps();
      deps.evidencePorts.regime.getRegime = vi.fn(async () =>
        ok(makeExpiredAssessmentData(
          { pass: true, reasons: ['test'], details: { benchmarkSymbol: 'BTC', currentPrice: 50000, emaFast: 49800, emaSlow: 49000, emaTrend: 48500, emaAlignment: 'bullish' as const, adxValue: 28, choppy: false, vwap: 49700, priceAboveVwap: true, marketStructure: 'higherHighs' as const } },
          'test-regime',
        )),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_stale');
      }
    });

    it('returns assessment.evidence_stale when candles are stale', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok(makeExpiredAssessmentData(makeDerivedCandles(), 'test-candles')),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_stale');
      }
    });

    it('returns assessment.evidence_unavailable when candles are unavailable', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        err({ code: 'test.error', message: 'candles down' }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.evidence_unavailable');
      }
    });

    it('still returns ok when liquidity is unavailable (non-mandatory)', async () => {
      const deps = makeDeps();
      deps.evidencePorts.liquidity.getLiquidity = vi.fn(async () =>
        err({ code: 'test.error', message: 'liquidity down' }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.liquidity.state).toBe('unavailable');
      }
    });

    it('still returns ok when breadth is unavailable (non-mandatory)', async () => {
      const deps = makeDeps();
      deps.evidencePorts.breadth.getBreadth = vi.fn(async () =>
        err({ code: 'test.error', message: 'breadth down' }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.breadth.state).toBe('unavailable');
      }
    });

    it('handles breadth returning AssessmentUnavailable (not error)', async () => {
      const deps = makeDeps();
      deps.evidencePorts.breadth.getBreadth = vi.fn(async () =>
        ok(makeAssessmentUnavailable('assessment.breadth_not_configured')),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.breadth.state).toBe('unavailable');
      }
    });

    it('returns ok with unavailable volatility when the boundary reports no reading', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok({
          data: makeDerivedCandles({ volatility: null }),
          source: 'test-candles',
          provider: 'test',
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.volatility.state).toBe('unavailable');
        if (result.data.volatility.state === 'unavailable') {
          expect(result.data.volatility.reasonCode).toContain('volatility');
        }
      }
    });

    it('marks symbolCandles unavailable when no candles were evaluated behind the boundary', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok({
          data: makeDerivedCandles({ candlesEvaluated: 0, candleWindow: null }),
          source: 'test-candles',
          provider: 'test',
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.symbolCandles.state).toBe('unavailable');
        // scorecardInput still builds from the (empty) derived window + count.
        expect(result.data.scorecardInput.state).toBe('available');
        if (result.data.scorecardInput.state === 'available') {
          expect(result.data.scorecardInput.value.candlesAvailable).toBe(0);
        }
      }
    });

    it('derives volatility, candle-window, and count from the boundary read', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok({
          data: makeDerivedCandles({
            volatility: { averageTrueRange: 2.5, volatilityRegime: 'extreme', calculationVersion: '1.0.0' },
            candleWindow: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T12:00:00.000Z' },
            candlesEvaluated: 24,
          }),
          source: 'boundary-derived',
          provider: 'binance',
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.collectEvidence(makeIdentity());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.data.symbolCandles.state).toBe('available');
      if (result.data.volatility.state === 'available') {
        // Passed through verbatim from the boundary-derived VolatilityEvidence:
        // absolute-units ATR (H1), percentile regime label (H2), Traderton version.
        expect(result.data.volatility.value.averageTrueRange).toBe(2.5);
        expect(result.data.volatility.value.volatilityRegime).toBe('extreme');
        expect(result.data.volatility.value.calculationVersion).toBe('1.0.0');
      }
      if (result.data.scorecardInput.state === 'available') {
        expect(result.data.scorecardInput.value.candleWindow).toEqual({
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-01-01T12:00:00.000Z',
        });
        expect(result.data.scorecardInput.value.candlesAvailable).toBe(24);
      }
    });
  });

  describe('generateScorecards', () => {
    it('returns one entry per preset', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'p1', entry: makeMockPresetEntry('p1', 'momentum', 'trend-following') },
        { key: 'p2', entry: makeMockPresetEntry('p2', 'range', 'mean-reverting') },
        { key: 'p3', entry: makeMockPresetEntry('p3', 'swing', 'trend-following') },
      ];

      const result = await assessor.generateScorecards(identity, candles, presets);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(3);
      expect(scorecards[0]!.presetKey).toBe('p1');
      expect(scorecards.every((s) => ['healthy', 'degraded', 'no_signal', 'stale'].includes(s.scanHealth))).toBe(true);
    });

    it('returns empty array for empty presets', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);

      const result = await assessor.generateScorecards(identity, candles, []);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(0);
    });

    it('skips DCA presets', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'dca_v1', entry: makeMockPresetEntry('dca_v1', 'dca', 'neutral') },
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];

      const result = await assessor.generateScorecards(identity, candles, presets);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(1);
      expect(scorecards[0]!.presetKey).toBe('momentum_v1');
    });

    it('propagates an error when the boundary reports an infrastructure failure', async () => {
      // The boundary failing (e.g. candle provider down) must surface as an error
      // Result — NOT a synthesized scan-health. Orderbook/perp scoring routes over
      // the boundary, so a failing boundary is the infra-failure case here.
      const deps = makeDeps({
        scoreCandidateBoundary: {
          invoke: vi.fn(async () => ({ kind: 'failure' as const, code: 'upstream.transient', message: 'down', retryable: true })),
        },
      });
      const assessor = new PlatformAssessor(makeConfig(), deps);
      const identity = makeIdentity();
      const candles = makeMockCandles(100);

      const result = await assessor.generateScorecards(identity, candles, [
        { key: 'p1', entry: makeMockPresetEntry('p1', 'momentum', 'trend-following') },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.scorecard_failed');
      }
    });

    it('returns PresetScorecardEntry with evaluationScope field set', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
        { key: 'mean_reversion_v1', entry: makeMockPresetEntry('mean_reversion_v1', 'range', 'mean-reverting') },
      ];

      const result = await assessor.generateScorecards(identity, candles, presets);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(2);
      for (const entry of scorecards) {
        expect(entry.evaluationScope).toBe('single_symbol_dry_run');
      }
    });
  });

  describe('rankPresets', () => {
    it('returns a basic artifact with all required fields', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];
      const scorecardsResult = await assessor.generateScorecards(identity, candles, presets);
      expect(scorecardsResult.ok).toBe(true);
      if (!scorecardsResult.ok) throw new Error('expected ok');
      const scorecards = scorecardsResult.data;

      const rankingResult = await assessor.rankPresets(identity, {} as never, scorecards, []);
      expect(rankingResult.ok).toBe(true);
      if (!rankingResult.ok) throw new Error('expected ok');
      const artifact = rankingResult.data.artifact;
      expect(artifact.id).toBeDefined();
      expect(artifact.venueFamily).toBe(identity.venueFamily);
      expect(artifact.styleTier).toBe(identity.styleTier);
      expect(artifact.status).toBe('active');
      expect(artifact.presetRankings).toHaveLength(1);
      expect(artifact.recommendedPreset).toBe('momentum_v1');
    });

    it('handles empty scorecards gracefully', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();

      const rankingResult = await assessor.rankPresets(identity, {} as never, [], []);
      expect(rankingResult.ok).toBe(true);
      if (!rankingResult.ok) throw new Error('expected ok');
      const artifact = rankingResult.data.artifact;
      expect(artifact.presetRankings).toHaveLength(0);
      expect(artifact.recommendedPreset).toBeNull();
    });
  });

  describe('Zod schema validation', () => {
    describe('evidence snapshot Zod validation round-trip', () => {
      it('validates, serializes, deserializes, and re-validates a snapshot', () => {
        const regime: EvidenceValue<RegimeResult> = {
          state: 'available',
          value: makeRegimeResult(),
          source: 'test-regime',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        const candles: PriceCandle[] = [
          { timestamp: '2026-07-19T09:00:00.000Z', open: 50000, high: 50200, low: 49900, close: 50100, volume: 150 },
          { timestamp: '2026-07-19T09:15:00.000Z', open: 50100, high: 50300, low: 50050, close: 50250, volume: 200 },
        ];

        const volatility: EvidenceValue<VolatilityEvidence> = {
          state: 'available',
          value: { averageTrueRange: 125.5, volatilityRegime: 'normal', calculationVersion: '1.0.0' },
          source: 'computed',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        const liquidity: EvidenceValue<LiquidityEvidence> = {
          state: 'available',
          value: { averageSpreadBps: 3.2, averageDepthUsd: 150000, quality: 'good' },
          source: 'test-liquidity',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        const breadth: EvidenceValue<BreadthEvidence> = {
          state: 'available',
          value: { symbolsAboveMA: 7, totalSymbols: 10, breadthRatio: 0.7 },
          source: 'test-breadth',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        const scorecardInput: EvidenceValue<ScorecardInput> = {
          state: 'available',
          value: {
            symbol: 'BTC',
            candleWindow: { start: '2026-07-19T09:00:00.000Z', end: '2026-07-19T09:15:00.000Z' },
            candlesAvailable: 2,
          },
          source: 'computed',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        const snapshot: AssessmentEvidenceSnapshot = {
          schemaVersion: 1,
          identity: makeIdentity(),
          collectedAt: '2026-07-19T10:00:00.000Z',
          regime,
          symbolCandles: {
            state: 'available',
            value: candles,
            source: 'test-candles',
            observedAt: '2026-07-19T10:00:00.000Z',
            expiresAt: '2026-07-19T10:05:00.000Z',
          },
          volatility,
          liquidity,
          breadth,
          scorecardInput,
        };

        // Step 1: Validate
        const parsed = AssessmentEvidenceSnapshotSchema.safeParse(snapshot);
        expect(parsed.success).toBe(true);

        // Step 2: Serialize to JSON
        const json = JSON.stringify(snapshot);

        // Step 3: Parse back
        const roundTripped = JSON.parse(json) as AssessmentEvidenceSnapshot;

        // Step 4: Re-validate after round-trip
        const revalidated = AssessmentEvidenceSnapshotSchema.safeParse(roundTripped);
        expect(revalidated.success).toBe(true);

        // Step 5: All evidence values are preserved
        if (revalidated.success) {
          const rt = revalidated.data;
          expect(rt.schemaVersion).toBe(1);
          expect(rt.identity.symbol).toBe('BTC');
          expect(rt.collectedAt).toBe('2026-07-19T10:00:00.000Z');

          // Regime values preserved
          if (rt.regime.state === 'available') {
            expect(rt.regime.value.details.currentPrice).toBe(50200);
            expect(rt.regime.value.details.emaAlignment).toBe('bullish');
            expect(rt.regime.value.details.adxValue).toBe(28);
          }

          // Candles preserved
          if (rt.symbolCandles.state === 'available') {
            expect(rt.symbolCandles.value).toHaveLength(2);
            expect(rt.symbolCandles.value[0]!.close).toBe(50100);
          }

          // Volatility preserved
          if (rt.volatility.state === 'available') {
            expect(rt.volatility.value.averageTrueRange).toBe(125.5);
            expect(rt.volatility.value.volatilityRegime).toBe('normal');
          }

          // Liquidity preserved
          if (rt.liquidity.state === 'available') {
            expect(rt.liquidity.value.averageDepthUsd).toBe(150000);
          }

          // Breadth preserved
          if (rt.breadth.state === 'available') {
            expect(rt.breadth.value.breadthRatio).toBe(0.7);
          }

          // ScorecardInput preserved
          if (rt.scorecardInput.state === 'available') {
            expect(rt.scorecardInput.value.symbol).toBe('BTC');
            expect(rt.scorecardInput.value.candlesAvailable).toBe(2);
          }
        }
      });
    });

    describe('EvidenceValue serialization round-trip', () => {
      it('preserves available state with complex RegimeResult data', () => {
        const available: EvidenceValue<RegimeResult> = {
          state: 'available',
          value: {
            pass: false,
            reasons: ['Bearish EMA alignment', 'Price below VWAP', 'ADX weak'],
            details: {
              benchmarkSymbol: 'ETH',
              currentPrice: 3200.75,
              emaFast: 3210,
              emaSlow: 3250,
              emaTrend: 3300,
              emaAlignment: 'bearish',
              adxValue: 15,
              choppy: true,
              vwap: 3220,
              priceAboveVwap: false,
              marketStructure: 'lowerHighs',
            },
          },
          source: 'test-regime-eth',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        // Validate
        const evSchema = EvidenceValueSchema(RegimeResultSchema);
        const parsed = evSchema.safeParse(available);
        expect(parsed.success).toBe(true);

        // Serialize round-trip
        const json = JSON.stringify(available);
        const rt = JSON.parse(json) as EvidenceValue<RegimeResult>;
        const revalidated = evSchema.safeParse(rt);
        expect(revalidated.success).toBe(true);

        if (revalidated.success && revalidated.data.state === 'available') {
          const v = revalidated.data.value;
          expect(v.pass).toBe(false);
          expect(v.reasons).toHaveLength(3);
          expect(v.details.benchmarkSymbol).toBe('ETH');
          expect(v.details.currentPrice).toBe(3200.75);
          expect(v.details.emaAlignment).toBe('bearish');
          expect(v.details.adxValue).toBe(15);
          expect(v.details.choppy).toBe(true);
          expect(v.details.marketStructure).toBe('lowerHighs');
        }
      });

      it('preserves unavailable state through round-trip', () => {
        const unavailable: EvidenceValue<RegimeResult> = {
          state: 'unavailable',
          reasonCode: 'assessment.regime_timeout',
          message: 'Regime source timed out after 30s',
          observedAt: '2026-07-19T10:00:00.000Z',
        };

        // Validate
        const evSchema = EvidenceValueSchema(RegimeResultSchema);
        const parsed = evSchema.safeParse(unavailable);
        expect(parsed.success).toBe(true);

        // Serialize round-trip
        const json = JSON.stringify(unavailable);
        const rt = JSON.parse(json) as EvidenceValue<RegimeResult>;
        const revalidated = evSchema.safeParse(rt);
        expect(revalidated.success).toBe(true);

        if (revalidated.success && revalidated.data.state === 'unavailable') {
          expect(revalidated.data.reasonCode).toBe('assessment.regime_timeout');
          expect(revalidated.data.message).toBe('Regime source timed out after 30s');
          expect(revalidated.data.observedAt).toBe('2026-07-19T10:00:00.000Z');
        }
      });

      it('discriminates available from unavailable after round-trip', () => {
        const evSchema = EvidenceValueSchema(RegimeResultSchema);

        const available: EvidenceValue<RegimeResult> = {
          state: 'available',
          value: makeRegimeResult(),
          source: 'test',
          observedAt: '2026-07-19T10:00:00.000Z',
          expiresAt: '2026-07-19T10:05:00.000Z',
        };

        const unavailable: EvidenceValue<RegimeResult> = {
          state: 'unavailable',
          reasonCode: 'test.code',
          message: 'test message',
          observedAt: '2026-07-19T10:00:00.000Z',
        };

        // Round-trip both
        const availRt = evSchema.safeParse(JSON.parse(JSON.stringify(available)));
        const unavailRt = evSchema.safeParse(JSON.parse(JSON.stringify(unavailable)));

        expect(availRt.success).toBe(true);
        expect(unavailRt.success).toBe(true);

        if (availRt.success) expect(availRt.data.state).toBe('available');
        if (unavailRt.success) expect(unavailRt.data.state).toBe('unavailable');
      });
    });

    describe('PresetScorecardEntry schema validation', () => {
      it('validates a realistic PresetScorecardEntry', () => {
        const entry: PresetScorecardEntry = {
          presetKey: 'momentum_v1',
          presetBehaviorVersion: 'abc123def456',
          candidatesDiscovered: 1,
          candidatesScored: 1,
          signalsGenerated: 1,
          topConfidence: 0.85,
          scanHealth: 'healthy',
          evaluationScope: 'single_symbol_dry_run',
        };

        const parsed = PresetScorecardEntrySchema.safeParse(entry);
        expect(parsed.success).toBe(true);

        if (parsed.success) {
          expect(parsed.data.presetKey).toBe('momentum_v1');
          expect(parsed.data.presetBehaviorVersion).toBe('abc123def456');
          expect(parsed.data.candidatesDiscovered).toBe(1);
          expect(parsed.data.candidatesScored).toBe(1);
          expect(parsed.data.signalsGenerated).toBe(1);
          expect(parsed.data.topConfidence).toBe(0.85);
          expect(parsed.data.scanHealth).toBe('healthy');
          expect(parsed.data.evaluationScope).toBe('single_symbol_dry_run');
        }
      });

      it('validates a no_signal entry with null confidence', () => {
        const entry: PresetScorecardEntry = {
          presetKey: 'mean_reversion_v1',
          presetBehaviorVersion: 'xyz789',
          candidatesDiscovered: 1,
          candidatesScored: 1,
          signalsGenerated: 0,
          topConfidence: null,
          scanHealth: 'no_signal',
          evaluationScope: 'single_symbol_dry_run',
        };

        const parsed = PresetScorecardEntrySchema.safeParse(entry);
        expect(parsed.success).toBe(true);

        if (parsed.success) {
          expect(parsed.data.topConfidence).toBeNull();
          expect(parsed.data.scanHealth).toBe('no_signal');
        }
      });

      it('rejects invalid scanHealth values', () => {
        const entry = {
          presetKey: 'bad',
          presetBehaviorVersion: 'v1',
          candidatesDiscovered: 0,
          candidatesScored: 0,
          signalsGenerated: 0,
          topConfidence: null,
          scanHealth: 'invalid_value',
          evaluationScope: 'single_symbol_dry_run',
        };

        const parsed = PresetScorecardEntrySchema.safeParse(entry);
        expect(parsed.success).toBe(false);
      });

      it('round-trips through JSON serialization', () => {
        const entry: PresetScorecardEntry = {
          presetKey: 'trend_following_v1',
          presetBehaviorVersion: 'hash789abc',
          candidatesDiscovered: 1,
          candidatesScored: 1,
          signalsGenerated: 1,
          topConfidence: 0.92,
          scanHealth: 'healthy',
          evaluationScope: 'single_symbol_dry_run',
        };

        const json = JSON.stringify(entry);
        const rt = JSON.parse(json) as PresetScorecardEntry;
        const revalidated = PresetScorecardEntrySchema.safeParse(rt);

        expect(revalidated.success).toBe(true);
        if (revalidated.success) {
          expect(revalidated.data.presetKey).toBe('trend_following_v1');
          expect(revalidated.data.topConfidence).toBe(0.92);
          expect(revalidated.data.evaluationScope).toBe('single_symbol_dry_run');
        }
      });
    });
  });
});
