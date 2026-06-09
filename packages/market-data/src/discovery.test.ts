import { afterEach, describe, expect, it } from 'vitest';
import { discoverTokens } from './discovery.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('discoverTokens', () => {
  it('merges provider results, deduplicates by network+address, and keeps discovery vectors', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts/top')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'token-1', amount: 100 }],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'token-1', totalAmount: 150 }],
        } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [{ chainId: 'base', tokenAddress: 'token-2', description: 'Base token' }],
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [
            {
              id: 'pool-1',
              attributes: {
                address: 'pool-1',
                base_token_price_usd: '1.5',
                volume_usd: { h24: '10000' },
                reserve_in_usd: '20000',
                pool_created_at: '2026-06-08T00:00:00.000Z',
              },
              relationships: {
                base_token: { data: { id: 'base-token-1' } },
                quote_token: { data: { id: 'quote-token-1' } },
              },
            },
          ],
          included: [
            { id: 'base-token-1', attributes: { address: 'token-1', symbol: 'TOK', name: 'Token One' } },
            { id: 'quote-token-1', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: {
        baseUrl: 'https://api.dexscreener.com',
        timeoutMs: 5_000,
        rateLimiter,
      },
      geckoterminal: {
        baseUrl: 'https://api.geckoterminal.com',
        timeoutMs: 5_000,
        rateLimiter,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
      maxResults: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('token-1');
    expect(result[0]?.discoveryVectors).toEqual(expect.arrayContaining(['boosts_top', 'boosts_latest', 'trending_pools', 'top_pools', 'new_pools']));
    expect(result[0]?.liquidityUsd).toBe(20000);
  });

  it('filters out discovery items with unknown liquidity', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts/top')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'token-1', amount: 100 }],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [],
        } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [],
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [], included: [] }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: {
        baseUrl: 'https://api.dexscreener.com',
        timeoutMs: 5_000,
        rateLimiter,
      },
      geckoterminal: {
        baseUrl: 'https://api.geckoterminal.com',
        timeoutMs: 5_000,
        rateLimiter,
      },
      networks: ['solana'],
      minLiquidityUsd: 1,
    });

    expect(result).toEqual([]);
  });
});