import type { PriceCandle } from '@herobids/market-data';
import {
  rsi,
  macd,
  volumeTrend,
  findSupportResistance,
  isBreakingResistance,
  isBouncingSupport,
  detectSwingPoints,
  classifyStructure,
  detectCHOCH,
} from '@herobids/market-data';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CandidateContext {
  symbol: string;
  instrumentId: string;
  candles: PriceCandle[];
  meta?: {
    volume24hUsd?: number;
    liquidityUsd?: number;
    priceChange24hPct?: number;
  };
}

export interface ScoredSignal {
  symbol: string;
  instrumentId: string;
  confidence: number;
  reasons: string[];
  intent: 'go_long'; // Only long signals emitted in Phase 2; 'go_short' not yet implemented
  indicators: {
    rsi?: number;
    macdHistogram?: number;
    volumeRatio?: number;
    breakingResistance?: boolean;
    choch?: 'bullish' | 'bearish' | null;
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
    minConfidence: indicators.confidence?.minConfidence ?? 0.45,
    minReasons: indicators.confidence?.minReasons ?? 2,
  };

  let confidence = 0;
  const reasons: string[] = [];
  const indicatorValues: ScoredSignal['indicators'] = {};

  // ─── RSI ──────────────────────────────────────────────────────────────────
  if (rsiCfg.enabled) {
    const rsiValues = rsi(candles, rsiCfg.period);
    const lastRsi = rsiValues[rsiValues.length - 1] ?? NaN;

    if (!isNaN(lastRsi)) {
      indicatorValues.rsi = lastRsi;

      if (lastRsi > rsiCfg.overbought) {
        return null; // HARD REJECT
      }

      if (signalBias === 'trend-following') {
        if (lastRsi >= rsiCfg.healthyMin && lastRsi <= rsiCfg.healthyMax) {
          confidence += confCfg.rsiWeight;
          reasons.push('RSI in healthy range');
        }
      } else {
        // mean-reverting
        if (lastRsi < rsiCfg.weakBelow) {
          confidence += confCfg.rsiWeight;
          reasons.push('RSI oversold');
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
          confidence += confCfg.macdCrossoverWeight;
          reasons.push('MACD bullish crossover');
        }
        // Increasing: current bar higher than previous
        if (curr > prev) {
          confidence += confCfg.macdIncreasingWeight;
          reasons.push('MACD histogram increasing');
        }
      }
      // curr <= 0: neutral, no contribution
    }
  }

  // ─── Volume ───────────────────────────────────────────────────────────────
  if (volumeCfg.enabled) {
    const ratio = volumeTrend(candles, volumeCfg.recentBars, volumeCfg.avgBars);
    indicatorValues.volumeRatio = ratio;

    if (ratio >= volumeCfg.strongRatio) {
      confidence += confCfg.volumeWeight;
      reasons.push('Strong volume');
    }
    // <= weakRatio: neutral, no contribution
  }

  // ─── Support / Resistance ─────────────────────────────────────────────────
  if (srCfg.enabled && candles.length > 0) {
    const levels = findSupportResistance(candles, srCfg.lookback);
    const lastClose = candles[candles.length - 1]!.close;
    if (signalBias === 'trend-following') {
      const breaking = isBreakingResistance(lastClose, levels.resistances, srCfg.breakoutThreshold);
      if (breaking) {
        confidence += confCfg.breakoutWeight;
        reasons.push('Breaking resistance');
        indicatorValues.breakingResistance = true;
      } else {
        indicatorValues.breakingResistance = false;
      }
    } else {
      const bouncing = isBouncingSupport(lastClose, levels.supports, srCfg.breakoutThreshold);
      if (bouncing) {
        confidence += confCfg.breakoutWeight;
        reasons.push('Bouncing off support');
        indicatorValues.breakingResistance = false;
      } else {
        indicatorValues.breakingResistance = false;
      }
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
          confidence += confCfg.chochBullishWeight;
          reasons.push('Bullish CHOCH');
        } else {
          // mean-reverting: bullish CHOCH is counter-signal — penalize
          confidence = Math.max(0, confidence - confCfg.chochBearishPenalty);
        }
      } else if (choch?.type === 'bearish') {
        if (signalBias === 'trend-following') {
          if (chochCfg.rejectOnBearish) {
            return null; // HARD REJECT
          }
        } else {
          // mean-reverting: bearish CHOCH = capitulation = entry signal
          confidence += confCfg.chochBullishWeight;
          reasons.push('Bearish CHOCH (reversal)');
        }
      }
    }
  }

  // ─── Confidence filter ────────────────────────────────────────────────────
  confidence = Math.min(1, confidence);

  if (confidence < confCfg.minConfidence || reasons.length < confCfg.minReasons) {
    return null;
  }

  return {
    symbol,
    instrumentId,
    confidence,
    reasons,
    intent: 'go_long',
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
