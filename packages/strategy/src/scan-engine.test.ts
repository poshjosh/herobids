import { describe, it, expect } from 'vitest';
import type { PriceCandle } from '@herobids/market-data';
import { scoreCandidate, scanCandidates } from './scan-engine.js';
import type { CandidateContext, ScanConfig } from './scan-engine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandles(closes: number[], volumes?: number[]): PriceCandle[] {
  return closes.map((c, i) => ({
    timestamp: new Date(i * 60_000).toISOString(),
    open: c,
    high: c,
    low: c,
    close: c,
    volume: volumes?.[i] ?? 1_000,
  }));
}

/** ~RSI 50 — alternating +1/−1 from 100 for n bars */
function makeFlatRsiCandles(n = 30, baseVolume = 1_000): PriceCandle[] {
  const closes = [100];
  for (let i = 1; i < n; i++) {
    closes.push(closes[i - 1]! + (i % 2 === 0 ? -1 : 1));
  }
  return makeCandles(closes, Array(n).fill(baseVolume));
}

/** RSI → ~0 (overbought from the sell side) — all declining by 1 each bar */
function makeOversoldCandles(n = 30): PriceCandle[] {
  return makeCandles(Array.from({ length: n }, (_, i) => 100 - i));
}

/** RSI → ~100 (all gains) */
function makeOverboughtCandles(n = 30): PriceCandle[] {
  return makeCandles(Array.from({ length: n }, (_, i) => 100 + i));
}

/**
 * Zigzag candles with swingLookback=1 that produce a bearish structure, then
 * one final bar that closes above the last swing high — triggering a bullish CHOCH.
 *
 * Pattern (close):
 *  idx:  0    1    2    3    4    5    6    7    8    9   10   11
 *  val: 100  110   90  105   80  100   70   95   60   88   50  120
 *
 * Swing highs (lb=1): 110(1) > 105(3) > 100(5) > 95(7) > 88(9) → lower highs ✓
 * Swing lows  (lb=1):  90(2) >  80(4) >  70(6) > 60(8) > 50(10) → lower lows ✓
 * Structure: bearish ✓
 * Bar 11 (120) > last swing high 88 → bullish CHOCH ✓
 */
function makeChochBullishCandles(): PriceCandle[] {
  return makeCandles([100, 110, 90, 105, 80, 100, 70, 95, 60, 88, 50, 120]);
}

/**
 * Zigzag candles with swingLookback=1 that produce a bullish structure, then
 * one final bar that closes below the last swing low — triggering a bearish CHOCH.
 *
 * Pattern (close):
 *  idx:  0    1    2    3    4    5    6    7    8    9   10
 *  val: 100   90  110   95  120  100  130  110  140  120   70
 *
 * Swing highs (lb=1): 110(2) < 120(4) < 130(6) < 140(8) → higher highs ✓
 * Swing lows  (lb=1):  90(1) <  95(3) < 100(5) < 110(7) → higher lows ✓
 * Structure: bullish ✓
 * Bar 10 (70) < last swing low 110 → bearish CHOCH ✓
 */
function makeChochBearishCandles(): PriceCandle[] {
  return makeCandles([100, 90, 110, 95, 120, 100, 130, 110, 140, 120, 70]);
}

/**
 * Candle sequence that produces a MACD histogram crossover to positive on the last bar.
 * - 30 flat bars at 100 → EMAs converge, MACD ≈ 0
 * - 8 bars at 70 → MACD goes negative (fast EMA drops faster than slow EMA)
 * - 1 bar at 120 → fast EMA rises sharply; histogram crosses from negative to positive
 */
function makeMacdCrossoverCandles(): PriceCandle[] {
  const closes: number[] = [
    ...Array(30).fill(100), // flat → neutral MACD
    ...Array(8).fill(70),   // decline → MACD histogram negative
    120,                     // sharp rally → histogram crosses positive
  ];
  return makeCandles(closes);
}

/**
 * Flat prices with strong recent volume — last 4 bars at 3× the historical average.
 */
function makeStrongVolumeCandles(): PriceCandle[] {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
  const volumes = [...Array(26).fill(1_000), ...Array(4).fill(3_000)];
  return makeCandles(closes, volumes);
}

function candidate(candles: PriceCandle[], symbol = 'BTC'): CandidateContext {
  return { symbol, instrumentId: `ins-${symbol}`, candles };
}

// ─── Shared configs ───────────────────────────────────────────────────────────

/** All indicators disabled — used as a base to enable one at a time */
const noIndicators: ScanConfig['indicators'] = {
  rsi: { enabled: false },
  macd: { enabled: false },
  volume: { enabled: false },
  supportResistance: { enabled: false },
  choch: { enabled: false },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('scoreCandidate', () => {
  it('returns null when confidence is below minConfidence threshold', () => {
    // Flat prices → no indicator fires → confidence = 0 < 0.45 default
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        rsi: { enabled: true },
        macd: { enabled: false },
        volume: { enabled: false },
        supportResistance: { enabled: false },
        choch: { enabled: false },
      },
    };
    // All-same close prices → RSI = NaN (no gains or losses) → no RSI signal
    const result = scoreCandidate(candidate(makeCandles(Array(30).fill(100))), config);
    expect(result).toBeNull();
  });

  it('returns null on hard rejection when RSI exceeds overbought threshold', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: { rsi: { enabled: true }, macd: { enabled: false }, volume: { enabled: false } },
    };
    // All rising prices → RSI approaches 100 (well above overbought=80)
    const result = scoreCandidate(candidate(makeOverboughtCandles(30)), config);
    expect(result).toBeNull();
  });

  it('returns a ScoredSignal when RSI is in healthy range with sufficient confidence', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        volume: {
          enabled: true,
          strongRatio: 1.5,
          recentBars: 4,
          avgBars: 20,
        },
        confidence: { minConfidence: 0.25, minReasons: 2 },
      },
    };
    // RSI ~50 (alternating) + strong recent volume
    const volumes = [...Array(16).fill(1_000), ...Array(4).fill(3_000)];
    const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    const result = scoreCandidate(candidate(makeCandles(closes, volumes)), config);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('go_long');
    expect(result!.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('confidence weights are applied correctly (RSI-only baseline)', () => {
    const rsiWeight = 0.15;
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true, period: 14 },
        confidence: { rsiWeight, minConfidence: 0.10, minReasons: 1 },
      },
    };
    // RSI ~50 → rsiWeight contributes, nothing else
    const result = scoreCandidate(candidate(makeFlatRsiCandles(30)), config);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(rsiWeight);
    expect(result!.reasons).toEqual(['RSI in healthy range']);
  });

  it('trend-following bias: RSI in healthy range scores; oversold does not', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        confidence: { minConfidence: 0.10, minReasons: 1 },
      },
    };
    // RSI ~50 → trend-following should score
    const healthy = scoreCandidate(candidate(makeFlatRsiCandles(30)), config);
    expect(healthy).not.toBeNull();
    expect(healthy!.reasons).toContain('RSI in healthy range');

    // RSI ~0 → oversold; trend-following should NOT score (returns null)
    const oversold = scoreCandidate(candidate(makeOversoldCandles(30)), config);
    expect(oversold).toBeNull();
  });

  it('mean-reverting bias: RSI oversold scores; healthy range does not', () => {
    const config: ScanConfig = {
      signalBias: 'mean-reverting',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        confidence: { minConfidence: 0.10, minReasons: 1 },
      },
    };
    // RSI ~0 → oversold; mean-reverting should score
    const oversold = scoreCandidate(candidate(makeOversoldCandles(30)), config);
    expect(oversold).not.toBeNull();
    expect(oversold!.reasons).toContain('RSI oversold');

    // RSI ~50 → healthy range; mean-reverting should NOT score
    const healthy = scoreCandidate(candidate(makeFlatRsiCandles(30)), config);
    expect(healthy).toBeNull();
  });

  it('CHOCH: trend-following bullish CHOCH adds confidence; mean-reverting penalizes', () => {
    const chochOnlyBase: ScanConfig['indicators'] = {
      ...noIndicators,
      choch: {
        enabled: true,
        swingLookback: 1,
        minSwingPct: 0,
        minSwings: 4,
        confirmBars: 2,
        rejectOnBearish: false,
      },
      confidence: { chochBullishWeight: 0.15, chochBearishPenalty: 0.10, minConfidence: 0.05, minReasons: 1 },
    };

    const candles = makeChochBullishCandles();

    // trend-following: bullish CHOCH → +chochBullishWeight → signal returned
    const tfResult = scoreCandidate(candidate(candles), {
      signalBias: 'trend-following',
      indicators: chochOnlyBase,
    });
    expect(tfResult).not.toBeNull();
    expect(tfResult!.confidence).toBeCloseTo(0.15);
    expect(tfResult!.reasons).toContain('Bullish CHOCH');

    // mean-reverting: bullish CHOCH → penalty applied → confidence = 0 → null
    const mrResult = scoreCandidate(candidate(candles), {
      signalBias: 'mean-reverting',
      indicators: chochOnlyBase,
    });
    expect(mrResult).toBeNull();
  });

  it('returns null when candle data is insufficient (below MACD slow period)', () => {
    // Only 5 candles — not enough for RSI (period=14) or MACD (slow=26)
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        rsi: { enabled: true },
        macd: { enabled: true },
        volume: { enabled: false },
        supportResistance: { enabled: false },
        choch: { enabled: false },
      },
    };
    const result = scoreCandidate(candidate(makeCandles([100, 101, 102, 103, 104])), config);
    // No crash, no signal — RSI insufficient, MACD insufficient
    expect(result).toBeNull();
  });

  it('mean-reverting + bearish CHOCH = capitulation reversal entry', () => {
    const config: ScanConfig = {
      signalBias: 'mean-reverting',
      indicators: {
        ...noIndicators,
        choch: {
          enabled: true,
          swingLookback: 1,
          minSwingPct: 0,
          minSwings: 4,
          confirmBars: 2,
          rejectOnBearish: false,
        },
        confidence: { chochBullishWeight: 0.15, minConfidence: 0.05, minReasons: 1 },
      },
    };
    const result = scoreCandidate(candidate(makeChochBearishCandles()), config);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.15);
    expect(result!.reasons).toContain('Bearish CHOCH (reversal)');
    expect(result!.intent).toBe('go_long');
  });

  it('MACD-only: bullish crossover scores macdCrossoverWeight + macdIncreasingWeight', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
        confidence: {
          macdCrossoverWeight: 0.20,
          macdIncreasingWeight: 0.10,
          minConfidence: 0.25,
          minReasons: 1,
        },
      },
    };
    const result = scoreCandidate(candidate(makeMacdCrossoverCandles()), config);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.30);
    expect(result!.reasons).toContain('MACD bullish crossover');
    expect(result!.reasons).toContain('MACD histogram increasing');
  });

  it('volume-only: strong recent volume scores volumeWeight', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        volume: { enabled: true, strongRatio: 1.5, recentBars: 4, avgBars: 20 },
        confidence: { volumeWeight: 0.15, minConfidence: 0.10, minReasons: 1 },
      },
    };
    const result = scoreCandidate(candidate(makeStrongVolumeCandles()), config);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.15);
    expect(result!.reasons).toContain('Strong volume');
  });
});

describe('scanCandidates', () => {
  it('returns an empty array for no candidates', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: noIndicators,
    };
    expect(scanCandidates([], config)).toEqual([]);
  });

  it('ranks results by confidence descending', () => {
    // Two candidates: one with RSI healthy + strong volume; one with RSI only
    const baseConfig: ScanConfig['indicators'] = {
      ...noIndicators,
      rsi: { enabled: true },
      volume: { enabled: true, strongRatio: 1.5, recentBars: 4, avgBars: 20 },
      confidence: { minConfidence: 0.05, minReasons: 1 },
    };

    // Candidate A: RSI healthy only (volume not strong enough)
    const candlesA = makeFlatRsiCandles(30, 1_000);

    // Candidate B: RSI healthy + strong volume
    const baseCloses = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    const strongVolumes = [...Array(26).fill(1_000), ...Array(4).fill(3_000)];
    const candlesB = makeCandles(baseCloses, strongVolumes);

    const results = scanCandidates(
      [candidate(candlesA, 'LOWER'), candidate(candlesB, 'HIGHER')],
      { signalBias: 'trend-following', indicators: baseConfig },
    );

    expect(results.length).toBe(2);
    expect(results[0]!.symbol).toBe('HIGHER');
    expect(results[1]!.symbol).toBe('LOWER');
    expect(results[0]!.confidence).toBeGreaterThan(results[1]!.confidence);
  });

  it('respects maxResults cap', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      maxResults: 2,
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        confidence: { minConfidence: 0.10, minReasons: 1 },
      },
    };
    const candles = makeFlatRsiCandles(30);
    const candidates = [
      candidate(candles, 'A'),
      candidate(candles, 'B'),
      candidate(candles, 'C'),
    ];
    const results = scanCandidates(candidates, config);
    expect(results.length).toBe(2);
  });

  it('filters out candidates that produce no signal', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        confidence: { minConfidence: 0.10, minReasons: 1 },
      },
    };
    // candlesA produces a signal (RSI ~50, trend-following)
    // candlesB is overbought → hard reject → null
    const candlesA = makeFlatRsiCandles(30);
    const candlesB = makeOverboughtCandles(30);

    const results = scanCandidates(
      [candidate(candlesA, 'VALID'), candidate(candlesB, 'REJECTED')],
      config,
    );
    expect(results.length).toBe(1);
    expect(results[0]!.symbol).toBe('VALID');
  });
});
