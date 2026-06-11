import type { TokenInfo, TokenSearchCandidate, TokenSearchPolicyOptions, MarketDataConfig } from './types.js';
import { fetchDexScreenerSearch, type DexScreenerConfig } from './dexscreener.js';
import {
  resolveTokenSafetyPolicyConfig,
  deduplicateByAddress,
  rankAndFilterCandidates,
  type TokenSafetyPolicyConfig,
} from './token-safety.js';

export interface SearchTokensOptions {
  network?: string;
  minLiquidityUsd?: number;
  limit?: number;
}

/**
 * Search tokens via DexScreener with filtering and sorting.
 * - Filters out results below minLiquidityUsd (default: $10k)
 * - Optionally filters by network
 * - Sorts by liquidity descending
 * - Returns top `limit` results (default: 10)
 */
export async function searchTokens(
  query: string,
  config: DexScreenerConfig,
  options?: SearchTokensOptions,
): Promise<TokenInfo[]> {
  const minLiquidity = options?.minLiquidityUsd ?? 10_000;
  const limit = options?.limit ?? 10;
  const network = options?.network;

  const rawResults = await fetchDexScreenerSearch(query, config);

  let filtered = rawResults.filter((t) => t.liquidityUsd >= minLiquidity);

  if (network) {
    const networkLower = network.toLowerCase();
    filtered = filtered.filter((t) => t.network.toLowerCase() === networkLower);
  }

  // Sort by liquidity descending
  filtered.sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  // Deduplicate by address + network (same token can appear in multiple pools)
  const seen = new Set<string>();
  const deduped: TokenInfo[] = [];
  for (const token of filtered) {
    const key = `${token.network}:${token.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(token);
  }

  return deduped.slice(0, limit);
}

/**
 * Search tokens with full safety policy evaluation, canonical promotion,
 * and structured safety metadata.
 */
export async function searchTokensWithPolicy(
  query: string,
  config: DexScreenerConfig,
  marketDataConfig: MarketDataConfig,
  options?: TokenSearchPolicyOptions,
): Promise<TokenSearchCandidate[]> {
  const rawResults = await fetchDexScreenerSearch(query, config);

  return applyTokenSearchPolicy(rawResults, marketDataConfig, options);
}

export function applyTokenSearchPolicy(
  rawResults: TokenInfo[],
  marketDataConfig: MarketDataConfig,
  options?: TokenSearchPolicyOptions,
): TokenSearchCandidate[] {
  const policy: TokenSafetyPolicyConfig = resolveTokenSafetyPolicyConfig(marketDataConfig);

  // Network filter
  let filtered: TokenInfo[] = rawResults;
  if (options?.network) {
    const networkLower = options.network.toLowerCase();
    filtered = filtered.filter((t) => t.network.toLowerCase() === networkLower);
  }

  // Deduplicate by network:address
  const deduped = deduplicateByAddress(filtered);

  // Evaluate, rank, filter
  return rankAndFilterCandidates(deduped, policy, options);
}

