import { describe, it, expect } from 'vitest';
import { ema, adx, vwap, detectMarketStructure } from './indicators.js';
import type { PriceCandle } from './types.js';

function makeCandle(close: number, high?: number, low?: number, volume = 100): PriceCandle {
  return {
    timestamp: new Date().toISOString(),
    open: close,
    high: high ?? close * 1.01,
    low: low ?? close * 0.99,
    close,
    volume,
  };
}

function makeCandles(closes: number[]): PriceCandle[] {
  return closes.map((c) => makeCandle(c));
}

describe('ema', () => {
  it('returns empty array for empty input', () => {
    expect(ema([], 10)).toEqual([]);
  });

  it('returns empty when period exceeds data length', () => {
    expect(ema(makeCandles([1, 2, 3]), 5)).toEqual([]);
  });

  it('SMA seed for first period values', () => {
    const candles = makeCandles([2, 4, 6, 8, 10]);
    const result = ema(candles, 3);
    // SMA(3) of first 3 = (2+4+6)/3 = 4
    expect(result[2]).toBeCloseTo(4, 5);
  });

  it('subsequent values use EMA formula', () => {
    const candles = makeCandles([2, 4, 6, 8, 10]);
    const result = ema(candles, 3);
    const k = 2 / (3 + 1); // 0.5
    // EMA[3] = 8 * 0.5 + 4 * 0.5 = 6
    expect(result[3]).toBeCloseTo(6, 5);
    // EMA[4] = 10 * 0.5 + 6 * 0.5 = 8
    expect(result[4]).toBeCloseTo(8, 5);
  });

  it('returns array of same length as input', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = ema(candles, 5);
    expect(result).toHaveLength(10);
  });
});

describe('adx', () => {
  it('returns NaN for insufficient data', () => {
    const candles = makeCandles(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(adx(candles, 14)).toBeNaN();
  });

  it('returns a finite number for sufficient trending data', () => {
    // 50 candles with a clear uptrend
    const candles: PriceCandle[] = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date(Date.now() + i * 3600000).toISOString(),
      open: 100 + i * 2,
      high: 102 + i * 2,
      low: 99 + i * 2,
      close: 101 + i * 2,
      volume: 1000,
    }));
    const result = adx(candles);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it('returns higher ADX for trending vs choppy markets', () => {
    // Strong trend
    const trending: PriceCandle[] = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date(Date.now() + i * 3600000).toISOString(),
      open: 100 + i * 3,
      high: 104 + i * 3,
      low: 99 + i * 3,
      close: 103 + i * 3,
      volume: 1000,
    }));

    // Choppy (alternating)
    const choppy: PriceCandle[] = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date(Date.now() + i * 3600000).toISOString(),
      open: 100 + (i % 2 === 0 ? 2 : -2),
      high: 104 + (i % 2 === 0 ? 2 : -2),
      low: 98 + (i % 2 === 0 ? 2 : -2),
      close: 100 + (i % 2 === 0 ? -2 : 2),
      volume: 1000,
    }));

    expect(adx(trending)).toBeGreaterThan(adx(choppy));
  });
});

describe('vwap', () => {
  it('returns 0 for empty array', () => {
    expect(vwap([])).toBe(0);
  });

  it('returns typical price for single candle', () => {
    const candle: PriceCandle = {
      timestamp: new Date().toISOString(),
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
    };
    // typical = (110 + 90 + 105) / 3 = 101.666...
    expect(vwap([candle])).toBeCloseTo(101.6667, 3);
  });

  it('weights by volume correctly', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { timestamp: '', open: 200, high: 200, low: 200, close: 200, volume: 3000 },
    ];
    // TP1 = 100, TP2 = 200
    // VWAP = (100*1000 + 200*3000) / (1000+3000) = 700000/4000 = 175
    expect(vwap(candles)).toBeCloseTo(175, 5);
  });
});

describe('detectMarketStructure', () => {
  it('returns mixed for less than 5 candles', () => {
    expect(detectMarketStructure(makeCandles([1, 2, 3, 4]))).toBe('mixed');
  });

  it('detects higherHighs in uptrend', () => {
    // Create candles with clear ascending swing highs
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 100, low: 98, close: 99, volume: 100 },
      { timestamp: '', open: 99, high: 99, low: 97, close: 98, volume: 100 },
      { timestamp: '', open: 98, high: 105, low: 98, close: 104, volume: 100 }, // swing high
      { timestamp: '', open: 104, high: 103, low: 100, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 101, low: 99, close: 100, volume: 100 },
      { timestamp: '', open: 100, high: 100, low: 98, close: 99, volume: 100 },
      { timestamp: '', open: 99, high: 99, low: 97, close: 98, volume: 100 },
      { timestamp: '', open: 98, high: 110, low: 98, close: 109, volume: 100 }, // higher swing high
      { timestamp: '', open: 109, high: 108, low: 105, close: 106, volume: 100 },
      { timestamp: '', open: 106, high: 106, low: 104, close: 105, volume: 100 },
    ];
    expect(detectMarketStructure(candles)).toBe('higherHighs');
  });

  it('detects lowerHighs in downtrend', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 110, high: 112, low: 108, close: 109, volume: 100 },
      { timestamp: '', open: 109, high: 109, low: 107, close: 108, volume: 100 },
      { timestamp: '', open: 108, high: 115, low: 108, close: 114, volume: 100 }, // swing high
      { timestamp: '', open: 114, high: 113, low: 106, close: 107, volume: 100 },
      { timestamp: '', open: 107, high: 107, low: 104, close: 105, volume: 100 },
      { timestamp: '', open: 105, high: 105, low: 103, close: 104, volume: 100 },
      { timestamp: '', open: 104, high: 104, low: 102, close: 103, volume: 100 },
      { timestamp: '', open: 103, high: 110, low: 103, close: 109, volume: 100 }, // lower swing high
      { timestamp: '', open: 109, high: 108, low: 100, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 101, low: 98, close: 99, volume: 100 },
    ];
    expect(detectMarketStructure(candles)).toBe('lowerHighs');
  });
});
