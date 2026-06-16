export interface PriceCandle {
  timestamp: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleFetcher {
  fetchCandles(
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<PriceCandle[]>;
}
