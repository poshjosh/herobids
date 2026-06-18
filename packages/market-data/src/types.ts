export type { PriceCandle } from '@herobids/domain';

export const PROVIDER_REQUEST_CLASSES = [
  'execution-critical',
  'price-support',
  'regime',
  'discovery',
  'enrichment',
] as const;

export type ProviderRequestClass = typeof PROVIDER_REQUEST_CLASSES[number];
export type MarketDataProviderName =
  | 'binance'
  | 'dexscreener'
  | 'geckoterminal'
  | 'hyperliquid'
  | 'bybit'
  | 'birdeye'
  | 'coinmarketcap'
  | 'aggregated-discovery';

export interface MarketDataBudgetSettings {
  requestsPerMinute: number;
  burstCapacity?: number;
  maxWaitMs?: number;
  cacheTtlMs?: number;
}

export interface RequestGate {
  acquire(): Promise<void>;
}


export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  network: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct: number;
  dexId: string;
  poolCreatedAt?: string;
}

export interface FreshnessMetadata {
  source: 'upstream' | 'cache';
  fetchedAt: string;
  ageMs: number;
  ttlMs: number;
  isStale: boolean;
  expiresAt: string;
}

export interface ProviderResult<T> {
  data: T;
  meta: {
    provider: MarketDataProviderName;
    requestClass: ProviderRequestClass;
    cacheKey?: string;
    freshness: FreshnessMetadata;
  };
}

export interface HyperliquidAssetContext {
  asset: string;
  fundingRate: number | null;
  annualizedFundingRatePct: number | null;
  openInterest: number | null;
  markPrice: number | null;
  midPrice: number | null;
  oraclePrice: number | null;
  markOracleSpreadPct: number | null;
  volume24hUsd: number | null;
  prevDayPrice: number | null;
  priceChange24hPct: number | null;
}

export interface BybitCrowdingSignal {
  symbol: string;
  buyRatio: number | null;
  sellRatio: number | null;
  longShortRatio: number | null;
  timestamp: string;
}

export interface DiscoveredPool {
  poolAddress: string;
  network: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  poolCreatedAt?: string;
}

export interface DiscoveredToken {
  address: string;
  symbol: string;
  name: string;
  network: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct?: number;
  source: 'dexscreener' | 'geckoterminal' | 'coinmarketcap';
  discoveryVectors: string[];
  poolAddress?: string;
  poolCreatedAt?: string;
  // Provider enrichment fields — currently populated by the CMC post-merge pass.
  // holderCount remains reserved for providers that can supply it.
  marketCapUsd?: number;
  fullyDilutedValuationUsd?: number;
  holderCount?: number;
  cexListings?: number;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface RegimeParams {
  benchmarkSymbol?: string;
  emaFast?: number;
  emaSlow?: number;
  emaTrend?: number;
  adxMin?: number;
  emaAlignment?: 'bullish' | 'bearish' | 'any';
  marketStructure?: 'higherHighs' | 'lowerHighs' | 'any';
  priceAboveVwap?: boolean;
  disableWhenChoppy?: boolean;
}

export interface RegimeResult {
  pass: boolean;
  reasons: string[];
  details: {
    benchmarkSymbol: string;
    currentPrice: number;
    emaFast: number;
    emaSlow: number;
    emaTrend: number;
    emaAlignment: 'bullish' | 'bearish';
    adxValue: number;
    choppy: boolean;
    vwap: number;
    priceAboveVwap: boolean;
    marketStructure: 'higherHighs' | 'lowerHighs' | 'mixed';
  };
}

export interface MarketDataConfig {
  dexscreener: {
    baseUrl: string;
    search: MarketDataBudgetSettings;
    discovery: MarketDataBudgetSettings;
  };
  geckoterminal: {
    baseUrl: string;
    candles: MarketDataBudgetSettings;
    discovery: MarketDataBudgetSettings;
  };
  hyperliquid: {
    baseUrl: string;
    intelligencePath: string;
    intelligence: MarketDataBudgetSettings;
  };
  bybit: {
    baseUrl: string;
    longShortRatioPath: string;
    intelligence: MarketDataBudgetSettings;
  };
  binance: {
    baseUrl: string;
    requestsPerMinute: number;
  };
  birdeye: {
    enabled: boolean;
    baseUrl: string;
    requestsPerMinute: number;
    apiKey: string;
    cacheTtlMs: number;
  };
  coinMarketCap: {
    enabled: boolean;
    baseUrl: string;
    requestsPerMinute: number;
    apiKey: string;
    cacheTtlMs: number;
  };
  tokenSafety?: {
    enabled: boolean;
    defaults: {
      minLiquidityUsd: number;
      minVolume24hUsd: number;
      minTokenAgeHours: number;
      deadPoolMinAgeHours: number;
      deadPoolMaxVolume24hUsd: number;
      preferCanonical: boolean;
      requireCanonicalForKnownSymbols: boolean;
      includeBlockedSearchResults: boolean;
    };
    tradeGuard: {
      enabled: boolean;
      liquidityMultiplier: number;
      allowOverrides: boolean;
      overrideTtlMs: number;
    };
    canonicalTokens: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>;
  };
  discovery: {
    maxResults: number;
  };
  timeoutMs: number;
}

// --- Token Safety Types ---

export type TokenSafetyReasonCode =
  | 'token.low_liquidity'
  | 'token.low_volume'
  | 'token.too_new'
  | 'token.dead_pool'
  | 'token.non_canonical'
  | 'token.high_risk'
  | 'token.network_mismatch'
  | 'token.identity_ambiguous'
  | 'token.age_unknown';

export interface TokenSafetyReason {
  code: TokenSafetyReasonCode;
  message: string;
  actual?: number | string;
  threshold?: number | string;
}

export interface CanonicalTokenDefinition {
  symbol: string;
  network: string;
  address: string;
  name: string;
  aliases?: string[];
}

export interface TokenSafetySummary {
  eligible: boolean;
  score: number;
  canonical: boolean;
  canonicalSymbol?: string;
  ageHours?: number;
  blockedReasons: TokenSafetyReason[];
  warnings: TokenSafetyReason[];
}

export interface TokenSearchCandidate extends TokenInfo {
  poolCreatedAt?: string;
  marketCapUsd?: number;
  fullyDilutedValuationUsd?: number;
  holderCount?: number;
  cexListings?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  discoveryVectors?: string[];
  safety: TokenSafetySummary;
}

export interface TokenSearchPolicyOptions {
  network?: string;
  limit?: number;
  includeBlocked?: boolean;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minTokenAgeHours?: number;
  preferCanonical?: boolean;
}

