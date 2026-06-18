import { lookupCanonical } from '@herobids/market-data';
import type { TokenInfo } from '@herobids/market-data';
import type { ResolvedSwapTokenData } from './token-safety-adapter.js';

/**
 * DexScreener search result shape returned by the provider registry.
 */
interface DexScreenerSearchResult {
  data: TokenInfo[];
}

/**
 * Minimal canonical resolver used by `resolveSwapTokenData`.
 */
export interface CanonicalResolver {
  resolve(symbol: string, network: string): ReturnType<typeof lookupCanonical> | undefined;
}

/**
 * DexScreener provider used by `resolveSwapTokenData`.
 */
export interface DexScreenerProvider {
  search(address: string): Promise<DexScreenerSearchResult>;
}

/**
 * Heuristic: does `input` look like an on-chain token address rather than a
 * human-readable symbol?
 *
 * - EVM: starts with "0x" (e.g. 0xabc...def).
 * - Solana: base58 without ambiguous characters (IOl0), 32–44 chars, must
 *   contain at least one digit — guards against long all-letter strings that
 *   happen to match the length range (e.g. a 32-char ticker alias).
 *
 * False negatives are safe (we fall back to symbol search).
 * False positives are dangerous (we skip symbol matching for what looks like
 * an address).
 */
export function looksLikeTokenAddress(input: string): boolean {
  if (input.startsWith('0x')) return true;
  // Solana base58: 32–44 chars, alphanumeric (no ambiguous IOl0), ≥1 digit.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input) && /\d/.test(input)) return true;
  return false;
}

/**
 * Resolves token data for swap safety checks.
 *
 * Strategy (in priority order):
 * 1. **Canonical pinning** — operator-configured whitelist maps symbol/alias
 *    to a specific on-chain address.  Used as a fast-path override and security
 *    pin (prevent the agent from buying a scam token that shares a ticker).
 * 2. **Symbol search fallback** — when the input looks like a ticker (not an
 *    address) and isn't in the canonical list, search DexScreener by symbol,
 *    filter to the requested network, and pick the highest-liquidity match.
 *    Safety thresholds are still enforced downstream.
 * 3. **Address search** — when the input is already an on-chain address,
 *    match by exact address against DexScreener results.
 */
export async function resolveSwapTokenData(
  dexScreener: DexScreenerProvider,
  network: string,
  tokenAddress: string,
  canonicalResolver: CanonicalResolver,
): Promise<ResolvedSwapTokenData | null> {
  const canonical = canonicalResolver.resolve(tokenAddress, network);

  // ── Fast path: operator-pinned canonical override ──────────────────
  if (canonical) {
    const searchResult = await dexScreener.search(canonical.address);
    const exactMatch = searchResult.data
      .filter((token) => (
        token.network.toLowerCase() === network.toLowerCase()
        && token.address.toLowerCase() === canonical.address.toLowerCase()
      ))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];

    if (exactMatch) {
      return {
        ...exactMatch,
        ageResolution: exactMatch.poolCreatedAt ? 'available' : 'indeterminate',
        hasRealMarketData: true,
      };
    }

    return {
      address: canonical.address,
      symbol: canonical.symbol,
      name: canonical.name,
      network: network.toLowerCase(),
      priceUsd: 0,
      // Sentinels: canonical tokens are operator-whitelisted and must pass
      // safety checks regardless of real market numbers.  Use a value that
      // exceeds any plausible threshold so evaluateTokenSafety always passes.
      // Consumers must check hasRealMarketData before surfacing these to users.
      volume24hUsd: Number.MAX_SAFE_INTEGER,
      liquidityUsd: Number.MAX_SAFE_INTEGER,
      priceChange24hPct: 0,
      dexId: 'canonical',
      poolCreatedAt: '2020-01-01T00:00:00.000Z',
      ageResolution: 'available',
      isCanonical: true,
      hasRealMarketData: false,
    };
  }

  // ── Not canonical: symbol vs address resolution ───────────────────
  const isAddress = looksLikeTokenAddress(tokenAddress);
  const searchResult = await dexScreener.search(tokenAddress);

  if (isAddress) {
    // Address path: exact address match against DexScreener results.
    const exactMatch = searchResult.data
      .filter((token) => (
        token.network.toLowerCase() === network.toLowerCase()
        && token.address.toLowerCase() === tokenAddress.toLowerCase()
      ))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];

    if (!exactMatch) return null;

    return {
      ...exactMatch,
      ageResolution: exactMatch.poolCreatedAt ? 'available' : 'indeterminate',
      hasRealMarketData: true,
    };
  }

  // Symbol path: match by symbol+network, pick highest-liquidity pair.
  const symbolMatch = searchResult.data
    .filter((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.symbol.toUpperCase() === tokenAddress.toUpperCase()
    ))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];

  if (!symbolMatch) return null;

  return {
    ...symbolMatch,
    ageResolution: symbolMatch.poolCreatedAt ? 'available' : 'indeterminate',
    hasRealMarketData: true,
  };
}
