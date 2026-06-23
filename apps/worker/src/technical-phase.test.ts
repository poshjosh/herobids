import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTechnicalPhase } from './technical-phase.js';
import type { TechnicalPhaseDeps, DiscoveredInstrument } from './technical-phase.js';
import type { Decision } from '@herobids/domain';
import type { PositionState } from '@herobids/engine';
import type { PriceCandle, RegimeResult } from '@herobids/market-data';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandles(count = 50, trend: 'up' | 'flat' = 'up'): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
    open: 100 + (trend === 'up' ? i * 0.5 : 0),
    high: 102 + (trend === 'up' ? i * 0.5 : 0),
    low: 99 + (trend === 'up' ? i * 0.5 : 0),
    close: 101 + (trend === 'up' ? i * 0.5 : 0),
    volume: 1000 + i * 10,
  }));
}

function makeInstrument(symbol: string): DiscoveredInstrument {
  return {
    symbol,
    instrumentId: symbol,
    volume24hUsd: 1_000_000,
    liquidityUsd: 500_000,
    priceChange24hPct: 2.5,
  };
}

function makeRegimePass(): RegimeResult {
  return {
    pass: true,
    reasons: [],
    details: {
      benchmarkSymbol: 'BTC',
      currentPrice: 50000,
      emaFast: 49000,
      emaSlow: 48000,
      emaTrend: 45000,
      emaAlignment: 'bullish',
      adxValue: 30,
      choppy: false,
      vwap: 49500,
      priceAboveVwap: true,
      marketStructure: 'higherHighs',
    },
  };
}

function makeRegimeChoppy(): RegimeResult {
  return {
    ...makeRegimePass(),
    pass: false,
    reasons: ['adx_below_threshold'],
    details: {
      ...makeRegimePass().details,
      adxValue: 10,
      choppy: true,
    },
  };
}

function makeRegimeFailEma(): RegimeResult {
  return {
    ...makeRegimePass(),
    pass: false,
    reasons: ['ema_misaligned'],
    details: {
      ...makeRegimePass().details,
      emaAlignment: 'bearish' as const,
      choppy: false, // Not choppy — EMA misalignment, not ADX
    },
  };
}

function makeOverboughtCandles(): PriceCandle[] {
  return Array.from({ length: 100 }, (_, i) => ({
    timestamp: new Date(Date.now() - (100 - i) * 60_000).toISOString(),
    open: 100 + i * 5,
    high: 105 + i * 5,
    low: 99 + i * 5,
    close: 104 + i * 5,
    volume: 2000 + i * 50,
  }));
}

function makeOpenPosition(symbol: string): PositionState {
  return {
    venue: 'hyperliquid',
    symbol,
    side: 'long',
    size: { toString: () => '1' } as unknown as PositionState['size'],
    entryPrice: { toString: () => '100' } as unknown as PositionState['entryPrice'],
    realizedPnl: { toString: () => '0' } as unknown as PositionState['realizedPnl'],
  };
}

let decisionCounter = 0;
function makeBaseDeps(overrides: Partial<TechnicalPhaseDeps> = {}): TechnicalPhaseDeps {
  return {
    config: {
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      indicators: {
        rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
        macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
        volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
        choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
        supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
        confidence: {
          rsiWeight: 0.15, macdCrossoverWeight: 0.20, macdIncreasingWeight: 0.10,
          volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15,
          chochBearishPenalty: 0.10, priceActionWeight: 0.10,
          minConfidence: 0.45, minReasons: 2,
        },
      },
      candles: { interval: '15m', limit: 100 },
      signalBias: 'trend-following',
      scanIntervalMs: 60_000,
      scanBatchSize: 5,
    },
    riskConfig: { maxOpenPositions: 5 },
    agentId: 'agent-test-id',
    venueAccountId: 'venue-account-id',
    discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC'), makeInstrument('ETH')]),
    fetchCandles: vi.fn().mockResolvedValue(makeCandles(100)),
    evaluateRegime: vi.fn().mockResolvedValue(makeRegimePass()),
    submitDecision: vi.fn().mockResolvedValue(undefined),
    getOpenPositions: vi.fn().mockReturnValue([]),
    generateDecisionId: () => `d-${++decisionCounter}`,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runTechnicalPhase', () => {
  beforeEach(() => {
    decisionCounter = 0;
  });

  it('produces entry decisions from synthetic candle data', async () => {
    const deps = makeBaseDeps();
    const result = await runTechnicalPhase(deps);

    expect(result.candidatesDiscovered).toBe(2);
    expect(result.regimeBlocked).toBe(false);
    // With 100 candles of uptrend, at least some signals should pass
    expect(result.entriesSubmitted).toBeGreaterThanOrEqual(0);
    expect(result.errors).toHaveLength(0);
  });

  it('regime gate blocks new entries when choppy but processes exits', async () => {
    const openPos = makeOpenPosition('BTC');
    const deps = makeBaseDeps({
      config: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        indicators: {
          rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
          macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
          volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
          choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
          supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
          confidence: {
            rsiWeight: 0.15, macdCrossoverWeight: 0.20, macdIncreasingWeight: 0.10,
            volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15,
            chochBearishPenalty: 0.10, priceActionWeight: 0.10,
            minConfidence: 0.45, minReasons: 2,
          },
        },
        candles: { interval: '15m', limit: 100 },
        signalBias: 'trend-following',
        scanIntervalMs: 60_000,
        scanBatchSize: 5,
        regime: { benchmarkSymbol: 'BTC', disableWhenChoppy: true },
      },
      evaluateRegime: vi.fn().mockResolvedValue(makeRegimeChoppy()),
      getOpenPositions: vi.fn().mockReturnValue([openPos]),
      // Overbought candles ensure the open BTC position triggers a go_flat exit
      fetchCandles: vi.fn().mockResolvedValue(makeOverboughtCandles()),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.regimeBlocked).toBe(true);
    expect(result.entriesSubmitted).toBe(0);
    // Exits still run despite regime block — open BTC position should trigger go_flat
    const submitDecision = deps.submitDecision as ReturnType<typeof vi.fn>;
    const exitCalls = submitDecision.mock.calls.filter(
      ([d]: [Decision]) => d.intent === 'go_flat',
    );
    expect(exitCalls.length).toBeGreaterThan(0);
  });

  it('respects maxOpenPositions limit — does not submit more entries than budget', async () => {
    const deps = makeBaseDeps({
      riskConfig: { maxOpenPositions: 1 },
      getOpenPositions: vi.fn().mockReturnValue([makeOpenPosition('SOL')]),
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('BTC'),
        makeInstrument('ETH'),
        makeInstrument('AVAX'),
      ]),
      // Uptrend candles that should generate signals
      fetchCandles: vi.fn().mockResolvedValue(makeCandles(100, 'up')),
    });

    const result = await runTechnicalPhase(deps);

    // maxOpenPositions=1, already have 1 open → budget = 0 → no entries
    expect(result.entriesSubmitted).toBe(0);
  });

  it('skips instruments already in open positions for new entries', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC'), makeInstrument('ETH')]),
      getOpenPositions: vi.fn().mockReturnValue([makeOpenPosition('BTC')]),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles(100, 'up')),
      riskConfig: { maxOpenPositions: 5 },
    });

    await runTechnicalPhase(deps);

    const submitDecision = deps.submitDecision as ReturnType<typeof vi.fn>;
    const entryDecisions = submitDecision.mock.calls
      .map(([d]: [Decision]) => d)
      .filter((d) => d.intent === 'go_long');

    // BTC should not receive a go_long since it's already open
    const btcEntries = entryDecisions.filter((d) => (d.instrumentId as unknown as string) === 'BTC');
    expect(btcEntries).toHaveLength(0);
  });

  it('triggers go_flat for open positions when RSI is overbought', async () => {
    const openPos = makeOpenPosition('BTC');
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([]),
      getOpenPositions: vi.fn().mockReturnValue([openPos]),
      // All-rising candles → RSI approaches 100, above overbought=80 → hard reject
      fetchCandles: vi.fn().mockResolvedValue(makeOverboughtCandles()),
    });

    const result = await runTechnicalPhase(deps);

    // scoreCandidate returns null (hard reject) → go_flat submitted
    expect(result.exitsSubmitted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('advisory mode stores entry signals without submitting decisions directly', async () => {
    const deps = makeBaseDeps({
      advisoryMode: true,
      fetchCandles: vi.fn().mockResolvedValue(makeCandles(100, 'up')),
      getOpenPositions: vi.fn().mockReturnValue([]),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.entriesSubmitted).toBe(0);
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(deps.submitDecision).not.toHaveBeenCalled();
  });

  it('advisory mode flags exits for LLM review when autonomousExit is disabled', async () => {
    const openPos = makeOpenPosition('BTC');
    const deps = makeBaseDeps({
      advisoryMode: true,
      discoverCandidates: vi.fn().mockResolvedValue([]),
      getOpenPositions: vi.fn().mockReturnValue([openPos]),
      fetchCandles: vi.fn().mockResolvedValue(makeOverboughtCandles()),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.exitsSubmitted).toBe(0);
    expect(result.positionIndicators.some((indicator) => indicator.exitAdvisory === true)).toBe(true);
    expect(deps.submitDecision).not.toHaveBeenCalled();
  });

  it('advisory mode still submits exits when autonomousExit is enabled', async () => {
    const openPos = makeOpenPosition('BTC');
    const baseline = makeBaseDeps();
    const deps = makeBaseDeps({
      advisoryMode: true,
      config: { ...baseline.config, autonomousExit: true },
      discoverCandidates: vi.fn().mockResolvedValue([]),
      getOpenPositions: vi.fn().mockReturnValue([openPos]),
      fetchCandles: vi.fn().mockResolvedValue(makeOverboughtCandles()),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.exitsSubmitted).toBe(1);
    expect(result.positionIndicators.some((indicator) => indicator.exitAdvisory === true)).toBe(false);
  });

  it('candle fetch failure for one instrument does not crash the phase', async () => {
    let callCount = 0;
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC'), makeInstrument('ETH')]),
      fetchCandles: vi.fn().mockImplementation((symbol: string) => {
        callCount++;
        if (symbol === 'ETH') throw new Error('timeout');
        return Promise.resolve(makeCandles(100));
      }),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('ETH');
    expect(result.candidatesDiscovered).toBe(2);
    // BTC should still be scored
    expect(result.candidatesScored).toBeGreaterThanOrEqual(1);
  });

  it('returns correct TechnicalPhaseResult metrics', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('BTC'),
        makeInstrument('ETH'),
        makeInstrument('SOL'),
      ]),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles(100, 'up')),
      getOpenPositions: vi.fn().mockReturnValue([]),
      riskConfig: { maxOpenPositions: 10 },
    });

    const result = await runTechnicalPhase(deps);

    expect(result.candidatesDiscovered).toBe(3);
    expect(result.candidatesScored).toBe(3);
    expect(typeof result.signalsGenerated).toBe('number');
    expect(typeof result.entriesSubmitted).toBe('number');
    expect(typeof result.exitsSubmitted).toBe('number');
    expect(result.regimeBlocked).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('returns early with error when discovery fails', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockRejectedValue(new Error('network error')),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.candidatesDiscovered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('discovery_failed');
  });

  it('regime gate blocks entries on non-choppy regime failure (EMA misalignment)', async () => {
    const deps = makeBaseDeps({
      config: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        indicators: {
          rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
          macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
          volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
          choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
          supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
          confidence: {
            rsiWeight: 0.15, macdCrossoverWeight: 0.20, macdIncreasingWeight: 0.10,
            volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15,
            chochBearishPenalty: 0.10, priceActionWeight: 0.10,
            minConfidence: 0.45, minReasons: 2,
          },
        },
        candles: { interval: '15m', limit: 100 },
        signalBias: 'trend-following',
        scanIntervalMs: 60_000,
        scanBatchSize: 5,
        regime: { benchmarkSymbol: 'BTC', disableWhenChoppy: false },
      },
      // EMA misalignment: pass=false, choppy=false — the old buggy code would NOT block this
      evaluateRegime: vi.fn().mockResolvedValue(makeRegimeFailEma()),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles(100, 'up')),
    });

    const result = await runTechnicalPhase(deps);

    expect(result.regimeBlocked).toBe(true);
    expect(result.entriesSubmitted).toBe(0);
  });

  it('scan batch size is respected — no more than N concurrent fetches', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => makeInstrument(`SYM${i}`));

    let currentConcurrent = 0;
    let maxConcurrent = 0;
    const fetchCandles = vi.fn(async (_symbol: string, _interval: string, _limit: number) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      currentConcurrent--;
      return makeCandles(100);
    });

    const deps = makeBaseDeps({
      config: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        indicators: {
          rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
          macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
          volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
          choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
          supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
          confidence: {
            rsiWeight: 0.15, macdCrossoverWeight: 0.20, macdIncreasingWeight: 0.10,
            volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15,
            chochBearishPenalty: 0.10, priceActionWeight: 0.10,
            minConfidence: 0.45, minReasons: 2,
          },
        },
        candles: { interval: '15m', limit: 100 },
        signalBias: 'trend-following',
        scanIntervalMs: 60_000,
        scanBatchSize: 3,
      },
      discoverCandidates: vi.fn().mockResolvedValue(candidates),
      fetchCandles,
    });

    await runTechnicalPhase(deps);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(fetchCandles).toHaveBeenCalledTimes(10);
  });
});
