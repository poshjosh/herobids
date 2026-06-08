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
