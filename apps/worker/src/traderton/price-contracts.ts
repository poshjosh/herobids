// Worker-local price contracts consumed by the hybrid USD-to-base-size path.
//
// Copied VERBATIM (byte-faithful, declarations only) from the deleted local
// package `packages/market-data/src/price-service.ts` (Slice 4 Plan B, ruling:
// amended Option A — narrow consumer-side type seams; copy sources cited).
// Type-only seam: no price service implementation, no provider calls — the
// runtime path remains the Traderton `resolve_price_target` REST boundary
// (see `traderton/hybrid-price-adapter.ts`).

export type PriceSource = 'execution' | 'oracle' | 'cached';

export interface PriceLookupResult {
  priceUsd: number;
  source: PriceSource;
  fetchedAt: string;
  stale: boolean;
}

export interface PriceLookupError {
  code: string;
  message: string;
}

export type PriceResult =
  | { ok: true; data: PriceLookupResult }
  | { ok: false; error: PriceLookupError };

/**
 * Identity + price snapshot returned by the resolver.
 *
 * `symbol` and `chain` represent the **resolved** (effective) identity —
 * the concrete asset the resolver selected, not necessarily what the caller
 * requested.  Use these fields for stable repricing.
 *
 * `address` is the pinned token address when available.  When present,
 * repricing should supply it for exact-identity lookups.
 *
 * `name` is the human-readable token name from the data source (may be
 * absent for some providers).
 */
export interface ResolvedPriceTarget {
  symbol: string;
  chain: string;
  address?: string;
  name?: string;
  priceUsd: number;
  source: PriceSource;
  fetchedAt: string;
  stale: boolean;
}

export type ResolvePriceTargetResult =
  | { ok: true; data: ResolvedPriceTarget }
  | { ok: false; error: PriceLookupError };

export interface PriceService {
  getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult>;
  resolvePriceTarget(symbol: string, chain: string, address?: string): Promise<ResolvePriceTargetResult>;
}
