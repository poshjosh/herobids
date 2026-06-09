import type { DiscoveredToken, RequestGate } from './types.js';
import { fetchJson } from './http.js';

export interface CoinMarketCapConfig {
  baseUrl: string;
  apiKey: string;
  discoveryRateLimiter: RequestGate;
  enrichmentRateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

// Maps herobids network names to CMC platform slugs.
// Networks absent from this map are unsupported — discovery returns [] rather than throwing.
const NETWORK_TO_CMC_SLUG: Record<string, string> = {
  solana: 'solana',
  base: 'base',
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  avalanche: 'avalanche-c-chain',
};

const CMC_SLUG_TO_NETWORK = Object.fromEntries(
  Object.entries(NETWORK_TO_CMC_SLUG).map(([network, slug]) => [slug, network]),
) as Record<string, string>;

interface CmcCoin {
  id?: number;
  name?: string;
  symbol?: string;
  slug?: string;
  cmc_rank?: number;
  num_market_pairs?: number;
  platform?: {
    slug?: string;
    token_address?: string;
  } | null;
  quote?: {
    USD?: {
      price?: number;
      volume_24h?: number;
      market_cap?: number;
      fully_diluted_market_cap?: number;
      percent_change_24h?: number;
    };
  };
}

// Derives a three-tier risk level from available CMC signals.
// Market cap is the primary signal; undefined cap defaults to 'high'.
function deriveRiskLevel(marketCapUsd: number | undefined): 'low' | 'medium' | 'high' {
  if (!marketCapUsd || marketCapUsd < 1_000_000) return 'high';
  if (marketCapUsd < 50_000_000) return 'medium';
  return 'low';
}

function normalizeAddress(address: string | undefined): string {
  return address?.trim().toLowerCase() ?? '';
}

function resolveCandidateNetwork(coin: CmcCoin): string | undefined {
  const platformSlug = coin.platform?.slug;
  return platformSlug ? CMC_SLUG_TO_NETWORK[platformSlug] : undefined;
}

function resolveQuoteMatch(token: DiscoveredToken, candidates: CmcCoin[] | undefined): CmcCoin | undefined {
  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  const normalizedTokenAddress = normalizeAddress(token.address);
  const exactMatch = candidates.find((candidate) => (
    resolveCandidateNetwork(candidate) === token.network
      && normalizeAddress(candidate.platform?.token_address) === normalizedTokenAddress
  ));
  if (exactMatch) {
    return exactMatch;
  }

  return undefined;
}

interface CmcListResponse {
  data?: CmcCoin[];
}

interface CmcQuotesResponse {
  data?: Record<string, CmcCoin[]>;
}

function cmcHeaders(apiKey: string): Record<string, string> {
  return { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' };
}

// Returns only coins whose platform slug matches one of the requested networks.
// Each entry carries the resolved herobids network name.
function filterByNetworks(
  coins: CmcCoin[],
  networks: string[],
): Array<{ coin: CmcCoin; network: string; tokenAddress: string }> {
  const allowedSlugs = new Set(
    networks.map((n) => NETWORK_TO_CMC_SLUG[n]).filter((s): s is string => s !== undefined),
  );
  const result: Array<{ coin: CmcCoin; network: string; tokenAddress: string }> = [];
  for (const coin of coins) {
    const platformSlug = coin.platform?.slug;
    const tokenAddress = coin.platform?.token_address?.trim();
    if (!platformSlug || !allowedSlugs.has(platformSlug) || !tokenAddress) continue;
    const network = networks.find((n) => NETWORK_TO_CMC_SLUG[n] === platformSlug);
    if (network) result.push({ coin, network, tokenAddress });
  }
  return result;
}

function mapCmcCoin(coin: CmcCoin, network: string, tokenAddress: string, vector: string): DiscoveredToken {
  const marketCapUsd = coin.quote?.USD?.market_cap;
  return {
    address: tokenAddress,
    symbol: coin.symbol ?? '',
    name: coin.name ?? '',
    network,
    priceUsd: coin.quote?.USD?.price ?? 0,
    volume24hUsd: coin.quote?.USD?.volume_24h ?? 0,
    liquidityUsd: 0,
    priceChange24hPct: coin.quote?.USD?.percent_change_24h,
    source: 'coinmarketcap',
    discoveryVectors: [vector],
    marketCapUsd,
    fullyDilutedValuationUsd: coin.quote?.USD?.fully_diluted_market_cap,
    cexListings: coin.num_market_pairs,
    riskLevel: deriveRiskLevel(marketCapUsd),
  };
}

/**
 * Fetches currently trending tokens from CMC.
 * Returns [] if none of the requested networks are supported by CMC.
 */
export async function fetchCmcTrending(
  networks: string[],
  config: CoinMarketCapConfig,
): Promise<DiscoveredToken[]> {
  const hasSupportedNetwork = networks.some((n) => NETWORK_TO_CMC_SLUG[n] !== undefined);
  if (!hasSupportedNetwork) return [];

  await config.discoveryRateLimiter.acquire();

  const data = await fetchJson<CmcListResponse>({
    url: `${config.baseUrl}/v1/cryptocurrency/trending/latest`,
    timeoutMs: config.timeoutMs,
    headers: cmcHeaders(config.apiKey),
    fetchFn: config.fetchFn,
  });

  return filterByNetworks(data.data ?? [], networks).map(({ coin, network, tokenAddress }) =>
    mapCmcCoin(coin, network, tokenAddress, 'cmc_trending'),
  );
}

/**
 * Fetches recently listed tokens from CMC.
 * Returns [] if none of the requested networks are supported by CMC.
 */
export async function fetchCmcNewListings(
  networks: string[],
  config: CoinMarketCapConfig,
): Promise<DiscoveredToken[]> {
  const hasSupportedNetwork = networks.some((n) => NETWORK_TO_CMC_SLUG[n] !== undefined);
  if (!hasSupportedNetwork) return [];

  await config.discoveryRateLimiter.acquire();

  const data = await fetchJson<CmcListResponse>({
    url: `${config.baseUrl}/v1/cryptocurrency/listings/new`,
    timeoutMs: config.timeoutMs,
    headers: cmcHeaders(config.apiKey),
    fetchFn: config.fetchFn,
  });

  return filterByNetworks(data.data ?? [], networks).map(({ coin, network, tokenAddress }) =>
    mapCmcCoin(coin, network, tokenAddress, 'cmc_new_listings'),
  );
}

/**
 * Enriches an already-discovered token list with CMC market data in a single batch call.
 *
 * Looks up each token by symbol. When a symbol resolves to multiple CMC entries the first
 * is used. Tokens with no CMC match are returned unchanged.
 * Capped to one request per invocation regardless of how many tokens are passed.
 */
export async function enrichWithCmc(
  tokens: DiscoveredToken[],
  config: CoinMarketCapConfig,
): Promise<DiscoveredToken[]> {
  if (tokens.length === 0) return tokens;

  const symbols = [...new Set(tokens.map((t) => t.symbol).filter((s) => s.length > 0))];
  if (symbols.length === 0) return tokens;

  await config.enrichmentRateLimiter.acquire();

  const data = await fetchJson<CmcQuotesResponse>({
    url: `${config.baseUrl}/v1/cryptocurrency/quotes/latest?symbol=${symbols.join(',')}&convert=USD`,
    timeoutMs: config.timeoutMs,
    headers: cmcHeaders(config.apiKey),
    fetchFn: config.fetchFn,
  });

  const quoteMap = new Map<string, CmcCoin[]>();
  for (const [symbol, coins] of Object.entries(data.data ?? {})) {
    if (coins.length > 0) {
      quoteMap.set(symbol.toUpperCase(), coins);
    }
  }

  return tokens.map((token) => {
    const cmcCoin = resolveQuoteMatch(token, quoteMap.get(token.symbol.toUpperCase()));
    if (!cmcCoin) return token;
    const marketCapUsd = cmcCoin.quote?.USD?.market_cap ?? token.marketCapUsd;
    return {
      ...token,
      marketCapUsd,
      fullyDilutedValuationUsd:
        cmcCoin.quote?.USD?.fully_diluted_market_cap ?? token.fullyDilutedValuationUsd,
      cexListings: cmcCoin.num_market_pairs ?? token.cexListings,
      riskLevel: deriveRiskLevel(marketCapUsd),
    };
  });
}
