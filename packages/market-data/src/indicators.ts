import type { PriceCandle } from './types.js';

/**
 * Exponential Moving Average — returns array of EMA values aligned with input candles.
 * The first (period - 1) values use SMA as seed, then standard EMA recursion.
 */
export function ema(candles: PriceCandle[], period: number): number[] {
  if (candles.length === 0 || period < 1) return [];
  if (period > candles.length) return [];

  const result: number[] = new Array(candles.length);
  const k = 2 / (period + 1);

  // Seed: SMA of first `period` candles
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i]!.close;
    result[i] = 0; // placeholder — not meaningful until seed completes
  }
  result[period - 1] = sum / period;

  // EMA recursion
  for (let i = period; i < candles.length; i++) {
    result[i] = candles[i]!.close * k + result[i - 1]! * (1 - k);
  }

  return result;
}

/**
 * Average Directional Index — returns the last ADX value.
 * Requires at least (period * 2) candles for a stable reading.
 * Returns NaN if insufficient data.
 */
export function adx(candles: PriceCandle[], period = 14): number {
  if (candles.length < period * 2 + 1) return NaN;

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;

    const highDiff = curr.high - prev.high;
    const lowDiff = prev.low - curr.low;

    plusDMs.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDMs.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  // Wilder's smoothing for ATR, +DM, -DM
  let atr = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;

  for (let i = 0; i < period; i++) {
    atr += trueRanges[i]!;
    smoothPlusDM += plusDMs[i]!;
    smoothMinusDM += minusDMs[i]!;
  }

  atr /= period;
  smoothPlusDM /= period;
  smoothMinusDM /= period;

  const dxValues: number[] = [];

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
    smoothPlusDM = (smoothPlusDM * (period - 1) + plusDMs[i]!) / period;
    smoothMinusDM = (smoothMinusDM * (period - 1) + minusDMs[i]!) / period;

    const plusDI = atr > 0 ? (smoothPlusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (smoothMinusDM / atr) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return NaN;

  // First ADX is SMA of first `period` DX values
  let adxValue = 0;
  for (let i = 0; i < period; i++) {
    adxValue += dxValues[i]!;
  }
  adxValue /= period;

  // Smooth subsequent ADX values
  for (let i = period; i < dxValues.length; i++) {
    adxValue = (adxValue * (period - 1) + dxValues[i]!) / period;
  }

  return adxValue;
}

/**
 * Volume-Weighted Average Price over the candle set.
 * Uses typical price (H+L+C)/3 weighted by volume.
 */
export function vwap(candles: PriceCandle[]): number {
  if (candles.length === 0) return 0;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }

  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
}

/**
 * Detects market structure by looking at swing highs/lows.
 * Returns 'higherHighs' if the last two swing highs are ascending,
 * 'lowerHighs' if descending, or 'mixed' if unclear.
 */
export function detectMarketStructure(candles: PriceCandle[]): 'higherHighs' | 'lowerHighs' | 'mixed' {
  if (candles.length < 5) return 'mixed';

  // Find swing highs (local maxima with at least 2 bars on each side)
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const high = candles[i]!.high;
    if (
      high > candles[i - 1]!.high &&
      high > candles[i - 2]!.high &&
      high > candles[i + 1]!.high &&
      high > candles[i + 2]!.high
    ) {
      swingHighs.push(high);
    }

    const low = candles[i]!.low;
    if (
      low < candles[i - 1]!.low &&
      low < candles[i - 2]!.low &&
      low < candles[i + 1]!.low &&
      low < candles[i + 2]!.low
    ) {
      swingLows.push(low);
    }
  }

  if (swingHighs.length < 2) return 'mixed';

  const lastHigh = swingHighs[swingHighs.length - 1]!;
  const prevHigh = swingHighs[swingHighs.length - 2]!;

  if (lastHigh > prevHigh) {
    // Confirm with lows if available
    if (swingLows.length >= 2) {
      const lastLow = swingLows[swingLows.length - 1]!;
      const prevLow = swingLows[swingLows.length - 2]!;
      return lastLow >= prevLow ? 'higherHighs' : 'mixed';
    }
    return 'higherHighs';
  }

  if (lastHigh < prevHigh) {
    if (swingLows.length >= 2) {
      const lastLow = swingLows[swingLows.length - 1]!;
      const prevLow = swingLows[swingLows.length - 2]!;
      return lastLow <= prevLow ? 'lowerHighs' : 'mixed';
    }
    return 'lowerHighs';
  }

  return 'mixed';
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

/**
 * RSI using Wilder's smoothing method.
 * Returns array of RSI values aligned with input candles.
 * First `period` values are NaN (insufficient data).
 */
export function rsi(candles: PriceCandle[], period = 14): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed: average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;

  const toRsi = (g: number, l: number): number =>
    g === 0 && l === 0 ? NaN : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  result[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = toRsi(avgGain, avgLoss);
  }

  return result;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

/**
 * MACD with configurable fast/slow/signal periods.
 * Returns arrays aligned with input candles.
 */
export function macd(candles: PriceCandle[], fast = 12, slow = 26, signal = 9): MacdResult {
  const len = candles.length;
  const macdLine: number[] = new Array(len).fill(NaN);
  const signalLine: number[] = new Array(len).fill(NaN);
  const histogram: number[] = new Array(len).fill(NaN);

  if (len < slow) return { macdLine, signalLine, histogram };

  const fastEma = ema(candles, fast);
  const slowEma = ema(candles, slow);

  // MACD line is valid from index (slow - 1) onward
  for (let i = slow - 1; i < len; i++) {
    const f = fastEma[i];
    const s = slowEma[i];
    macdLine[i] = f !== undefined && s !== undefined ? f - s : NaN;
  }

  // Build pseudo-candles from macdLine values for signal EMA
  // Only use values from slow-1 onward where macdLine is valid
  const validStart = slow - 1;
  const macdCandles: PriceCandle[] = [];
  for (let i = validStart; i < len; i++) {
    const v = macdLine[i] ?? NaN;
    macdCandles.push({ timestamp: '', open: v, high: v, low: v, close: v, volume: 0 });
  }

  if (macdCandles.length >= signal) {
    const signalEmaValues = ema(macdCandles, signal);
    // Start at signal-1 to skip the EMA warm-up placeholders (0s) from ema()
    for (let i = signal - 1; i < signalEmaValues.length; i++) {
      const idx = validStart + i;
      const sv = signalEmaValues[i] ?? NaN;
      const mv = macdLine[idx] ?? NaN;
      signalLine[idx] = sv;
      histogram[idx] = isNaN(mv) || isNaN(sv) ? NaN : mv - sv;
    }
  }

  return { macdLine, signalLine, histogram };
}

// ─── Support / Resistance ─────────────────────────────────────────────────────

export interface SupportResistanceLevels {
  supports: number[];
  resistances: number[];
}

/**
 * Find support and resistance levels using pivot points.
 * Looks for local highs/lows within the lookback window.
 */
export function findSupportResistance(
  candles: PriceCandle[],
  lookback = 50,
): SupportResistanceLevels {
  const supports: number[] = [];
  const resistances: number[] = [];
  const window = Math.min(lookback, candles.length);
  const slice = candles.slice(-window);

  for (let i = 1; i < slice.length - 1; i++) {
    const prev = slice[i - 1]!;
    const curr = slice[i]!;
    const next = slice[i + 1]!;

    if (curr.high > prev.high && curr.high > next.high) {
      resistances.push(curr.high);
    }
    if (curr.low < prev.low && curr.low < next.low) {
      supports.push(curr.low);
    }
  }

  return { supports, resistances };
}

/**
 * Check if price is breaking above the nearest resistance level.
 * Returns true if price is above a resistance and within `threshold` %
 * (i.e. just broke through, not already far above).
 */
export function isBreakingResistance(
  currentPrice: number,
  resistances: number[],
  threshold = 0.005,
): boolean {
  // Find the nearest broken resistance (highest level at or below current price)
  const broken = resistances.filter((r) => r <= currentPrice);
  if (broken.length === 0) return false;
  const nearest = Math.max(...broken);
  return currentPrice <= nearest * (1 + threshold);
}

/**
 * Returns true if price is at or just above the support level, within threshold% —
 * a pre-bounce setup.
 */
export function isBouncingSupport(
  currentPrice: number,
  supports: number[],
  threshold = 0.005,
): boolean {
  // Find the highest support level at or below current price
  const held = supports.filter((s) => s <= currentPrice);
  if (held.length === 0) return false;
  const nearest = Math.max(...held);
  return currentPrice <= nearest * (1 + threshold);
}

// ─── Volume Trend ─────────────────────────────────────────────────────────────

/**
 * Volume trend ratio: average volume of recent N bars / average of last M bars.
 * >1 means increasing volume, <1 means decreasing.
 * Note: the recent-bars window is a subset of the baseline window (both slice from the tail).
 */
export function volumeTrend(candles: PriceCandle[], recentBars = 4, avgBars = 20): number {
  if (recentBars >= avgBars) return 0;
  if (candles.length < avgBars) return 0;

  const slice = candles.slice(-avgBars);
  const avgVolume = slice.reduce((s, c) => s + c.volume, 0) / avgBars;
  if (avgVolume === 0) return 0;

  const recent = candles.slice(-recentBars);
  const recentAvg = recent.reduce((s, c) => s + c.volume, 0) / recentBars;

  return recentAvg / avgVolume;
}

// ─── Swing Points ─────────────────────────────────────────────────────────────

export interface SwingPoint {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * Detect swing highs and lows with configurable lookback and prominence filter.
 * Same-type adjacent points are deduplicated (keeps later occurrence).
 */
export function detectSwingPoints(
  candles: PriceCandle[],
  swingLookback = 3,
  minSwingPct = 0,
): SwingPoint[] {
  const minLen = 2 * swingLookback + 1;
  if (candles.length < minLen) return [];

  const raw: SwingPoint[] = [];

  for (let i = swingLookback; i < candles.length - swingLookback; i++) {
    const curr = candles[i]!;
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= swingLookback; j++) {
      if (curr.high <= candles[i - j]!.high || curr.high <= candles[i + j]!.high) isHigh = false;
      if (curr.low >= candles[i - j]!.low || curr.low >= candles[i + j]!.low) isLow = false;
    }

    if (isHigh) {
      if (minSwingPct > 0) {
        const refLow = candles[i - swingLookback]!.low;
        if (refLow > 0 && (curr.high - refLow) / refLow < minSwingPct) isHigh = false;
      }
      if (isHigh) raw.push({ index: i, price: curr.high, type: 'high' });
    }

    if (isLow) {
      if (minSwingPct > 0) {
        const refHigh = candles[i - swingLookback]!.high;
        if (refHigh > 0 && (refHigh - curr.low) / refHigh < minSwingPct) isLow = false;
      }
      if (isLow) raw.push({ index: i, price: curr.low, type: 'low' });
    }
  }

  // Deduplicate: adjacent same-type points → keep later occurrence
  const deduped: SwingPoint[] = [];
  for (const point of raw) {
    const last = deduped[deduped.length - 1];
    if (last && last.type === point.type) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }

  return deduped;
}

// ─── Market Structure from Swings ─────────────────────────────────────────────

export type MarketStructureFromSwings = 'bullish' | 'bearish' | 'indeterminate';

/**
 * Classify market structure from detected swing points.
 * bullish = higher highs + higher lows
 * bearish = lower highs + lower lows
 */
export function classifyStructure(swingPoints: SwingPoint[]): MarketStructureFromSwings {
  const highs = swingPoints.filter((p) => p.type === 'high');
  const lows = swingPoints.filter((p) => p.type === 'low');

  if (highs.length < 2 || lows.length < 2) return 'indeterminate';

  const lastHigh = highs[highs.length - 1]!.price;
  const prevHigh = highs[highs.length - 2]!.price;
  const lastLow = lows[lows.length - 1]!.price;
  const prevLow = lows[lows.length - 2]!.price;

  const hhhl = lastHigh > prevHigh && lastLow > prevLow;
  const lhll = lastHigh < prevHigh && lastLow < prevLow;

  if (hhhl) return 'bullish';
  if (lhll) return 'bearish';
  return 'indeterminate';
}

// ─── CHOCH ────────────────────────────────────────────────────────────────────

export interface ChochSignal {
  type: 'bullish' | 'bearish';
  breakIndex: number;
  breakPrice: number;
  brokenLevel: number;
}

/**
 * Detect structural break (CHOCH).
 * Bullish CHOCH: bearish structure + price closes above last swing high.
 * Bearish CHOCH: bullish structure + price closes below last swing low.
 * `confirmBars` limits freshness — only breaks within last N bars count.
 */
export function detectCHOCH(
  candles: PriceCandle[],
  swingPoints: SwingPoint[],
  structure: MarketStructureFromSwings,
  confirmBars = 5,
): ChochSignal | null {
  if (structure === 'indeterminate') return null;
  if (candles.length === 0) return null;

  const lastIndex = candles.length - 1;
  const freshStart = lastIndex - confirmBars + 1;

  if (structure === 'bearish') {
    // Bullish CHOCH: price closes above last swing high
    const lastHigh = [...swingPoints].reverse().find((p) => p.type === 'high');
    if (!lastHigh) return null;

    for (let i = Math.max(freshStart, lastHigh.index + 1); i <= lastIndex; i++) {
      const candle = candles[i]!;
      if (candle.close > lastHigh.price) {
        return {
          type: 'bullish',
          breakIndex: i,
          breakPrice: candle.close,
          brokenLevel: lastHigh.price,
        };
      }
    }
  }

  if (structure === 'bullish') {
    // Bearish CHOCH: price closes below last swing low
    const lastLow = [...swingPoints].reverse().find((p) => p.type === 'low');
    if (!lastLow) return null;

    for (let i = Math.max(freshStart, lastLow.index + 1); i <= lastIndex; i++) {
      const candle = candles[i]!;
      if (candle.close < lastLow.price) {
        return {
          type: 'bearish',
          breakIndex: i,
          breakPrice: candle.close,
          brokenLevel: lastLow.price,
        };
      }
    }
  }

  return null;
}
