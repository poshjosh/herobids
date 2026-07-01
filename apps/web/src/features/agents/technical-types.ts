export interface IndicatorFormState {
  rsi: { enabled: boolean; period: string; healthyMin: string; healthyMax: string; overbought: string; weakBelow: string };
  macd: { enabled: boolean; fast: string; slow: string; signal: string };
  volume: { enabled: boolean; strongRatio: string; weakRatio: string; recentBars: string; avgBars: string };
  choch: { enabled: boolean; swingLookback: string; minSwingPct: string; confirmBars: string; rejectOnBearish: boolean };
  supportResistance: { enabled: boolean; lookback: string; breakoutThreshold: string };
}

export interface TechnicalConfigFormState {
  filters: {
    venue: string;
    venueType: 'orderbook' | 'swap' | '';
    minVolume24hUsd: string;
    minLiquidityUsd: string;
    networks: string[];
    symbols: string[];
    excludeSymbols: string[];
  };
  candles: { interval: '5m' | '15m' | '1H' | '4H' | '1D'; limit: string };
  signalBias: 'trend-following' | 'mean-reverting';
  scanIntervalMins: string;
  scanBatchSize: string;
  indicators: IndicatorFormState;
  confidence: {
    rsiWeight: string;
    macdCrossoverWeight: string;
    macdIncreasingWeight: string;
    volumeWeight: string;
    breakoutWeight: string;
    chochBullishWeight: string;
    chochBearishPenalty: string;
    priceActionWeight: string;
    minConfidence: string;
    minReasons: string;
  };
}
