import { describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '@herobids/market-data';
import { executeDiscoverTokensTool, executeFundingRatesTool, executeMarketOverviewTool } from './intelligence-tools.js';

function buildRegistry(): ProviderRegistry {
  return {
    discovery: {
      discover: vi.fn().mockResolvedValue({
        data: [{ symbol: 'BONK', network: 'solana', discoveryVectors: ['trending'] }],
        meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'aggregated-discovery' },
      }),
    },
    hyperliquid: {
      assetContexts: vi.fn().mockResolvedValue({
        data: [
          {
            asset: 'BTC',
            fundingRate: 0.0001,
            annualizedFundingRatePct: 10,
            openInterest: 1000,
            markPrice: 67000,
            oraclePrice: 66990,
            volume24hUsd: 1000000,
            priceChange24hPct: 2.5,
          },
        ],
        meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'hyperliquid' },
      }),
    },
    bybit: {
      longShortRatio: vi.fn().mockResolvedValue({
        data: [{ longShortRatio: 1.2 }],
        meta: { freshness: { isStale: false, ageMs: 0 }, provider: 'bybit' },
      }),
    },
  } as unknown as ProviderRegistry;
}

describe('intelligence tools', () => {
  it('returns representative payloads for discover_tokens', async () => {
    const onAttempt = vi.fn();
    const result = await executeDiscoverTokensTool(buildRegistry(), { network: 'solana', limit: 5 }, { onAttempt });

    expect(onAttempt).toHaveBeenCalledWith('aggregated-discovery');
    expect(result).toMatchObject({
      ok: true,
      tokens: [expect.objectContaining({ symbol: 'BONK', network: 'solana' })],
    });
  });

  it('returns representative payloads for get_funding_rates', async () => {
    const onAttempt = vi.fn();
    const result = await executeFundingRatesTool(buildRegistry(), { symbols: ['BTC'] }, { onAttempt });

    expect(onAttempt).toHaveBeenCalledWith('hyperliquid');
    expect(result).toMatchObject({
      ok: true,
      assets: [expect.objectContaining({ symbol: 'BTC', fundingAnnualizedPct: 10, openInterest: 1000 })],
    });
  });

  it('returns representative payloads for get_market_overview', async () => {
    const onAttempt = vi.fn();
    const result = await executeMarketOverviewTool(buildRegistry(), { venue: 'bybit', symbols: ['BTC'] }, { onAttempt });

    expect(onAttempt).toHaveBeenCalledWith('hyperliquid');
    expect(onAttempt).toHaveBeenCalledWith('bybit');
    expect(result).toMatchObject({
      ok: true,
      overview: [expect.objectContaining({ symbol: 'BTC', price: 67000, longShortRatio: 1.2 })],
    });
  });
});