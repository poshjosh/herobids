import type { BybitTicker, RequestGate } from './types.js';
import { fetchJson } from './http.js';

interface BybitTickersApiItem {
  symbol?: string;
  lastPrice?: string;
  markPrice?: string;
  turnover24h?: string;
  price24hPcnt?: string;
}

interface BybitTickersApiResponse {
  retCode?: number;
  result?: {
    category?: string;
    list?: BybitTickersApiItem[];
  };
}

export interface BybitTickersConfig {
  baseUrl: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTicker(item: BybitTickersApiItem): BybitTicker {
  return {
    symbol: item.symbol ?? 'UNKNOWN',
    markPrice: parseOptionalNumber(item.markPrice),
    lastPrice: parseOptionalNumber(item.lastPrice),
    volume24hUsd: parseOptionalNumber(item.turnover24h),
    priceChange24hPct: parseOptionalNumber(item.price24hPcnt),
  };
}

/**
 * Fetches all linear tickers from Bybit.
 *
 * GET /v5/market/tickers?category=linear
 */
export async function fetchBybitTickers(
  config: BybitTickersConfig,
): Promise<BybitTicker[]> {
  await config.rateLimiter.acquire();

  const url = `${config.baseUrl}/v5/market/tickers?category=linear`;
  const response = await fetchJson<BybitTickersApiResponse>({
    url,
    timeoutMs: config.timeoutMs,
    fetchFn: config.fetchFn,
  });

  return (response.result?.list ?? []).map(mapTicker);
}

/**
 * Fetches a single ticker for the given symbol, or null if not found.
 */
export async function fetchBybitTicker(
  symbol: string,
  config: BybitTickersConfig,
): Promise<BybitTicker | null> {
  await config.rateLimiter.acquire();

  const url = `${config.baseUrl}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol.toUpperCase())}`;
  const response = await fetchJson<BybitTickersApiResponse>({
    url,
    timeoutMs: config.timeoutMs,
    fetchFn: config.fetchFn,
  });

  const list = response.result?.list ?? [];
  if (list.length === 0) return null;
  return mapTicker(list[0]!);
}
