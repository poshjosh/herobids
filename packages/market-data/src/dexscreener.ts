import type { TokenInfo } from './types.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

interface DexScreenerPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
  dexId?: string;
  chainId?: string;
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

export interface DexScreenerConfig {
  baseUrl: string;
  rateLimiter: TokenBucketRateLimiter;
  timeoutMs: number;
}

export async function fetchDexScreenerSearch(
  query: string,
  config: DexScreenerConfig,
): Promise<TokenInfo[]> {
  await config.rateLimiter.acquire();

  const url = `${config.baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as DexScreenerResponse;
    const pairs = data.pairs ?? [];

    return pairs.map((pair): TokenInfo => ({
      address: pair.baseToken?.address ?? '',
      symbol: pair.baseToken?.symbol ?? '',
      name: pair.baseToken?.name ?? '',
      network: pair.chainId ?? '',
      priceUsd: parseFloat(pair.priceUsd ?? '0') || 0,
      volume24hUsd: pair.volume?.h24 ?? 0,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      priceChange24hPct: pair.priceChange?.h24 ?? 0,
      dexId: pair.dexId ?? '',
    }));
  } finally {
    clearTimeout(timeout);
  }
}
