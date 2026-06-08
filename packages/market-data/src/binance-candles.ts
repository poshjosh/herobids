import type { PriceCandle } from './types.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

/**
 * Binance public klines (candles) API.
 * Used for perpetuals regime checks where DEX pool data is unavailable.
 * No auth required.
 *
 * Symbol mapping: instrument ID → Binance symbol
 * - BTC → BTCUSDT
 * - SOL → SOLUSDT
 * - ETH → ETHUSDT
 */

export interface BinanceCandlesConfig {
  baseUrl: string;
  rateLimiter: TokenBucketRateLimiter;
  timeoutMs: number;
}

type BinanceKline = [
  number,   // open time
  string,   // open
  string,   // high
  string,   // low
  string,   // close
  string,   // volume
  number,   // close time
  string,   // quote asset volume
  number,   // number of trades
  string,   // taker buy base volume
  string,   // taker buy quote volume
  string,   // unused
];

const SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  DOGE: 'DOGEUSDT',
  AVAX: 'AVAXUSDT',
  LINK: 'LINKUSDT',
  ARB: 'ARBUSDT',
  OP: 'OPUSDT',
  SUI: 'SUIUSDT',
};

export function resolveBinanceSymbol(instrument: string): string {
  const upper = instrument.toUpperCase();
  return SYMBOL_MAP[upper] ?? `${upper}USDT`;
}

export async function fetchBinanceCandles(
  symbol: string,
  config: BinanceCandlesConfig,
  options?: { interval?: string; limit?: number },
): Promise<PriceCandle[]> {
  await config.rateLimiter.acquire();

  const interval = options?.interval ?? '1h';
  const limit = options?.limit ?? 100;
  const binanceSymbol = resolveBinanceSymbol(symbol);

  const url = `${config.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BinanceKline[];

    return data.map((kline): PriceCandle => ({
      timestamp: new Date(kline[0]).toISOString(),
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5]),
    }));
  } finally {
    clearTimeout(timeout);
  }
}
