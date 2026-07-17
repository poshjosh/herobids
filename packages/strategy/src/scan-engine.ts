import type { PriceCandle } from '@herobids/market-data';
import type { HybridPricingIdentity } from '@herobids/domain';
import {
  rsi,
  macd,
  volumeTrend,
  vwap,
  findSupportResistance,
  isBreakingResistance,
  isBouncingSupport,
  detectSwingPoints,
  classifyStructure,
  detectCHOCH,
} from '@herobids/market-data';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Identifies an orderbook candle source for scanner candle fetching. */
export interface ScannerCandleTarget {
  venueType: 'orderbook';
  providerSymbol: string;
}

export interface CandidateContext {
  symbol: string;
  instrumentId: string;
  candles: PriceCandle[];
  venue?: string;
  venueType?: 'orderbook';
  candleTarget?: ScannerCandleTarget;
  pricingIdentity?: HybridPricingIdentity;
  meta?: {
    volume24hUsd?: number;
    liquidityUsd?: number;
    priceChange24hPct?: number;
  };
}

export interface ScoredSignal {
  symbol: string;
  instrumentId: string;
  venue?: string;
  venueType?: 'orderbook';
  pricingIdentity?: HybridPricingIdentity;
  confidence: number;
  reasons: string[];
  intent: 'go_long' | 'go_short';
  indicators: {
    rsi?: number;
    macdHistogram?: number;
    volumeRatio?: number;
    breakingResistance?: boolean;
    breakingSupport?: boolean;
    choch?: 'bullish' | 'bearish' | null;
    priceAboveVwap?: boolean;
  };
}

export interface IndicatorConfig {
  rsi?: {
    enabled?: boolean;
    period?: number;
    healthyMin?: number;
    healthyMax?: number;
    overbought?: number;
    weakBelow?: number;
  };
  macd?: {
    enabled?: boolean;
    fast?: number;
    slow?: number;
    signal?: number;
  };
  volume?: {
    enabled?: boolean;
    strongRatio?: number;
    weakRatio?: number;
    recentBars?: number;
    avgBars?: number;
  };
  choch?: {
    enabled?: boolean;
    swingLookback?: number;
    minSwingPct?: number;
    minSwings?: number;
    confirmBars?: number;
    rejectOnBearish?: boolean;
  };
  vwap?: {
    enabled?: boolean;
    period?: number;
  };
  priceAction?: {
    enabled?: boolean;
    minChange24hPct?: number;
    maxChange24hPct?: number;
  };
  supportResistance?: {
    enabled?: boolean;
    lookback?: number;
    breakoutThreshold?: number;
  };
  confidence?: {
    rsiWeight?: number;
    macdCrossoverWeight?: number;
    macdIncreasingWeight?: number;
    volumeWeight?: number;
    breakoutWeight?: number;
    chochBullishWeight?: number;
    chochBearishPenalty?: number;
    priceActionWeight?: number;
    vwapWeight?: number;
    minConfidence?: number;
    minReasons?: number;
  };
}

export interface ScanConfig {
  indicators: IndicatorConfig;
  signalBias: 'trend-following' | 'mean-reverting';
  maxResults?: number;
}

// ─── Core functions ───────────────────────────────────────────────────────────

export function scoreCandidate(
  candidate: CandidateContext,
  config: ScanConfig,
): ScoredSignal | null {
  const { candles, symbol, instrumentId } = candidate;
  const { indicators, signalBias } = config;

  // Resolve defaults
  const rsiCfg = {
    enabled: indicators.rsi?.enabled ?? true,
    period: indicators.rsi?.period ?? 14,
    healthyMin: indicators.rsi?.healthyMin ?? 40,
    healthyMax: indicators.rsi?.healthyMax ?? 70,
    overbought: indicators.rsi?.overbought ?? 80,
    weakBelow: indicators.rsi?.weakBelow ?? 30,
  };

  const macdCfg = {
    enabled: indicators.macd?.enabled ?? true,
    fast: indicators.macd?.fast ?? 12,
    slow: indicators.macd?.slow ?? 26,
    signal: indicators.macd?.signal ?? 9,
  };

  const volumeCfg = {
    enabled: indicators.volume?.enabled ?? true,
    strongRatio: indicators.volume?.strongRatio ?? 1.5,
    weakRatio: indicators.volume?.weakRatio ?? 0.5,
    recentBars: indicators.volume?.recentBars ?? 4,
    avgBars: indicators.volume?.avgBars ?? 20,
  };

  const chochCfg = {
    enabled: indicators.choch?.enabled ?? false,
    swingLookback: indicators.choch?.swingLookback ?? 5,
    minSwingPct: indicators.choch?.minSwingPct ?? 0.01,
    minSwings: indicators.choch?.minSwings ?? 4,
    confirmBars: indicators.choch?.confirmBars ?? 2,
    rejectOnBearish: indicators.choch?.rejectOnBearish ?? false,
  };

  const srCfg = {
    enabled: indicators.supportResistance?.enabled ?? false,
    lookback: indicators.supportResistance?.lookback ?? 50,
    breakoutThreshold: indicators.supportResistance?.breakoutThreshold ?? 0.005,
  };

  const confCfg = {
    rsiWeight: indicators.confidence?.rsiWeight ?? 0.15,
    macdCrossoverWeight: indicators.confidence?.macdCrossoverWeight ?? 0.20,
    macdIncreasingWeight: indicators.confidence?.macdIncreasingWeight ?? 0.10,
    volumeWeight: indicators.confidence?.volumeWeight ?? 0.15,
    breakoutWeight: indicators.confidence?.breakoutWeight ?? 0.15,
    chochBullishWeight: indicators.confidence?.chochBullishWeight ?? 0.15,
    chochBearishPenalty: indicators.confidence?.chochBearishPenalty ?? 0.10,
    priceActionWeight: indicators.confidence?.priceActionWeight ?? 0.10,
    vwapWeight: indicators.confidence?.vwapWeight ?? 0,
    minConfidence: indicators.confidence?.minConfidence ?? 0.45,
    minReasons: indicators.confidence?.minReasons ?? 2,
  };

  // Track bullish and bearish confidence separately so we can pick the stronger signal
  let bullishConfidence = 0;
  let bearishConfidence = 0;
  const bullishReasons: string[] = [];
  const bearishReasons: string[] = [];
  const indicatorValues: ScoredSignal['indicators'] = {};

  // ─── RSI ──────────────────────────────────────────────────────────────────
  if (rsiCfg.enabled) {
    const rsiValues = rsi(candles, rsiCfg.period);
    const lastRsi = rsiValues[rsiValues.length - 1] ?? NaN;

    if (!isNaN(lastRsi)) {
      indicatorValues.rsi = lastRsi;

      if (signalBias === 'trend-following') {
        if (lastRsi >= rsiCfg.healthyMin && lastRsi <= rsiCfg.healthyMax) {
          bullishConfidence += confCfg.rsiWeight;
          bullishReasons.push('RSI in healthy range');
        } else if (lastRsi > rsiCfg.overbought) {
          // Overbought = bearish confirmation for trend-following shorts
          bearishConfidence += confCfg.rsiWeight;
          bearishReasons.push('RSI overbought');
        }
      } else {
        // mean-reverting
        if (lastRsi < rsiCfg.weakBelow) {
          bullishConfidence += confCfg.rsiWeight;
          bullishReasons.push('RSI oversold');
        } else if (lastRsi > rsiCfg.overbought) {
          bearishConfidence += confCfg.rsiWeight;
          bearishReasons.push('RSI overbought (mean reversion short)');
        }
      }
    }
  }

  // ─── MACD ─────────────────────────────────────────────────────────────────
  if (macdCfg.enabled) {
    const { histogram } = macd(candles, macdCfg.fast, macdCfg.slow, macdCfg.signal);
    // Get the last two valid (non-NaN) histogram values
    const validHist = histogram.filter((v) => !isNaN(v));

    if (validHist.length >= 2) {
      const prev = validHist[validHist.length - 2]!;
      const curr = validHist[validHist.length - 1]!;

      indicatorValues.macdHistogram = curr;

      if (curr > 0) {
        // Crossover: histogram crossed from non-positive to positive
        if (prev <= 0) {
          bullishConfidence += confCfg.macdCrossoverWeight;
          bullishReasons.push('MACD bullish crossover');
        }
        // Increasing: current bar higher than previous
        if (curr > prev) {
          bullishConfidence += confCfg.macdIncreasingWeight;
          bullishReasons.push('MACD histogram increasing');
        }
      } else if (curr < 0) {
        // Bearish path: histogram crossed from non-negative to negative
        if (prev >= 0) {
          bearishConfidence += confCfg.macdCrossoverWeight;
          bearishReasons.push('MACD bearish crossover');
        }
        // Decreasing (more negative): increasing bearish momentum
        if (curr < prev) {
          bearishConfidence += confCfg.macdIncreasingWeight;
          bearishReasons.push('MACD histogram decreasing');
        }
      }
    }
  }

  // ─── Volume ───────────────────────────────────────────────────────────────
  if (volumeCfg.enabled) {
    const ratio = volumeTrend(candles, volumeCfg.recentBars, volumeCfg.avgBars);
    indicatorValues.volumeRatio = ratio;

    if (ratio >= volumeCfg.strongRatio) {
      // Volume is direction-agnostic — it confirms whichever directional signal
      // ends up winning. We add to both sides so the final direction pick is
      // still driven by directional indicators (RSI, MACD, S/R, CHOCH) while
      // volume boosts the overall confidence score of the selected signal.
      // If applied after direction selection instead, volume would inflate the
      // loser's confidence too — this approach is simpler and equally correct.
      bullishConfidence += confCfg.volumeWeight;
      bearishConfidence += confCfg.volumeWeight;
      bullishReasons.push('Strong volume');
      bearishReasons.push('Strong volume');
    }
  }

  // ─── VWAP ─────────────────────────────────────────────────────────────────
  const vwapCfg = {
    enabled: indicators.vwap?.enabled ?? false,
    period: indicators.vwap?.period ?? 24,
  };

  if (vwapCfg.enabled && candles.length >= vwapCfg.period) {
    const vwapWindow = candles.slice(-vwapCfg.period);
    const vwapValue = vwap(vwapWindow);
    const lastClose = candles[candles.length - 1]!.close;
    const aboveVwap = !isNaN(vwapValue) && vwapValue > 0 && lastClose > vwapValue;
    indicatorValues.priceAboveVwap = aboveVwap;
    if (aboveVwap) {
      bullishConfidence += (confCfg.vwapWeight ?? 0);
      bearishConfidence += (confCfg.vwapWeight ?? 0);
      bullishReasons.push('Price above VWAP');
      bearishReasons.push('Price above VWAP');
    }
  }

  // ─── Price Action ─────────────────────────────────────────────────────────
  const paCfg = {
    enabled: indicators.priceAction?.enabled ?? true,
    minChange24hPct: indicators.priceAction?.minChange24hPct ?? 3,
    maxChange24hPct: indicators.priceAction?.maxChange24hPct ?? 50,
  };

  if (paCfg.enabled && candidate.meta?.priceChange24hPct != null) {
    const change = candidate.meta.priceChange24hPct;
    if (change >= paCfg.minChange24hPct && change <= paCfg.maxChange24hPct) {
      bullishConfidence += (confCfg.priceActionWeight ?? 0.10);
      bullishReasons.push(`+${change.toFixed(1)}% in 24h`);
    }
  }

  // ─── Support / Resistance ─────────────────────────────────────────────────
  if (srCfg.enabled && candles.length > 0) {
    const levels = findSupportResistance(candles, srCfg.lookback);
    const lastClose = candles[candles.length - 1]!.close;

    if (signalBias === 'trend-following') {
      // Bullish: breaking resistance
      const breakingRes = isBreakingResistance(lastClose, levels.resistances, srCfg.breakoutThreshold);
      if (breakingRes) {
        bullishConfidence += confCfg.breakoutWeight;
        bullishReasons.push('Breaking resistance');
        indicatorValues.breakingResistance = true;
      } else {
        indicatorValues.breakingResistance = false;
      }
      // Bearish: breaking support (price falls below a support level)
      const brokenSupports = levels.supports.filter((s) => s >= lastClose);
      if (brokenSupports.length > 0) {
        const nearest = Math.min(...brokenSupports);
        if (lastClose >= nearest * (1 - srCfg.breakoutThreshold)) {
          bearishConfidence += confCfg.breakoutWeight;
          bearishReasons.push('Breaking support');
          indicatorValues.breakingSupport = true;
        } else {
          indicatorValues.breakingSupport = false;
        }
      } else {
        indicatorValues.breakingSupport = false;
      }
    } else {
      // mean-reverting
      const bouncing = isBouncingSupport(lastClose, levels.supports, srCfg.breakoutThreshold);
      if (bouncing) {
        bullishConfidence += confCfg.breakoutWeight;
        bullishReasons.push('Bouncing off support');
      }
      // Bearish mean-reversion: testing resistance from below = potential short
      const nearResistances = levels.resistances.filter((r) => r >= lastClose);
      if (nearResistances.length > 0) {
        const nearest = Math.min(...nearResistances);
        if (nearest <= lastClose * (1 + srCfg.breakoutThreshold)) {
          bearishConfidence += confCfg.breakoutWeight;
          bearishReasons.push('Testing resistance (mean reversion short)');
        }
      }
      indicatorValues.breakingResistance = false;
      indicatorValues.breakingSupport = false;
    }
  }

  // ─── CHOCH ────────────────────────────────────────────────────────────────
  if (chochCfg.enabled) {
    const swings = detectSwingPoints(candles, chochCfg.swingLookback, chochCfg.minSwingPct);

    if (swings.length >= chochCfg.minSwings) {
      const structure = classifyStructure(swings);
      const choch = detectCHOCH(candles, swings, structure, chochCfg.confirmBars);

      indicatorValues.choch = choch?.type ?? null;

      if (choch?.type === 'bullish') {
        if (signalBias === 'trend-following') {
          bullishConfidence += confCfg.chochBullishWeight;
          bullishReasons.push('Bullish CHOCH');
        } else {
          // mean-reverting: bullish CHOCH is counter-signal — penalize bullish side
          bullishConfidence = Math.max(0, bullishConfidence - confCfg.chochBearishPenalty);
        }
      } else if (choch?.type === 'bearish') {
        if (signalBias === 'trend-following') {
          if (chochCfg.rejectOnBearish) {
            // Suppress bullish path entirely, but short path may still qualify
            bullishConfidence = 0;
          }
          bearishConfidence += confCfg.chochBullishWeight;
          bearishReasons.push('Bearish CHOCH');
        } else {
          // mean-reverting: bearish CHOCH = capitulation = entry signal
          bullishConfidence += confCfg.chochBullishWeight;
          bullishReasons.push('Bearish CHOCH (reversal)');
        }
      }
    }
  }

  // ─── Pick direction ──────────────────────────────────────────────────────
  const useBearish = bearishConfidence > bullishConfidence;
  const confidence = Math.min(1, useBearish ? bearishConfidence : bullishConfidence);
  const reasons = useBearish ? bearishReasons : bullishReasons;
  const intent: 'go_long' | 'go_short' = useBearish ? 'go_short' : 'go_long';

  // ─── Confidence filter ────────────────────────────────────────────────────
  if (confidence < confCfg.minConfidence || reasons.length < confCfg.minReasons) {
    return null;
  }

  return {
    symbol,
    instrumentId,
    venue: candidate.venue,
    venueType: candidate.venueType,
    pricingIdentity: candidate.pricingIdentity,
    confidence,
    reasons,
    intent,
    indicators: indicatorValues,
  };
}

export function scanCandidates(
  candidates: CandidateContext[],
  config: ScanConfig,
): ScoredSignal[] {
  const signals = candidates
    .map((c) => scoreCandidate(c, config))
    .filter((s): s is ScoredSignal => s !== null)
    .sort((a, b) => b.confidence - a.confidence);

  if (config.maxResults !== undefined) {
    return signals.slice(0, config.maxResults);
  }

  return signals;
}
