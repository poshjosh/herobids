import type { BybitCrowdingSignal, RequestGate } from './types.js';
import { fetchJson } from './http.js';

interface BybitAccountRatioItem {
  symbol?: string;
  buyRatio?: string;
  sellRatio?: string;
  timestamp?: string;
}

interface BybitInfoResponse {
  result?: {
    list?: BybitAccountRatioItem[];
  };
}

export interface BybitInfoConfig {
  baseUrl: string;
  longShortRatioPath?: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

function parseRatio(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchBybitLongShortRatio(
  symbol: string,
  config: BybitInfoConfig,
  options?: { period?: '5min' | '15min' | '30min' | '1h' | '4h' | '1d'; limit?: number },
): Promise<BybitCrowdingSignal[]> {
  await config.rateLimiter.acquire();

  const period = options?.period ?? '1h';
  const limit = options?.limit ?? 10;
  const url = `${config.baseUrl}${config.longShortRatioPath ?? '/v5/market/account-ratio'}?category=linear&symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${limit}`;
  const response = await fetchJson<BybitInfoResponse>({
    url,
    timeoutMs: config.timeoutMs,
    fetchFn: config.fetchFn,
  });

  return (response.result?.list ?? []).map((item): BybitCrowdingSignal => {
    const buyRatio = parseRatio(item.buyRatio);
    const sellRatio = parseRatio(item.sellRatio);
    return {
      symbol: item.symbol ?? symbol,
      buyRatio,
      sellRatio,
      longShortRatio: buyRatio !== null && sellRatio !== null && sellRatio !== 0 ? buyRatio / sellRatio : null,
      timestamp: item.timestamp ? new Date(Number(item.timestamp)).toISOString() : new Date(0).toISOString(),
    };
  });
}