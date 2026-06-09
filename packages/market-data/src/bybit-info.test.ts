import { describe, expect, it } from 'vitest';
import { fetchBybitLongShortRatio } from './bybit-info.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

describe('fetchBybitLongShortRatio', () => {
  it('normalizes long/short crowding data', async () => {
    const result = await fetchBybitLongShortRatio('BTCUSDT', {
      baseUrl: 'https://api.bybit.com',
      longShortRatioPath: '/v5/market/account-ratio',
      timeoutMs: 5_000,
      rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1_000 }),
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          result: {
            list: [
              { symbol: 'BTCUSDT', buyRatio: '0.6', sellRatio: '0.4', timestamp: '1710000000000' },
            ],
          },
        }),
      }) as Response,
    });

    expect(result).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        buyRatio: 0.6,
        sellRatio: 0.4,
      }),
    ]);
    expect(result[0]?.longShortRatio).toBeCloseTo(1.5, 5);
  });
});