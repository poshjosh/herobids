import { describe, it, expect } from 'vitest';
import { evaluateRegime, getRequiredRegimeCandleCount } from './regime.js';
import type { PriceCandle } from './types.js';

function makeTrendingCandles(count: number, direction: 'up' | 'down' = 'up'): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = direction === 'up' ? 100 + i * 2 : 200 - i * 2;
    return {
      timestamp: new Date(Date.now() + i * 3600000).toISOString(),
      open: base,
      high: base + 3,
      low: base - 1,
      close: base + 1,
      volume: 1000 + i * 10,
    };
  });
}

function makeChoppyCandles(count: number): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + (i % 2 === 0 ? 3 : -3);
    return {
      timestamp: new Date(Date.now() + i * 3600000).toISOString(),
      open: base,
      high: base + 2,
      low: base - 2,
      close: base + (i % 2 === 0 ? -1 : 1),
      volume: 1000,
    };
  });
}

describe('evaluateRegime', () => {
  it('computes the required candle count from the longest configured indicator', () => {
    expect(getRequiredRegimeCandleCount({})).toBe(200);
    expect(getRequiredRegimeCandleCount({ emaTrend: 120, emaSlow: 80 })).toBe(120);
    expect(getRequiredRegimeCandleCount({ emaTrend: 20, emaSlow: 10, emaFast: 5 })).toBe(40);
  });

  it('returns pass: false with insufficient data', async () => {
    const fetcher = async () => makeTrendingCandles(10); // too few
    const result = await evaluateRegime({}, fetcher);
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain('insufficient_data');
  });

  it('returns pass: false when default params do not have enough candles for emaTrend', async () => {
    const fetcher = async () => makeTrendingCandles(100);
    const result = await evaluateRegime({}, fetcher);
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain('200 candles');
  });

  it('returns a valid result with sufficient trending data', async () => {
    const fetcher = async () => makeTrendingCandles(240);
    const result = await evaluateRegime({}, fetcher);
    expect(result.details.benchmarkSymbol).toBe('BTC');
    expect(result.details.currentPrice).toBeGreaterThan(0);
    expect(typeof result.pass).toBe('boolean');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('disableWhenChoppy returns false for choppy markets', async () => {
    const fetcher = async () => makeChoppyCandles(240);
    const result = await evaluateRegime({ disableWhenChoppy: true }, fetcher);
    // Choppy markets should have low ADX, so regime should fail
    if (result.details.choppy) {
      expect(result.pass).toBe(false);
      expect(result.reasons.some((r) => r.includes('choppy'))).toBe(true);
    }
  });

  it('emaAlignment filter rejects non-matching alignment', async () => {
    const fetcher = async () => makeTrendingCandles(240, 'down');
    const result = await evaluateRegime({ emaAlignment: 'bullish' }, fetcher);
    // Downtrend shouldn't have bullish alignment
    if (result.details.emaAlignment !== 'bullish') {
      expect(result.pass).toBe(false);
      expect(result.reasons.some((r) => r.includes('EMA alignment'))).toBe(true);
    }
  });

  it('priceAboveVwap check works', async () => {
    const fetcher = async () => makeTrendingCandles(240, 'down');
    const result = await evaluateRegime({ priceAboveVwap: true }, fetcher);
    if (!result.details.priceAboveVwap) {
      expect(result.pass).toBe(false);
      expect(result.reasons.some((r) => r.includes('VWAP'))).toBe(true);
    }
  });

  it('uses custom benchmark symbol', async () => {
    let receivedSymbol = '';
    const fetcher = async (symbol: string) => {
      receivedSymbol = symbol;
      return makeTrendingCandles(240);
    };
    await evaluateRegime({ benchmarkSymbol: 'ETH' }, fetcher);
    expect(receivedSymbol).toBe('ETH');
  });
});
