import type { PriceCandle } from './types.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

export interface GeckoTerminalConfig {
  baseUrl: string;
  rateLimiter: TokenBucketRateLimiter;
  timeoutMs: number;
}

interface OhlcvAttributes {
  ohlcv_list?: Array<[number, string, string, string, string, string]>;
}

interface GeckoTerminalResponse {
  data?: {
    attributes?: OhlcvAttributes;
  };
}

/**
 * Fetch OHLCV candles from GeckoTerminal for a DEX pool.
 * Timeframes: 'minute', 'hour', 'day'
 */
export async function fetchGeckoTerminalCandles(
  network: string,
  poolAddress: string,
  config: GeckoTerminalConfig,
  options?: { timeframe?: 'minute' | 'hour' | 'day'; limit?: number },
): Promise<PriceCandle[]> {
  await config.rateLimiter.acquire();

  const timeframe = options?.timeframe ?? 'hour';
  const limit = options?.limit ?? 100;

  const url = `${config.baseUrl}/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${timeframe}?limit=${limit}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`GeckoTerminal API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GeckoTerminalResponse;
    const ohlcvList = data.data?.attributes?.ohlcv_list ?? [];

    return ohlcvList.map((item): PriceCandle => ({
      timestamp: new Date(item[0] * 1000).toISOString(),
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
    }));
  } finally {
    clearTimeout(timeout);
  }
}
