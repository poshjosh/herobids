import { describe, it, expect, vi } from 'vitest';
import { PlatformAssessor } from './platform-assessor.js';
import type { PlatformAssessorConfig, PlatformAssessorDeps } from './platform-assessor.js';
import type { AssessmentEvidencePorts } from './assessment-ports.js';
import { ok, err } from '@herobids/domain';
import type { PresetEntry, MarketAssessmentIdentity, AssessmentData, AssessmentUnavailable, PresetScorecardEntry } from '@herobids/domain';
import type { PriceCandle } from '@herobids/market-data';

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

function makeConfig(overrides?: Partial<PlatformAssessorConfig>): PlatformAssessorConfig {
  return {
    enabled: true,
    maxConcurrentAssessments: 1,
    maxLlmCallsPerCycle: 5,
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
        data: makeMockCandles(100),
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
        { maxLlmCallsPerCycle: 10, cacheFreshnessMs: 120_000 },
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
        ok(makeExpiredAssessmentData(makeMockCandles(100), 'test-candles')),
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

    it('returns ok with unavailable volatility when < 2 candles provided', async () => {
      const deps = makeDeps();
      deps.evidencePorts.candles.getCandles = vi.fn(async () =>
        ok({
          data: makeMockCandles(1),
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
  });

  describe('generateScorecards', () => {
    it('returns one entry per preset', () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'p1', entry: makeMockPresetEntry('p1', 'momentum', 'trend-following') },
        { key: 'p2', entry: makeMockPresetEntry('p2', 'range', 'mean-reverting') },
        { key: 'p3', entry: makeMockPresetEntry('p3', 'swing', 'trend-following') },
      ];

      const result = assessor.generateScorecards(identity, candles, presets);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(3);
      expect(scorecards[0]!.presetKey).toBe('p1');
      expect(scorecards.every((s) => ['healthy', 'degraded', 'no_signal', 'stale'].includes(s.scanHealth))).toBe(true);
    });

    it('returns empty array for empty presets', () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);

      const result = assessor.generateScorecards(identity, candles, []);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(0);
    });

    it('skips DCA presets', () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'dca_v1', entry: makeMockPresetEntry('dca_v1', 'dca', 'neutral') },
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];

      const result = assessor.generateScorecards(identity, candles, presets);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const scorecards = result.data;
      expect(scorecards).toHaveLength(1);
      expect(scorecards[0]!.presetKey).toBe('momentum_v1');
    });

    it('returns error when runner throws', () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      // Passing null candles with a non-empty presets list causes the runner to throw
      // (the loop body executes and accesses candles.length / iterates over candles)
      const result = assessor.generateScorecards(identity, null as unknown as PriceCandle[], [
        { key: 'p1', entry: makeMockPresetEntry('p1', 'momentum', 'trend-following') },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.scorecard_failed');
      }
    });

    it('returns PresetScorecardEntry with evaluationScope field set', () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const candles = makeMockCandles(100);
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
        { key: 'mean_reversion_v1', entry: makeMockPresetEntry('mean_reversion_v1', 'range', 'mean-reverting') },
      ];

      const result = assessor.generateScorecards(identity, candles, presets);

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
      const scorecardsResult = assessor.generateScorecards(identity, candles, presets);
      expect(scorecardsResult.ok).toBe(true);
      if (!scorecardsResult.ok) throw new Error('expected ok');
      const scorecards = scorecardsResult.data;

      const artifact = await assessor.rankPresets(identity, {} as never, scorecards);
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

      const artifact = await assessor.rankPresets(identity, {} as never, []);
      expect(artifact.presetRankings).toHaveLength(0);
      expect(artifact.recommendedPreset).toBeNull();
    });
  });
});
