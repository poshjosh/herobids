import type { ProviderDefinition } from '@herobids/domain';

/**
 * Derives a venueType map from the provider catalog response.
 * Prefer this over the hardcoded VENUE_TYPE_MAP for provider-driven data.
 */
export function buildVenueTypeMap(providers: readonly ProviderDefinition[]): Record<string, '' | 'orderbook' | 'swap'> {
  const map: Record<string, '' | 'orderbook' | 'swap'> = {};
  for (const provider of providers) {
    if (provider.venueType === 'orderbook' || provider.venueType === 'swap') {
      map[provider.id] = provider.venueType;
    }
  }
  return map;
}

/**
 * @deprecated Use buildVenueTypeMap() with provider catalog data instead.
 * Hardcoded fallback for when the provider catalog is unavailable.
 */
export const VENUE_TYPE_MAP: Record<string, '' | 'orderbook' | 'swap'> = {
  hyperliquid: 'orderbook',
  jupiter: 'swap',
  bybit: 'orderbook',
  '1inch': 'swap',
};
