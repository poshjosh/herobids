import type { PriceCandle, RequestGate } from './types.js';
import { fetchJson } from './http.js';

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
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
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
  const stripped = instrument.split(/[/\-]/)[0]!.toUpperCase();
  const base = stripped.replace(/USDT$|USD$|PERP$/i, '') || stripped;
  return SYMBOL_MAP[base] ?? `${base}USDT`;
}

export async function fetchBinanceCandles(
  symbol: string,
  config: BinanceCandlesConfig,
  options?: { interval?: string; limit?: number },
): Promise<PriceCandle[]> {
  await config.rateLimiter.acquire();

  const interval = (options?.interval ?? '1h').toLowerCase();
  const limit = options?.limit ?? 100;
  const binanceSymbol = resolveBinanceSymbol(symbol);

  const url = `${config.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

  const data = await fetchJson<BinanceKline[]>({
    url,
    timeoutMs: config.timeoutMs,
    fetchFn: config.fetchFn,
  });

  return data.map((kline): PriceCandle => ({
    timestamp: new Date(kline[0]).toISOString(),
    open: parseFloat(kline[1]),
    high: parseFloat(kline[2]),
    low: parseFloat(kline[3]),
    close: parseFloat(kline[4]),
    volume: parseFloat(kline[5]),
  }));
}
