import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { providerCatalog as providerCatalogApi } from '../../lib/api-client.js';
import type { ProviderDefinition } from '@herobids/domain';
import { buildVenueTypeMap, VENUE_TYPE_MAP } from './venue-mapping.js';

export interface TradingVenuesResult {
  /** Map of venue id → venue type ('orderbook' | 'swap' | '') */
  venueTypeMap: Record<string, '' | 'orderbook' | 'swap'>;
  /** Sorted list of trading venue ids (all providers with a venueType) */
  tradingVenues: string[];
  /** Full provider definitions for trading venues */
  tradingProviders: ProviderDefinition[];
  isLoading: boolean;
}

/**
 * Shared hook for dynamically resolving trading venues from the provider catalog.
 * Use this instead of hardcoded venue lists so the UI stays in sync with the
 * backend when venues are added or removed.
 *
 * Cached via React Query (staleTime: 1h, gcTime: 30min) — no extra caching needed.
 */
export function useTradingVenues(): TradingVenuesResult {
  const { data, isLoading } = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
    staleTime: 60 * 60 * 1000, // 1 hour — providers rarely change
    gcTime: 30 * 60 * 1000, // 30 min — survive page navigation
  });

  const venueTypeMap = useMemo(() => {
    if (!data?.providers) return VENUE_TYPE_MAP;
    return buildVenueTypeMap(data.providers);
  }, [data]);

  const tradingProviders = useMemo(() => {
    if (!data?.providers) return [];
    return data.providers.filter(
      (p) => p.venueType === 'orderbook' || p.venueType === 'swap',
    );
  }, [data]);

  const tradingVenues = useMemo(
    () => Object.keys(venueTypeMap).sort(),
    [venueTypeMap],
  );

  return { venueTypeMap, tradingVenues, tradingProviders, isLoading };
}
