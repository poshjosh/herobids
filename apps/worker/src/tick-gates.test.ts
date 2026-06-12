import { describe, expect, it, vi } from 'vitest';
import type { RegimeResult } from '@herobids/market-data';
import { calculateAtrPercent, isWithinTradingHours, resolveAdaptiveIntervalMs, shouldSkipTick } from './tick-gates.js';

function makeRegimeResult(pass: boolean, reasons: string[]): RegimeResult {
  return {
    pass,
    reasons,
    details: {
      benchmarkSymbol: 'BTC',
      currentPrice: 100,
      emaFast: 101,
      emaSlow: 100,
      emaTrend: 99,
      emaAlignment: pass ? 'bullish' : 'bearish',
      adxValue: pass ? 30 : 10,
      choppy: !pass,
      vwap: 99,
      priceAboveVwap: pass,
      marketStructure: pass ? 'higherHighs' : 'mixed',
    },
  };
}

describe('shouldSkipTick', () => {
  it('skips when regime is unfavorable and there are no open positions', async () => {
    const evaluateRegime = vi.fn().mockResolvedValue(makeRegimeResult(false, ['market is choppy']));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false },
      { evaluateRegime },
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain('regime_unfavorable');
    expect(evaluateRegime).toHaveBeenCalledTimes(1);
  });

  it('never skips when positions are open', async () => {
    const evaluateRegime = vi.fn().mockResolvedValue(makeRegimeResult(false, ['market is choppy']));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: true },
      { evaluateRegime },
    );

    expect(result.skip).toBe(false);
    expect(evaluateRegime).not.toHaveBeenCalled();
  });

  it('does not skip when no regime evaluator is available', async () => {
    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false },
      {},
    );

    expect(result.skip).toBe(false);
  });

  it('skips outside configured trading hours when flat', async () => {
    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        tradingHours: { allowedHoursUtc: [9, 10], weekendPause: false },
        now: new Date('2026-06-08T12:00:00.000Z'),
      },
      {},
    );

    expect(result.skip).toBe(true);
    expect(result.gate).toBe('session');
  });

  it('skips when decision context is unchanged before the forced tenth tick', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(second.skip).toBe(true);
    expect(second.reason).toBe('context_unchanged');
  });

  it('does not skip when hasWakeSignal is true even if context hash matches (flat position)', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const wakeTickResult = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        hasWakeSignal: true,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(wakeTickResult.skip).toBe(false);
  });

  it('does not skip when hasWakeSignal is true even if context hash matches (open position)', async () => {
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
      },
      {},
    );

    const wakeTickResult = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: true,
        hasWakeSignal: true,
        positionSide: 'long',
        latestPrice: 100,
        portfolioPnlUsd: 5,
        previousContextHash: first.contextHash,
      },
      {},
    );

    expect(wakeTickResult.skip).toBe(false);
  });

  it('forces a full evaluation every tenth tick even when the context hash matches', async () => {
    const regime = makeRegimeResult(true, ['All regime checks passed']);
    const first = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    const tenth = await shouldSkipTick(
      {
        tickNumber: 10,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 12,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime: vi.fn().mockResolvedValue(regime) },
    );

    expect(tenth.skip).toBe(false);
  });

  it('returns current interval without throwing when fetchVolatilityCandles fails', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('AbortError: This operation was aborted'));

    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        currentTickIntervalMs: 60_000,
        baseTickIntervalMs: 900_000,
      },
      { fetchVolatilityCandles },
    );

    expect(result.nextTickIntervalMs).toBe(60_000);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('adaptive_interval_unavailable');
  });

  it('returns base interval fallback when fetchVolatilityCandles fails and no current interval is set', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false, baseTickIntervalMs: 600_000 },
      { fetchVolatilityCandles },
    );

    expect(result.nextTickIntervalMs).toBe(600_000);
    expect(result.degraded).toBe(true);
  });

  it('preserves adaptive-interval degradation metadata on session skips', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: false,
        now: new Date('2026-06-08T12:00:00.000Z'),
        tradingHours: { allowedHoursUtc: [9], weekendPause: false },
        currentTickIntervalMs: 60_000,
        baseTickIntervalMs: 900_000,
      },
      { fetchVolatilityCandles },
    );

    expect(result.skip).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('adaptive_interval_unavailable');
  });

  it('preserves adaptive-interval degradation metadata when positions are open', async () => {
    const fetchVolatilityCandles = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await shouldSkipTick(
      {
        tickNumber: 1,
        hasOpenPositions: true,
        currentTickIntervalMs: 60_000,
        baseTickIntervalMs: 900_000,
      },
      { fetchVolatilityCandles },
    );

    expect(result.skip).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('adaptive_interval_unavailable');
  });

  it('makes no candle calls and returns deterministically when fetchVolatilityCandles is undefined', async () => {
    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false, baseTickIntervalMs: 900_000 },
      {},
    );

    expect(result.nextTickIntervalMs).toBe(900_000);
    expect(result.degraded).toBeUndefined();
  });

  it('returns without throwing and marks regime degraded when evaluateRegime fails', async () => {
    const evaluateRegime = vi.fn().mockRejectedValue(new Error('AbortError: This operation was aborted'));

    const result = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false },
      { evaluateRegime },
    );

    expect(result.skip).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe('regime_unavailable');
    expect(result.regime).toBeUndefined();
  });

  it('still applies context-hash gate when evaluateRegime fails', async () => {
    const evaluateRegime = vi.fn().mockRejectedValue(new Error('timeout'));
    const first = await shouldSkipTick(
      { tickNumber: 1, hasOpenPositions: false, positionSide: 'flat', latestPrice: 100, portfolioPnlUsd: 0 },
      { evaluateRegime },
    );

    const second = await shouldSkipTick(
      {
        tickNumber: 2,
        hasOpenPositions: false,
        positionSide: 'flat',
        latestPrice: 100,
        portfolioPnlUsd: 0,
        previousContextHash: first.contextHash,
      },
      { evaluateRegime },
    );

    expect(second.skip).toBe(true);
    expect(second.gate).toBe('context_hash');
    expect(second.degraded).toBe(true);
    expect(second.degradationReason).toBe('regime_unavailable');
  });
});

describe('trading-hours helpers', () => {
  it('allows all hours when the list is empty', () => {
    expect(isWithinTradingHours(new Date('2026-06-08T12:00:00.000Z'), { allowedHoursUtc: [], weekendPause: false })).toBe(true);
  });

  it('applies weekend pause until sunday noon UTC', () => {
    expect(isWithinTradingHours(new Date('2026-06-07T11:00:00.000Z'), { allowedHoursUtc: [], weekendPause: true })).toBe(false);
    expect(isWithinTradingHours(new Date('2026-06-07T12:00:00.000Z'), { allowedHoursUtc: [], weekendPause: true })).toBe(true);
  });
});

describe('adaptive interval helpers', () => {
  const lowVolCandles = Array.from({ length: 14 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 8, index)).toISOString(),
    open: 100,
    high: 100.05,
    low: 99.95,
    close: 100,
    volume: 1_000,
  }));

  const highVolCandles = Array.from({ length: 14 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 8, index)).toISOString(),
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1_000,
  }));

  it('calculates ATR as a percent of the last close', () => {
    expect(calculateAtrPercent(lowVolCandles)).toBeLessThan(0.3);
    expect(calculateAtrPercent(highVolCandles)).toBeGreaterThan(0.3);
  });

  it('doubles the interval in low-volatility conditions', () => {
    const result = resolveAdaptiveIntervalMs({
      candles: lowVolCandles,
      baseTickIntervalMs: 60_000,
      currentTickIntervalMs: 60_000,
    });

    expect(result.nextTickIntervalMs).toBe(120_000);
  });

  it('halves the interval in higher-volatility conditions without going below base', () => {
    const result = resolveAdaptiveIntervalMs({
      candles: highVolCandles,
      baseTickIntervalMs: 60_000,
      currentTickIntervalMs: 240_000,
    });

    expect(result.nextTickIntervalMs).toBe(120_000);
  });

  it('treats an explicit base cadence as the floor while still allowing slowdown and recovery', () => {
    const slowed = resolveAdaptiveIntervalMs({
      candles: lowVolCandles,
      baseTickIntervalMs: 600_000,
      currentTickIntervalMs: 600_000,
    });

    expect(slowed.nextTickIntervalMs).toBe(1_200_000);

    const recovered = resolveAdaptiveIntervalMs({
      candles: highVolCandles,
      baseTickIntervalMs: 600_000,
      currentTickIntervalMs: slowed.nextTickIntervalMs,
    });

    expect(recovered.nextTickIntervalMs).toBe(600_000);
  });
});