import { describe, expect, it } from 'vitest';
import { fetchHyperliquidAssetContexts } from './hyperliquid-info.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

describe('fetchHyperliquidAssetContexts', () => {
  it('normalizes funding, OI, spread, and 24h change', async () => {
    const result = await fetchHyperliquidAssetContexts({
      baseUrl: 'https://api.hyperliquid.xyz',
      intelligencePath: '/info',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ([
          { universe: [{ name: 'BTC' }] },
          [{ funding: '0.00005', openInterest: '1200', markPx: '105', midPx: '104.5', oraclePx: '100', dayNtlVlm: '500000', prevDayPx: '95' }],
        ]),
      }) as Response,
    });

    expect(result).toEqual([
      expect.objectContaining({
        asset: 'BTC',
        fundingRate: 0.00005,
        openInterest: 1200,
        markPrice: 105,
        oraclePrice: 100,
      }),
    ]);
    expect(result[0]?.markOracleSpreadPct).toBeCloseTo(5, 5);
    expect(result[0]?.priceChange24hPct).toBeCloseTo(((105 - 95) / 95) * 100, 5);
  });
});