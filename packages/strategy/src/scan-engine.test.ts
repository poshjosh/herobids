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

describe('VWAP scoring', () => {
  /**
   * Creates candles with a price spike at the end, so last close > VWAP of the last 24 bars.
   * Base: 29 candles alternating +1/−1 around 100 (RSI ≈ 50).
   * Spike: last candle at 130 ensures close > VWAP.
   */
  function makeVwapAboveCandles(): PriceCandle[] {
    const closes = Array.from({ length: 29 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    closes.push(130);
    return makeCandles(closes);
  }

  /**
   * Creates candles with the last close below VWAP of the last 24 bars.
   * Base: 29 candles alternating +1/−1 around 100 (RSI ≈ 50).
   * Final bar at 99 — a 1‑point loss that keeps RSI healthy while falling below the VWAP
   * average (~100.4), since the window is dominated by values at 100–101.
   */
  function makeVwapBelowCandles(): PriceCandle[] {
    const closes = Array.from({ length: 29 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    closes.push(99);
    return makeCandles(closes);
  }

  it('price above VWAP adds confidence to both sides and sets indicator', () => {
    const vwapWeight = 0.15;
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        vwap: { enabled: true, period: 24 },
        confidence: {
          rsiWeight: 0.15,
          vwapWeight,
          minConfidence: 0.10,
          minReasons: 1,
        },
      },
    };

    const result = scoreCandidate(candidate(makeVwapAboveCandles()), config);
    expect(result).not.toBeNull();

    // VWAP above → priceAboveVwap = true in indicators
    expect(result!.indicators.priceAboveVwap).toBe(true);

    // VWAP reason present in the winning reasons
    expect(result!.reasons).toContain('Price above VWAP');

    // Winning confidence = RSI (0.15) + VWAP (0.15) = 0.30
    expect(result!.confidence).toBeCloseTo(0.30);
  });

  it('price below VWAP provides no boost', () => {
    const vwapWeight = 0.15;
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        vwap: { enabled: true, period: 24 },
        confidence: {
          rsiWeight: 0.15,
          vwapWeight,
          minConfidence: 0.10,
          minReasons: 1,
        },
      },
    };

    const result = scoreCandidate(candidate(makeVwapBelowCandles()), config);
    expect(result).not.toBeNull();

    // priceAboveVwap = false when below
    expect(result!.indicators.priceAboveVwap).toBe(false);

    // No VWAP reason
    expect(result!.reasons).not.toContain('Price above VWAP');

    // Confidence = RSI only (0.15), no VWAP boost
    expect(result!.confidence).toBeCloseTo(0.15);
  });

  it('VWAP disabled → no effect even when weight > 0', () => {
    const vwapWeight = 0.15;
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        vwap: { enabled: false, period: 24 },
        confidence: {
          rsiWeight: 0.15,
          vwapWeight,
          minConfidence: 0.10,
          minReasons: 1,
        },
      },
    };

    // Use above-VWAP candles — but VWAP is disabled
    const result = scoreCandidate(candidate(makeVwapAboveCandles()), config);
    expect(result).not.toBeNull();

    // priceAboveVwap should be undefined (never set)
    expect(result!.indicators.priceAboveVwap).toBeUndefined();

    // No VWAP reason
    expect(result!.reasons).not.toContain('Price above VWAP');

    // Confidence = RSI only (0.15)
    expect(result!.confidence).toBeCloseTo(0.15);
  });
});

describe('Price action scoring', () => {
  const rsiAndPriceActionIndicators: ScanConfig['indicators'] = {
    ...noIndicators,
    rsi: { enabled: true },
    priceAction: { enabled: true, minChange24hPct: 3, maxChange24hPct: 50 },
    confidence: {
      rsiWeight: 0.15,
      priceActionWeight: 0.10,
      minConfidence: 0.10,
      minReasons: 1,
    },
  };

  it('price change in range (3–50%) adds bullish confidence', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: rsiAndPriceActionIndicators,
    };

    const ctx: CandidateContext = {
      ...candidate(makeFlatRsiCandles(30)),
      meta: { priceChange24hPct: 5 },
    };

    const result = scoreCandidate(ctx, config);
    expect(result).not.toBeNull();

    // Confidence = RSI (0.15) + price action (0.10) = 0.25
    expect(result!.confidence).toBeCloseTo(0.25);

    // Price action reason present
    expect(result!.reasons).toContain('+5.0% in 24h');
  });

  it('price change below min range (1%) → no boost', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: rsiAndPriceActionIndicators,
    };

    const ctx: CandidateContext = {
      ...candidate(makeFlatRsiCandles(30)),
      meta: { priceChange24hPct: 1 },
    };

    const result = scoreCandidate(ctx, config);
    expect(result).not.toBeNull();

    // Confidence = RSI only (0.15), no price action boost
    expect(result!.confidence).toBeCloseTo(0.15);

    // No price action reason
    const priceActionReasons = result!.reasons.filter((r) => r.includes('% in 24h'));
    expect(priceActionReasons).toHaveLength(0);
  });

  it('price change above max range (60%) → no boost', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: rsiAndPriceActionIndicators,
    };

    const ctx: CandidateContext = {
      ...candidate(makeFlatRsiCandles(30)),
      meta: { priceChange24hPct: 60 },
    };

    const result = scoreCandidate(ctx, config);
    expect(result).not.toBeNull();

    // Confidence = RSI only (0.15), no price action boost
    expect(result!.confidence).toBeCloseTo(0.15);

    // No price action reason
    const priceActionReasons = result!.reasons.filter((r) => r.includes('% in 24h'));
    expect(priceActionReasons).toHaveLength(0);
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

  it('produces bearish signal when bearish confidence exceeds bullish', () => {
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        confidence: { minConfidence: 0.10, minReasons: 1 },
      },
    };
    // candlesA produces a bullish signal (RSI ~50, trend-following)
    // candlesB is overbought → now produces a bearish signal instead of hard reject
    const candlesA = makeFlatRsiCandles(30);
    const candlesB = makeOverboughtCandles(30);

    const results = scanCandidates(
      [candidate(candlesA, 'VALID'), candidate(candlesB, 'OVERBOUGHT')],
      config,
    );
    expect(results.length).toBe(2);
    // Equal confidence + equal reasons.length → alphabetical by instrumentId.
    // ins-OVERBOUGHT < ins-VALID, so bearish sorts first.
    expect(results[0]!.symbol).toBe('OVERBOUGHT');
    expect(results[0]!.intent).toBe('go_short');
    expect(results[1]!.symbol).toBe('VALID');
    expect(results[1]!.intent).toBe('go_long');
  });

  it('ranks by reasons.length when confidence is equal (more confirming signals wins the tie)', () => {
    // Use volumeWeight=0 so strong volume adds a reason without changing confidence.
    // Both candidates get RSI healthy (same confidence), but one also has strong volume.
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        volume: { enabled: true, strongRatio: 1.5, recentBars: 4, avgBars: 20 },
        confidence: { rsiWeight: 0.15, volumeWeight: 0, minConfidence: 0.10, minReasons: 1 },
      },
    };

    // Fewer reasons: flat RSI candles, no strong volume
    const fewerReasons = makeFlatRsiCandles(30, 1_000);
    // More reasons: alternating + strong volume → RSI healthy + Strong volume
    const moreReasons = makeStrongVolumeCandles();

    const results = scanCandidates(
      [candidate(moreReasons, 'MORE'), candidate(fewerReasons, 'FEWER')],
      config,
    );

    expect(results.length).toBe(2);
    expect(results[0]!.symbol).toBe('MORE');
    expect(results[1]!.symbol).toBe('FEWER');
    expect(results[0]!.confidence).toBe(results[1]!.confidence);
    expect(results[0]!.reasons.length).toBeGreaterThan(results[1]!.reasons.length);
  });

  it('ranks alphabetically by instrumentId when confidence and reasons.length are both equal', () => {
    // Two identical-physical candidates → same confidence AND same reasons.length.
    // instrumentId differs → alphabetical order decides.
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        confidence: { minConfidence: 0.10, minReasons: 1 },
      },
    };

    const candles = makeFlatRsiCandles(30);
    const ctxA: CandidateContext = { symbol: 'AAA', instrumentId: 'ins-AAA', candles };
    const ctxB: CandidateContext = { symbol: 'BBB', instrumentId: 'ins-BBB', candles };

    const results = scanCandidates([ctxB, ctxA], config);

    expect(results.length).toBe(2);
    expect(results[0]!.instrumentId).toBe('ins-AAA');
    expect(results[1]!.instrumentId).toBe('ins-BBB');
    expect(results[0]!.confidence).toBe(results[1]!.confidence);
    expect(results[0]!.reasons.length).toBe(results[1]!.reasons.length);
  });

  it('produces stable top-N ordering regardless of input shuffle', () => {
    // Three candidates: A has highest confidence, B & C tied but B has more reasons.
    // Confidences: A > B = C. Among B & C, B has more reasons.
    const config: ScanConfig = {
      signalBias: 'trend-following',
      indicators: {
        ...noIndicators,
        rsi: { enabled: true },
        volume: { enabled: true, strongRatio: 1.5, recentBars: 4, avgBars: 20 },
        confidence: { rsiWeight: 0.15, volumeWeight: 0, minConfidence: 0.10, minReasons: 1 },
      },
    };

    // Candidate A: flat RSI candles on BTC (uses makeOverboughtCandles with different config to get a different confidence)
    // Actually, let's use different indicator configs to get distinct confidences.
    // Simpler: use the same base candle but toggle volume on/off to control reasons.
    // A: overbought → bearish, confidence = rsiWeight (0.15), 1 reason
    // B: healthy + strong volume → bullish, confidence = rsiWeight (0.15), 2 reasons
    // C: healthy, no strong volume → bullish, confidence = rsiWeight (0.15), 1 reason

    const ctxA: CandidateContext = {
      symbol: 'C', instrumentId: 'ins-C', candles: makeOverboughtCandles(30),
    };
    const ctxB: CandidateContext = {
      symbol: 'B', instrumentId: 'ins-B', candles: makeStrongVolumeCandles(),
    };
    const ctxC: CandidateContext = {
      symbol: 'A', instrumentId: 'ins-A', candles: makeFlatRsiCandles(30),
    };

    // Deterministic reference order from sorted input
    const reference = scanCandidates([ctxA, ctxB, ctxC], config);
    const referenceIds = reference.map((s) => s.instrumentId);

    // Shuffle 5 times and verify consistent results
    const shuffledOrders: CandidateContext[][] = [
      [ctxC, ctxA, ctxB],
      [ctxB, ctxC, ctxA],
      [ctxC, ctxB, ctxA],
      [ctxA, ctxC, ctxB],
      [ctxB, ctxA, ctxC],
    ];

    for (const order of shuffledOrders) {
      const results = scanCandidates(order, config);
      const ids = results.map((s) => s.instrumentId);
      expect(ids).toEqual(referenceIds);
    }

    // Also verify top-2 with maxResults is stable
    const cappedConfig: ScanConfig = { ...config, maxResults: 2 };
    const cappedReference = scanCandidates([ctxA, ctxB, ctxC], cappedConfig);
    const cappedRefIds = cappedReference.map((s) => s.instrumentId);

    for (const order of shuffledOrders) {
      const results = scanCandidates(order, cappedConfig);
      expect(results.map((s) => s.instrumentId)).toEqual(cappedRefIds);
    }
  });
});
