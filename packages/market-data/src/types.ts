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
    requestsPerMinute: number;
  };
  binance: {
    baseUrl: string;
    requestsPerMinute: number;
  };
  timeoutMs: number;
}
