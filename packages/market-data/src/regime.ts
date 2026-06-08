import type { PriceCandle, RegimeParams, RegimeResult } from './types.js';
import { ema, adx, vwap, detectMarketStructure } from './indicators.js';

const MIN_CANDLES_FOR_ADX = 40;

export function getRequiredRegimeCandleCount(params: RegimeParams): number {
  return Math.max(
    MIN_CANDLES_FOR_ADX,
    params.emaFast ?? 20,
    params.emaSlow ?? 50,
    params.emaTrend ?? 200,
  );
}

/**
 * Evaluate market regime using candle data and technical indicators.
 * The `candleFetcher` is injected for testability — callers supply a function
 * that returns candles for a given symbol.
 */
export async function evaluateRegime(
  params: RegimeParams,
  candleFetcher: (symbol: string) => Promise<PriceCandle[]>,
): Promise<RegimeResult> {
  const benchmarkSymbol = params.benchmarkSymbol ?? 'BTC';
  const emaFastPeriod = params.emaFast ?? 20;
  const emaSlowPeriod = params.emaSlow ?? 50;
  const emaTrendPeriod = params.emaTrend ?? 200;
  const adxMinThreshold = params.adxMin ?? 20;
  const requiredAlignment = params.emaAlignment ?? 'any';
  const requiredStructure = params.marketStructure ?? 'any';
  const requirePriceAboveVwap = params.priceAboveVwap ?? false;
  const disableWhenChoppy = params.disableWhenChoppy ?? false;
  const requiredCandleCount = getRequiredRegimeCandleCount(params);

  const candles = await candleFetcher(benchmarkSymbol);

  if (candles.length < requiredCandleCount) {
    return {
      pass: false,
      reasons: [`insufficient_data: need at least ${requiredCandleCount} candles for the requested indicators`],
      details: {
        benchmarkSymbol,
        currentPrice: candles.length > 0 ? candles[candles.length - 1]!.close : 0,
        emaFast: 0,
        emaSlow: 0,
        emaTrend: 0,
        emaAlignment: 'bearish',
        adxValue: 0,
        choppy: true,
        vwap: 0,
        priceAboveVwap: false,
        marketStructure: 'mixed',
      },
    };
  }

  // Compute indicators
  const emaFastValues = ema(candles, emaFastPeriod);
  const emaSlowValues = ema(candles, emaSlowPeriod);
  const emaTrendValues = ema(candles, emaTrendPeriod);
  const adxValue = adx(candles);
  const vwapValue = vwap(candles);
  const structure = detectMarketStructure(candles);

  const lastIdx = candles.length - 1;
  const currentPrice = candles[lastIdx]!.close;
  const lastEmaFast = emaFastValues[lastIdx] ?? 0;
  const lastEmaSlow = emaSlowValues[lastIdx] ?? 0;
  const lastEmaTrend = emaTrendValues[lastIdx] ?? 0;

  // Determine EMA alignment
  const emaAlignment: 'bullish' | 'bearish' =
    lastEmaFast > lastEmaSlow && lastEmaSlow > lastEmaTrend ? 'bullish' : 'bearish';

  const isChoppy = !isNaN(adxValue) && adxValue < adxMinThreshold;
  const priceIsAboveVwap = currentPrice > vwapValue;

  // Evaluate pass/fail conditions
  const reasons: string[] = [];
  let pass = true;

  if (disableWhenChoppy && isChoppy) {
    pass = false;
    reasons.push(`ADX ${adxValue.toFixed(1)} below threshold ${adxMinThreshold} — market is choppy`);
  }

  if (requiredAlignment !== 'any' && emaAlignment !== requiredAlignment) {
    pass = false;
    reasons.push(`EMA alignment is ${emaAlignment}, required ${requiredAlignment}`);
  }

  if (requiredStructure !== 'any' && structure !== requiredStructure) {
    pass = false;
    reasons.push(`Market structure is ${structure}, required ${requiredStructure}`);
  }

  if (requirePriceAboveVwap && !priceIsAboveVwap) {
    pass = false;
    reasons.push(`Price ${currentPrice.toFixed(2)} is below VWAP ${vwapValue.toFixed(2)}`);
  }

  if (pass && reasons.length === 0) {
    reasons.push('All regime checks passed');
  }

  return {
    pass,
    reasons,
    details: {
      benchmarkSymbol,
      currentPrice,
      emaFast: lastEmaFast,
      emaSlow: lastEmaSlow,
      emaTrend: lastEmaTrend,
      emaAlignment,
      adxValue: isNaN(adxValue) ? 0 : adxValue,
      choppy: isChoppy,
      vwap: vwapValue,
      priceAboveVwap: priceIsAboveVwap,
      marketStructure: structure,
    },
  };
}
