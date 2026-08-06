import type { DiscoveredPool, DiscoveredToken, PriceCandle, RequestGate } from './types.js';
import { fetchJson } from './http.js';

export interface GeckoTerminalConfig {
  baseUrl: string;
  proBaseUrl?: string;
  apiKey?: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

interface OhlcvAttributes {
  ohlcv_list?: Array<[number, string, string, string, string, string]>;
}

interface GeckoTerminalResponse {
  data?: {
    attributes?: OhlcvAttributes;
  };
}

interface GeckoTerminalResource {
  id?: string;
  type?: string;
  attributes?: {
    address?: string;
    name?: string;
    symbol?: string;
    image_url?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    price_change_percentage?: { h24?: string };
    volume_usd?: { h24?: string };
    reserve_in_usd?: string;
    pool_created_at?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
  };
}

interface GeckoTerminalPoolResponse {
  data?: GeckoTerminalResource[];
  included?: GeckoTerminalResource[];
}

function parseNumber(value: string | undefined): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function mapIncludedToken(resources: GeckoTerminalResource[] | undefined, id: string | undefined) {
  const token = resources?.find((resource) => resource.id === id);
  return {
    address: token?.attributes?.address ?? id ?? '',
    symbol: token?.attributes?.symbol ?? '',
    name: token?.attributes?.name ?? '',
  };
}

function mapPoolResource(
  network: string,
  resource: GeckoTerminalResource,
  included: GeckoTerminalResource[] | undefined,
): DiscoveredPool {
  const baseToken = mapIncludedToken(included, resource.relationships?.base_token?.data?.id);
  const quoteToken = mapIncludedToken(included, resource.relationships?.quote_token?.data?.id);
  return {
    poolAddress: resource.attributes?.address ?? resource.id ?? '',
    network,
    baseToken,
    quoteToken,
    priceUsd: parseNumber(resource.attributes?.base_token_price_usd),
    volume24hUsd: parseNumber(resource.attributes?.volume_usd?.h24),
    liquidityUsd: parseNumber(resource.attributes?.reserve_in_usd),
    poolCreatedAt: resource.attributes?.pool_created_at,
  };
}

function mapPoolsToTokens(pools: DiscoveredPool[], vector: string): DiscoveredToken[] {
  return pools.map((pool) => ({
    address: pool.baseToken.address,
    symbol: pool.baseToken.symbol,
    name: pool.baseToken.name,
    network: pool.network,
    priceUsd: pool.priceUsd,
    volume24hUsd: pool.volume24hUsd,
    liquidityUsd: pool.liquidityUsd,
    source: 'geckoterminal',
    discoveryVectors: [vector],
    poolAddress: pool.poolAddress,
    poolCreatedAt: pool.poolCreatedAt,
    pool: {
      poolAddress: pool.poolAddress,
      network: pool.network,
      baseToken: pool.baseToken,
      quoteToken: pool.quoteToken,
    },
  }));
}

function buildGeckoUrl(config: GeckoTerminalConfig, v2Path: string): string {
  const baseUrl = config.apiKey
    ? (config.proBaseUrl ?? 'https://pro-api.coingecko.com')
    : config.baseUrl;
  const path = config.apiKey
    ? v2Path.replace('/api/v2/networks/', '/api/v3/onchain/networks/')
    : v2Path;
  return `${baseUrl}${path}`;
}

function buildGeckoHeaders(config: GeckoTerminalConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.apiKey) {
    headers['x-cg-pro-api-key'] = config.apiKey;
  }
  return headers;
}

async function fetchPools(
  network: string,
  path: string,
  vector: string,
  config: GeckoTerminalConfig,
): Promise<DiscoveredToken[]> {
  await config.rateLimiter.acquire();

  const response = await fetchJson<GeckoTerminalPoolResponse>({
    url: buildGeckoUrl(config, path),
    timeoutMs: config.timeoutMs,
    headers: buildGeckoHeaders(config),
    fetchFn: config.fetchFn,
  });

  const pools = (response.data ?? []).map((resource) => mapPoolResource(network, resource, response.included));
  return mapPoolsToTokens(pools, vector);
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

  const v2Path = `/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${timeframe}?limit=${limit}`;

  const data = await fetchJson<GeckoTerminalResponse>({
    url: buildGeckoUrl(config, v2Path),
    timeoutMs: config.timeoutMs,
    headers: buildGeckoHeaders(config),
    fetchFn: config.fetchFn,
  });
  const ohlcvList = data.data?.attributes?.ohlcv_list ?? [];

  return ohlcvList.map((item): PriceCandle => ({
    timestamp: new Date(item[0] * 1000).toISOString(),
    open: parseFloat(item[1]),
    high: parseFloat(item[2]),
    low: parseFloat(item[3]),
    close: parseFloat(item[4]),
    volume: parseFloat(item[5]),
  }));
}

export async function fetchGeckoTerminalTrendingPools(
  network: string,
  config: GeckoTerminalConfig,
  page = 1,
): Promise<DiscoveredToken[]> {
  const pageParam = page > 1 ? `?page=${page}` : '';
  return fetchPools(
    network,
    `/api/v2/networks/${encodeURIComponent(network)}/trending_pools${pageParam}`,
    page > 1 ? `trending_pools_p${page}` : 'trending_pools',
    config,
  );
}

export async function fetchGeckoTerminalTopPools(
  network: string,
  config: GeckoTerminalConfig,
  page = 1,
): Promise<DiscoveredToken[]> {
  const pageParam = page > 1 ? `&page=${page}` : '';
  return fetchPools(
    network,
    `/api/v2/networks/${encodeURIComponent(network)}/pools?sort=h24_volume_usd_desc${pageParam}`,
    page > 1 ? `top_pools_p${page}` : 'top_pools',
    config,
  );
}

export async function fetchGeckoTerminalNewPools(
  network: string,
  config: GeckoTerminalConfig,
): Promise<DiscoveredToken[]> {
  return fetchPools(
    network,
    `/api/v2/networks/${encodeURIComponent(network)}/new_pools`,
    'new_pools',
    config,
  );
}

/**
 * Validate that the GeckoTerminal Pro API key is usable by making a lightweight
 * health-check call to the Pro on-chain endpoint. Throws if the key is invalid
 * or the endpoint is unreachable, matching the CMC/Birdeye pattern of failing
 * loudly at startup when a paid provider is misconfigured.
 */
export async function validateApiKey(config: {
  apiKey: string;
  proBaseUrl?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const baseUrl = config.proBaseUrl ?? 'https://pro-api.coingecko.com';
  const url = `${baseUrl}/api/v3/onchain/networks/solana/trending_pools`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await (config.fetchFn ?? fetch)(url, {
      headers: {
        Accept: 'application/json',
        'x-cg-pro-api-key': config.apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `GeckoTerminal Pro API key is invalid or the endpoint is unreachable (HTTP ${response.status}). ` +
        `Verify the apiKey in your config.`,
      );
    }

    // Consume the body to avoid leaking connections
    await response.text().catch(() => {});
  } finally {
    clearTimeout(timeout);
  }
}
