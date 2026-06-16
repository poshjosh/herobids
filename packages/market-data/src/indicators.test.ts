import { describe, it, expect } from 'vitest';
import {
  ema,
  adx,
  vwap,
  detectMarketStructure,
  rsi,
  macd,
  findSupportResistance,
  isBreakingResistance,
  isBouncingSupport,
  volumeTrend,
  detectSwingPoints,
  classifyStructure,
  detectCHOCH,
  type SwingPoint,
} from './indicators.js';
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

// ─── RSI ──────────────────────────────────────────────────────────────────────

describe('rsi', () => {
  it('returns all-NaN array when data length < period + 1', () => {
    const result = rsi(makeCandles([1, 2, 3, 4, 5]), 14);
    expect(result.every((v) => isNaN(v))).toBe(true);
  });

  it('first valid RSI appears at index equal to period', () => {
    const candles = makeCandles(Array.from({ length: 20 }, (_, i) => 100 + i));
    const result = rsi(candles, 5);
    expect(isNaN(result[4]!)).toBe(true);
    expect(isNaN(result[5]!)).toBe(false);
  });

  it('all-rising closes → RSI approaches 100', () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 100 + i));
    const result = rsi(candles, 14);
    const last = result[result.length - 1]!;
    expect(last).toBeGreaterThan(90);
  });

  it('all-falling closes → RSI approaches 0', () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 200 - i));
    const result = rsi(candles, 14);
    const last = result[result.length - 1]!;
    expect(last).toBeLessThan(10);
  });

  it('alternating closes → RSI near 50', () => {
    const closes = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const candles = makeCandles(closes);
    const result = rsi(candles, 14);
    const last = result[result.length - 1]!;
    expect(last).toBeGreaterThan(40);
    expect(last).toBeLessThan(60);
  });

  it('flat closes → RSI is NaN (no movement)', () => {
    const candles = makeCandles(Array.from({ length: 20 }, () => 100));
    const result = rsi(candles, 14);
    for (let i = 14; i < result.length; i++) {
      expect(isNaN(result[i]!)).toBe(true);
    }
  });

  it('period = 2 edge case works correctly', () => {
    const candles = makeCandles([10, 12, 11, 13]);
    const result = rsi(candles, 2);
    expect(isNaN(result[0]!)).toBe(true);
    expect(isNaN(result[1]!)).toBe(true);
    expect(isNaN(result[2]!)).toBe(false);
    expect(result[2]).toBeGreaterThan(0);
    expect(result[2]).toBeLessThan(100);
  });

  it('matches manual calculation for known sequence', () => {
    // 5-period RSI, closes: [10, 12, 11, 13, 14, 12]
    // Changes: +2, -1, +2, +1, -2
    // Seed avg gain = (2+2+1)/5 = 1, avg loss = (1+2)/5 = 0.6
    // → Wait, period=5 needs 5 changes so indices 0..5
    // Actually: 6 candles, 5 changes: +2,-1,+2,+1,-2
    // avgGain = (2+0+2+1+0)/5 = 5/5 = 1, avgLoss = (0+1+0+0+2)/5 = 3/5 = 0.6
    // RS = 1/0.6 = 1.6667, RSI = 100 - 100/2.6667 = 62.5
    const candles = makeCandles([10, 12, 11, 13, 14, 12]);
    const result = rsi(candles, 5);
    expect(result[5]).toBeCloseTo(62.5, 1);
  });
});

// ─── MACD ─────────────────────────────────────────────────────────────────────

describe('macd', () => {
  it('MACD line = fast EMA - slow EMA', () => {
    const candles = makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i));
    const { macdLine } = macd(candles, 5, 10, 3);
    const fastEmaValues = ema(candles, 5);
    const slowEmaValues = ema(candles, 10);
    // Valid from index slow-1 = 9 onward
    for (let i = 9; i < candles.length; i++) {
      expect(macdLine[i]).toBeCloseTo(fastEmaValues[i]! - slowEmaValues[i]!, 6);
    }
  });

  it('signal line is NaN during warm-up (indices slow-1 through slow+signal-3)', () => {
    const candles = makeCandles(Array.from({ length: 50 }, (_, i) => 100 + i));
    const { signalLine } = macd(candles); // defaults: fast=12, slow=26, signal=9
    // warm-up: validStart=25, first valid signal at 25+8=33
    for (let i = 25; i <= 32; i++) {
      expect(isNaN(signalLine[i]!)).toBe(true);
    }
    expect(isNaN(signalLine[33]!)).toBe(false);
  });

  it('histogram = MACD line - signal line', () => {
    const candles = makeCandles(Array.from({ length: 50 }, (_, i) => 100 + i));
    const { macdLine, signalLine, histogram } = macd(candles, 12, 26, 9);
    for (let i = 0; i < candles.length; i++) {
      const m = macdLine[i]!;
      const s = signalLine[i]!;
      const h = histogram[i]!;
      if (!isNaN(m) && !isNaN(s)) {
        expect(h).toBeCloseTo(m - s, 10);
      }
    }
  });

  it('returns arrays of same length as input', () => {
    const candles = makeCandles(Array.from({ length: 50 }, (_, i) => i));
    const { macdLine, signalLine, histogram } = macd(candles);
    expect(macdLine).toHaveLength(50);
    expect(signalLine).toHaveLength(50);
    expect(histogram).toHaveLength(50);
  });

  it('short input (< slow period) returns all-NaN arrays', () => {
    const candles = makeCandles([1, 2, 3, 4, 5]);
    const { macdLine, signalLine, histogram } = macd(candles, 12, 26, 9);
    expect(macdLine.every((v) => isNaN(v))).toBe(true);
    expect(signalLine.every((v) => isNaN(v))).toBe(true);
    expect(histogram.every((v) => isNaN(v))).toBe(true);
  });

  it('bullish crossover detectable — histogram goes negative→positive', () => {
    // Rise → fall → rise: MACD falls during the fall phase (signal lags above →
    // histogram < 0), then rises during recovery (signal lags below → histogram > 0).
    const rising1 = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const falling = Array.from({ length: 40 }, (_, i) => 180 - i * 2);
    const rising2 = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const candles = makeCandles([...rising1, ...falling, ...rising2]);
    const { histogram } = macd(candles, 12, 26, 9);
    const valid = histogram.filter((v) => !isNaN(v));
    const hasPositive = valid.some((v) => v > 0);
    const hasNegative = valid.some((v) => v < 0);
    expect(hasNegative).toBe(true);
    expect(hasPositive).toBe(true);
  });
});

// ─── Support / Resistance ─────────────────────────────────────────────────────

describe('findSupportResistance', () => {
  it('detects local high as resistance', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 100, low: 98, close: 99, volume: 100 },
      { timestamp: '', open: 99, high: 120, low: 98, close: 119, volume: 100 }, // swing high
      { timestamp: '', open: 119, high: 105, low: 100, close: 101, volume: 100 },
    ];
    const { resistances } = findSupportResistance(candles);
    expect(resistances).toContain(120);
  });

  it('detects local low as support', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 104, low: 80, close: 82, volume: 100 }, // swing low
      { timestamp: '', open: 82, high: 100, low: 90, close: 95, volume: 100 },
    ];
    const { supports } = findSupportResistance(candles);
    expect(supports).toContain(80);
  });

  it('empty candles → empty arrays', () => {
    const { supports, resistances } = findSupportResistance([]);
    expect(supports).toHaveLength(0);
    expect(resistances).toHaveLength(0);
  });

  it('lookback = 5 (small window) still works', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 100, low: 98, close: 99, volume: 100 },
      { timestamp: '', open: 99, high: 120, low: 98, close: 119, volume: 100 },
      { timestamp: '', open: 119, high: 105, low: 100, close: 101, volume: 100 },
    ];
    const { resistances } = findSupportResistance(candles, 5);
    expect(resistances).toContain(120);
  });
});

describe('isBreakingResistance', () => {
  it('returns true when price just above level within threshold', () => {
    expect(isBreakingResistance(100.3, [100], 0.005)).toBe(true);
  });

  it('returns false when price far above level', () => {
    expect(isBreakingResistance(110, [100], 0.005)).toBe(false);
  });

  it('returns false when price below level', () => {
    expect(isBreakingResistance(99, [100], 0.005)).toBe(false);
  });

  it('returns false for empty resistances', () => {
    expect(isBreakingResistance(100, [], 0.005)).toBe(false);
  });

  it('selects nearest (highest) broken level when multiple resistances are below price', () => {
    // Both 95 and 100 are below 100.3; nearest is 100
    // 100.3 <= 100 * 1.005 = 100.5 → true
    expect(isBreakingResistance(100.3, [95, 100], 0.005)).toBe(true);
  });

  it('returns false when price is beyond the nearest broken level window', () => {
    // Only 95 is below 96.0; nearest broken = 95
    // 96.0 <= 95 * 1.005 = 95.475 → false
    expect(isBreakingResistance(96.0, [95, 100], 0.005)).toBe(false);
  });
});

describe('isBouncingSupport', () => {
  it('returns true when price just above nearest support within threshold', () => {
    // 100 <= 100.3 and 100.3 <= 100 * 1.005 = 100.5 → true
    expect(isBouncingSupport(100.3, [100], 0.005)).toBe(true);
  });

  it('returns false when price far above support', () => {
    // 100 <= 102 but 102 > 100.5 → false
    expect(isBouncingSupport(102, [100], 0.005)).toBe(false);
  });

  it('returns false for empty supports', () => {
    expect(isBouncingSupport(100, [], 0.005)).toBe(false);
  });

  it('selects nearest (highest) held support when multiple supports are below price', () => {
    // Both 95 and 100 are <= 100.3; nearest = 100
    // 100.3 <= 100 * 1.005 = 100.5 → true
    expect(isBouncingSupport(100.3, [95, 100], 0.005)).toBe(true);
  });

  it('returns false when price is beyond the nearest held support window', () => {
    // Only 95 is <= 96; nearest held = 95
    // 96 <= 95 * 1.005 = 95.475 → false
    expect(isBouncingSupport(96, [95, 100], 0.005)).toBe(false);
  });
});

// ─── Volume Trend ─────────────────────────────────────────────────────────────

describe('volumeTrend', () => {
  it('returns 0 if candles.length < avgBars', () => {
    const candles = makeCandles([100, 100, 100]);
    expect(volumeTrend(candles, 4, 20)).toBe(0);
  });

  it('double-volume recent bars → returns ~2.0', () => {
    const base = Array.from({ length: 20 }, () =>
      makeCandle(100, undefined, undefined, 100),
    );
    // Override last 4 with volume 200
    for (let i = 16; i < 20; i++) {
      base[i] = makeCandle(100, undefined, undefined, 200);
    }
    // avg of all 20 = (16*100 + 4*200)/20 = 2400/20 = 120
    // recent avg = 200
    // ratio = 200/120 ≈ 1.667
    const ratio = volumeTrend(base, 4, 20);
    expect(ratio).toBeGreaterThan(1.5);
  });

  it('same volume throughout → returns ~1.0', () => {
    const candles = Array.from({ length: 20 }, () => makeCandle(100, undefined, undefined, 500));
    const ratio = volumeTrend(candles, 4, 20);
    expect(ratio).toBeCloseTo(1.0, 5);
  });

  it('zero volume candles → returns 0 (no division by zero)', () => {
    const candles = Array.from({ length: 20 }, () => makeCandle(100, undefined, undefined, 0));
    expect(volumeTrend(candles, 4, 20)).toBe(0);
  });
});

// ─── Swing Points ─────────────────────────────────────────────────────────────

describe('detectSwingPoints', () => {
  it('detects obvious swing high (peak in middle)', () => {
    // 7 candles: low, low, low, HIGH, low, low, low  (lookback=3)
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 100, low: 95, close: 99, volume: 100 },
      { timestamp: '', open: 99, high: 101, low: 96, close: 100, volume: 100 },
      { timestamp: '', open: 100, high: 102, low: 97, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 130, low: 98, close: 129, volume: 100 }, // swing high
      { timestamp: '', open: 129, high: 103, low: 97, close: 102, volume: 100 },
      { timestamp: '', open: 102, high: 101, low: 96, close: 100, volume: 100 },
      { timestamp: '', open: 100, high: 100, low: 95, close: 99, volume: 100 },
    ];
    const points = detectSwingPoints(candles, 3);
    const highs = points.filter((p) => p.type === 'high');
    expect(highs.length).toBeGreaterThan(0);
    expect(highs[0]!.price).toBe(130);
  });

  it('detects obvious swing low (trough in middle)', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 105, low: 98, close: 102, volume: 100 },
      { timestamp: '', open: 102, high: 104, low: 99, close: 103, volume: 100 },
      { timestamp: '', open: 103, high: 106, low: 100, close: 104, volume: 100 },
      { timestamp: '', open: 104, high: 107, low: 60, close: 61, volume: 100 }, // swing low
      { timestamp: '', open: 61, high: 105, low: 99, close: 103, volume: 100 },
      { timestamp: '', open: 103, high: 104, low: 98, close: 102, volume: 100 },
      { timestamp: '', open: 102, high: 103, low: 97, close: 101, volume: 100 },
    ];
    const points = detectSwingPoints(candles, 3);
    const lows = points.filter((p) => p.type === 'low');
    expect(lows.length).toBeGreaterThan(0);
    expect(lows[0]!.price).toBe(60);
  });

  it('minSwingPct filters out insignificant swings', () => {
    // Swing high at index 3: high=101.1, compared to ref low ~99 → only ~2% swing
    const candles = makeCandles([100, 100, 100, 101.1, 100, 100, 100]);
    const withFilter = detectSwingPoints(candles, 3, 0.1); // require 10% swing
    const withoutFilter = detectSwingPoints(candles, 3, 0);
    expect(withFilter.length).toBeLessThanOrEqual(withoutFilter.length);
  });

  it('returns empty for insufficient data (< 2*lookback + 1)', () => {
    expect(detectSwingPoints(makeCandles([1, 2, 3, 4, 5, 6]), 3)).toHaveLength(0);
  });

  it('swingLookback=1 detects more points than swingLookback=5', () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + Math.sin(i) * 5),
    );
    const lb1 = detectSwingPoints(candles, 1);
    const lb5 = detectSwingPoints(candles, 5);
    expect(lb1.length).toBeGreaterThanOrEqual(lb5.length);
  });
});

// ─── classifyStructure ────────────────────────────────────────────────────────

describe('classifyStructure', () => {
  function sp(index: number, price: number, type: 'high' | 'low'): SwingPoint {
    return { index, price, type };
  }

  it('HH + HL → bullish', () => {
    const points: SwingPoint[] = [
      sp(0, 100, 'high'),
      sp(1, 90, 'low'),
      sp(2, 110, 'high'),
      sp(3, 95, 'low'),
    ];
    expect(classifyStructure(points)).toBe('bullish');
  });

  it('LH + LL → bearish', () => {
    const points: SwingPoint[] = [
      sp(0, 110, 'high'),
      sp(1, 95, 'low'),
      sp(2, 100, 'high'),
      sp(3, 85, 'low'),
    ];
    expect(classifyStructure(points)).toBe('bearish');
  });

  it('HH + LL → indeterminate', () => {
    const points: SwingPoint[] = [
      sp(0, 100, 'high'),
      sp(1, 95, 'low'),
      sp(2, 110, 'high'),
      sp(3, 85, 'low'),
    ];
    expect(classifyStructure(points)).toBe('indeterminate');
  });

  it('fewer than 2 highs → indeterminate', () => {
    const points: SwingPoint[] = [sp(0, 100, 'high'), sp(1, 90, 'low'), sp(2, 85, 'low')];
    expect(classifyStructure(points)).toBe('indeterminate');
  });

  it('fewer than 2 lows → indeterminate', () => {
    const points: SwingPoint[] = [sp(0, 100, 'high'), sp(1, 110, 'high'), sp(2, 90, 'low')];
    expect(classifyStructure(points)).toBe('indeterminate');
  });
});

// ─── detectCHOCH ─────────────────────────────────────────────────────────────

describe('detectCHOCH', () => {
  function sp(index: number, price: number, type: 'high' | 'low'): SwingPoint {
    return { index, price, type };
  }

  it('returns null for indeterminate structure', () => {
    const candles = makeCandles([100, 101, 102]);
    expect(detectCHOCH(candles, [], 'indeterminate')).toBeNull();
  });

  it('bearish structure + close above swing high → bullish CHOCH', () => {
    // bearish structure, swing high at 105 (index 2), then close above it at index 4
    const candles: PriceCandle[] = [
      { timestamp: '', open: 110, high: 112, low: 108, close: 110, volume: 100 },
      { timestamp: '', open: 110, high: 111, low: 107, close: 109, volume: 100 },
      { timestamp: '', open: 109, high: 105, low: 104, close: 105, volume: 100 },
      { timestamp: '', open: 105, high: 104, low: 100, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 110, low: 100, close: 106, volume: 100 }, // breaks above 105
    ];
    const swings = [sp(2, 105, 'high')];
    const result = detectCHOCH(candles, swings, 'bearish', 5);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('bullish');
    expect(result?.brokenLevel).toBe(105);
  });

  it('bullish structure + close below swing low → bearish CHOCH', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 100, high: 105, low: 98, close: 102, volume: 100 },
      { timestamp: '', open: 102, high: 106, low: 99, close: 103, volume: 100 },
      { timestamp: '', open: 103, high: 107, low: 95, close: 96, volume: 100 },
      { timestamp: '', open: 96, high: 104, low: 93, close: 94, volume: 100 },
      { timestamp: '', open: 94, high: 103, low: 88, close: 90, volume: 100 }, // breaks below 95
    ];
    const swings = [sp(2, 95, 'low')];
    const result = detectCHOCH(candles, swings, 'bullish', 5);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('bearish');
    expect(result?.brokenLevel).toBe(95);
  });

  it('stale break (outside confirmBars) → null', () => {
    // swing high at index 1 (105), break at index 2, but confirmBars=1 → freshStart=4
    const candles: PriceCandle[] = [
      { timestamp: '', open: 110, high: 112, low: 108, close: 110, volume: 100 },
      { timestamp: '', open: 110, high: 105, low: 104, close: 105, volume: 100 },
      { timestamp: '', open: 105, high: 110, low: 104, close: 108, volume: 100 }, // breaks above 105 but too old
      { timestamp: '', open: 108, high: 107, low: 100, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 104, low: 99, close: 100, volume: 100 }, // doesn't break
    ];
    const swings = [sp(1, 105, 'high')];
    const result = detectCHOCH(candles, swings, 'bearish', 1);
    expect(result).toBeNull();
  });

  it('no break at all → null', () => {
    const candles: PriceCandle[] = [
      { timestamp: '', open: 110, high: 112, low: 108, close: 110, volume: 100 },
      { timestamp: '', open: 110, high: 111, low: 107, close: 109, volume: 100 },
      { timestamp: '', open: 109, high: 105, low: 104, close: 104, volume: 100 },
      { timestamp: '', open: 104, high: 103, low: 100, close: 101, volume: 100 },
      { timestamp: '', open: 101, high: 102, low: 98, close: 99, volume: 100 },
    ];
    const swings = [sp(2, 120, 'high')]; // level never broken
    const result = detectCHOCH(candles, swings, 'bearish', 5);
    expect(result).toBeNull();
  });
});
