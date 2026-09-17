// Strategy-side scan/score contracts consumed by the preset scorecard runner.
//
// Copied VERBATIM (byte-faithful, declarations only) from the deleted local
// package `packages/strategy/src/scan-engine.ts` (Slice 4 Plan B, ruling:
// amended Option A — narrow consumer-side type seams; copy sources cited).
//
// IMPORTANT: this `IndicatorConfig` is the STRATEGY-SIDE shape (all fields and
// all sub-objects optional). Do NOT replace it with the domain zod-inferred
// `IndicatorConfig` (`packages/domain/src/config/schema.ts`) — that type has
// REQUIRED sub-object keys, so `{}` (which `extractIndicatorConfig` returns
// when a preset carries no indicator params) satisfies only the strategy
// shape. The scorecard payload must keep the permissive shape.
//
// `HybridPricingIdentity`/`SwapExecutionIdentity` come from `@herobids/domain`
// (already exported there; structurally identical to the strategy-side types).

import type { HybridPricingIdentity, SwapExecutionIdentity } from '@herobids/domain';

export interface ScoredSignal {
  symbol: string;
  instrumentId: string;
  venue?: string;
  venueType?: 'orderbook' | 'swap';
  pricingIdentity?: HybridPricingIdentity;
  swapExecutionIdentity?: SwapExecutionIdentity;
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
