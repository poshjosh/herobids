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

export interface PriceCandle {
  timestamp: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  timeoutMs: number;
}
