import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverTokens } from './discovery.js';
import type { DiscoverySeenTracker } from './discovery-seen-tracker.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: status === 500 ? 'Internal Server Error' : 'Bad Request',
    json: async () => ({ success: false, message: 'Error' }),
  } as Response;
}

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

  it('includes CMC fan-out tokens when coinmarketcap config is provided', async () => {
    let cmcDiscoveryCalls = 0;
    let cmcEnrichmentCalls = 0;

    globalThis.fetch = async (input) => {
      const url = String(input);
      // CMC discovery (trending + new_listings)
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        cmcDiscoveryCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{
              id: 1,
              name: 'CMCToken',
              symbol: 'CMCT',
              num_market_pairs: 5,
              platform: { slug: 'solana', token_address: 'cmc-addr-1' },
              quote: { USD: { price: 3.0, volume_24h: 80_000, market_cap: 1_000_000, fully_diluted_market_cap: 2_000_000, percent_change_24h: 1.0 } },
            }],
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        cmcDiscoveryCalls += 1;
        return {
          ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }),
        } as Response;
      }
      // CMC enrichment
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        cmcEnrichmentCalls += 1;
        return {
          ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }),
        } as Response;
      }
      // DexScreener — return empty
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    const token = result.find((t) => t.address === 'cmc-addr-1');
    expect(token).toBeDefined();
    expect(token?.liquidityUsd).toBe(0);
    expect(token?.discoveryVectors).toEqual(expect.arrayContaining(['cmc_trending']));
    expect(cmcDiscoveryCalls).toBe(2); // trending + new_listings
    expect(cmcEnrichmentCalls).toBe(1); // one enrichment batch call after merge
  });

  it('filters out CMC-only tokens when the minimum liquidity threshold is above zero', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{
              name: 'CMCOnly',
              symbol: 'CMO',
              num_market_pairs: 4,
              platform: { slug: 'solana', token_address: 'cmc-only-addr' },
              quote: { USD: { price: 1.5, volume_24h: 500, market_cap: 5_000_000 } },
            }],
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }) } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
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
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 1,
    });

    expect(result).toEqual([]);
  });

  it('does not let CMC market cap override real pool liquidity during merge', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{
              name: 'MergeToken',
              symbol: 'MERGE',
              num_market_pairs: 2,
              platform: { slug: 'solana', token_address: 'merge-addr' },
              quote: { USD: { price: 3.0, volume_24h: 80_000, market_cap: 1_000_000 } },
            }],
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }) } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-merge',
            attributes: { address: 'pool-merge', base_token_price_usd: '3.0', volume_usd: { h24: '10000' }, reserve_in_usd: '1000' },
            relationships: { base_token: { data: { id: 'bt-merge' } }, quote_token: { data: { id: 'qt-merge' } } },
          }],
          included: [
            { id: 'bt-merge', attributes: { address: 'merge-addr', symbol: 'MERGE', name: 'MergeToken' } },
            { id: 'qt-merge', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    const token = result.find((entry) => entry.address === 'merge-addr');
    expect(token?.liquidityUsd).toBe(1000);
    expect(token?.source).toBe('geckoterminal');
    expect(token?.discoveryVectors).toEqual(expect.arrayContaining(['cmc_trending', 'trending_pools', 'top_pools', 'new_pools']));
  });

  it('keeps a CMC-only token in the final slice ahead of lower-scoring pool results', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{
              name: 'CMCOnly',
              symbol: 'CMO',
              num_market_pairs: 4,
              platform: { slug: 'solana', token_address: 'cmc-only-addr' },
              quote: { USD: { price: 1.5, volume_24h: 500, market_cap: 5_000_000 } },
            }],
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }) } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-low',
            attributes: { address: 'pool-low', base_token_price_usd: '1.0', volume_usd: { h24: '1000' }, reserve_in_usd: '50000' },
            relationships: { base_token: { data: { id: 'bt-low' } }, quote_token: { data: { id: 'qt-low' } } },
          }],
          included: [
            { id: 'bt-low', attributes: { address: 'low-addr', symbol: 'LOW', name: 'LowToken' } },
            { id: 'qt-low', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      maxResults: 1,
      minLiquidityUsd: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('cmc-only-addr');
    expect(result[0]?.source).toBe('coinmarketcap');
  });

  it('keeps CMC-only tokens in a crowded mixed-provider result set', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [
              {
                name: 'CMCAlpha',
                symbol: 'ALP',
                num_market_pairs: 4,
                platform: { slug: 'solana', token_address: 'cmc-alpha' },
                quote: { USD: { price: 1.0, volume_24h: 500, market_cap: 5_000_000 } },
              },
              {
                name: 'CmcBeta',
                symbol: 'BET',
                num_market_pairs: 2,
                platform: { slug: 'solana', token_address: 'cmc-beta' },
                quote: { USD: { price: 1.0, volume_24h: 400, market_cap: 4_000_000 } },
              },
            ],
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }) } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [
            {
              id: 'pool-high',
              attributes: { address: 'pool-high', base_token_price_usd: '1.0', volume_usd: { h24: '90000' }, reserve_in_usd: '90000' },
              relationships: { base_token: { data: { id: 'bt-high' } }, quote_token: { data: { id: 'qt-high' } } },
            },
            {
              id: 'pool-mid',
              attributes: { address: 'pool-mid', base_token_price_usd: '1.0', volume_usd: { h24: '80000' }, reserve_in_usd: '80000' },
              relationships: { base_token: { data: { id: 'bt-mid' } }, quote_token: { data: { id: 'qt-mid' } } },
            },
          ],
          included: [
            { id: 'bt-high', attributes: { address: 'pool-high-addr', symbol: 'HIGH', name: 'HighPool' } },
            { id: 'qt-high', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            { id: 'bt-mid', attributes: { address: 'pool-mid-addr', symbol: 'MID', name: 'MidPool' } },
            { id: 'qt-mid', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      maxResults: 3,
      minLiquidityUsd: 0,
    });

    expect(result).toHaveLength(3);
    expect(result.map((token) => token.address)).toEqual(['cmc-alpha', 'cmc-beta', 'pool-high-addr']);
  });

  it('keeps successful network enrichment when a later CMC slice fails', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [
              {
                name: 'SolToken',
                symbol: 'SOLA',
                num_market_pairs: 3,
                platform: { slug: 'solana', token_address: 'sol-addr' },
                quote: { USD: { price: 1.0, volume_24h: 10_000, market_cap: 2_000_000 } },
              },
              {
                name: 'BaseToken',
                symbol: 'BASE',
                num_market_pairs: 7,
                platform: { slug: 'base', token_address: 'base-addr' },
                quote: { USD: { price: 2.0, volume_24h: 20_000, market_cap: 3_000_000 } },
              },
            ],
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('symbol=SOLA')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ data: { SOLA: [{ symbol: 'SOLA', platform: { slug: 'solana', token_address: 'sol-addr' }, quote: { USD: { market_cap: 2_500_000 } } }] } }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('symbol=BASE')) {
        throw new Error('CMC slice failed');
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana', 'base'],
      minLiquidityUsd: 0,
    });

    const solToken = result.find((token) => token.address === 'sol-addr');
    const baseToken = result.find((token) => token.address === 'base-addr');
    expect(solToken?.marketCapUsd).toBe(2_500_000);
    expect(baseToken?.marketCapUsd).toBe(3_000_000);
  });

  it('runs the enrichment pass after merge and attaches CMC metadata', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'addr-enrich', amount: 100 }],
        } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: { ENRICH: [{ symbol: 'ENRICH', platform: { slug: 'solana', token_address: 'addr-enrich' }, num_market_pairs: 99, quote: { USD: { market_cap: 9_000_000 } } }] },
          }),
        } as Response;
      }
      if (url.includes('coinmarketcap.com')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // GeckoTerminal pool response to give the token some liquidity
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-enrich',
            attributes: { address: 'pool-enrich', base_token_price_usd: '1.0', volume_usd: { h24: '200000' }, reserve_in_usd: '500000' },
            relationships: { base_token: { data: { id: 'bt-1' } }, quote_token: { data: { id: 'qt-1' } } },
          }],
          included: [
            { id: 'bt-1', attributes: { address: 'addr-enrich', symbol: 'ENRICH', name: 'EnrichToken' } },
            { id: 'qt-1', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    const enriched = result.find((t) => t.symbol === 'ENRICH');
    expect(enriched).toBeDefined();
    expect(enriched?.marketCapUsd).toBe(9_000_000);
    expect(enriched?.cexListings).toBe(99);
  });

  it('does not bleed CMC enrichment metadata from one token to a same-network same-symbol token with a different address', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            // Only tok-a is in CMC; tok-b has the same symbol on the same network but must not receive the metadata
            data: { TWIN: [{ symbol: 'TWIN', platform: { slug: 'solana', token_address: 'tok-a' }, quote: { USD: { market_cap: 8_000_000 } } }] },
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [
            {
              id: 'pool-a',
              attributes: { address: 'pool-a', base_token_price_usd: '1.0', volume_usd: { h24: '100000' }, reserve_in_usd: '200000' },
              relationships: { base_token: { data: { id: 'bt-a' } }, quote_token: { data: { id: 'qt-a' } } },
            },
            {
              id: 'pool-b',
              attributes: { address: 'pool-b', base_token_price_usd: '1.0', volume_usd: { h24: '90000' }, reserve_in_usd: '180000' },
              relationships: { base_token: { data: { id: 'bt-b' } }, quote_token: { data: { id: 'qt-b' } } },
            },
          ],
          included: [
            { id: 'bt-a', attributes: { address: 'tok-a', symbol: 'TWIN', name: 'TwinA' } },
            { id: 'qt-a', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            { id: 'bt-b', attributes: { address: 'tok-b', symbol: 'TWIN', name: 'TwinB' } },
            { id: 'qt-b', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    const tokA = result.find((t) => t.address === 'tok-a');
    const tokB = result.find((t) => t.address === 'tok-b');
    expect(tokA?.marketCapUsd).toBe(8_000_000);
    expect(tokB?.marketCapUsd).toBeUndefined();
  });

  it('returns results from other providers when CMC discovery fails', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com')) {
        throw new Error('CMC is down');
      }
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'fallback-addr', amount: 50 }],
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // GeckoTerminal gives liquidity so the token passes the filter
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-fb',
            attributes: { address: 'pool-fb', base_token_price_usd: '1.0', volume_usd: { h24: '100000' }, reserve_in_usd: '200000' },
            relationships: { base_token: { data: { id: 'bt-fb' } }, quote_token: { data: { id: 'qt-fb' } } },
          }],
          included: [
            { id: 'bt-fb', attributes: { address: 'fallback-addr', symbol: 'FALL', name: 'FallbackToken' } },
            { id: 'qt-fb', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    // Discovery continues and returns non-CMC results despite CMC being down
    expect(result.some((t) => t.address === 'fallback-addr')).toBe(true);
  });

  it('returns results unchanged when CMC enrichment fails', async () => {
    let enrichmentCalls = 0;

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        enrichmentCalls += 1;
        throw new Error('CMC enrichment down');
      }
      if (url.includes('coinmarketcap.com')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-safe',
            attributes: { address: 'pool-safe', base_token_price_usd: '1.0', volume_usd: { h24: '100000' }, reserve_in_usd: '200000' },
            relationships: { base_token: { data: { id: 'bt-s' } }, quote_token: { data: { id: 'qt-s' } } },
          }],
          included: [
            { id: 'bt-s', attributes: { address: 'safe-addr', symbol: 'SAFE', name: 'SafeToken' } },
            { id: 'qt-s', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    // Discovery result is returned even though enrichment threw
    expect(result.some((t) => t.address === 'safe-addr')).toBe(true);
    expect(enrichmentCalls).toBe(1); // enrichment was attempted
    // No CMC enrichment fields set since enrichment failed
    const token = result.find((t) => t.address === 'safe-addr');
    expect(token?.marketCapUsd).toBeUndefined();
  });

  it('does not bleed CMC enrichment metadata from one token to a same-network same-symbol token with a different address', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com') && url.includes('trending')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('listings/new')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [] }) } as Response;
      }
      if (url.includes('coinmarketcap.com') && url.includes('quotes/latest')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            // CMC knows only tok-a. tok-b shares the same symbol on the same network
            // but has a different on-chain address and must receive no enrichment.
            data: { TWIN: [{ symbol: 'TWIN', platform: { slug: 'solana', token_address: 'tok-a' }, quote: { USD: { market_cap: 8_000_000 } } }] },
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [
            {
              id: 'pool-a',
              attributes: { address: 'pool-a', base_token_price_usd: '1.0', volume_usd: { h24: '100000' }, reserve_in_usd: '200000' },
              relationships: { base_token: { data: { id: 'bt-a' } }, quote_token: { data: { id: 'qt-a' } } },
            },
            {
              id: 'pool-b',
              attributes: { address: 'pool-b', base_token_price_usd: '1.0', volume_usd: { h24: '90000' }, reserve_in_usd: '180000' },
              relationships: { base_token: { data: { id: 'bt-b' } }, quote_token: { data: { id: 'qt-b' } } },
            },
          ],
          included: [
            { id: 'bt-a', attributes: { address: 'tok-a', symbol: 'TWIN', name: 'TwinA' } },
            { id: 'qt-a', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            { id: 'bt-b', attributes: { address: 'tok-b', symbol: 'TWIN', name: 'TwinB' } },
            { id: 'qt-b', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      coinmarketcap: {
        baseUrl: 'https://pro-api.coinmarketcap.com',
        apiKey: 'test-key',
        discoveryRateLimiter: rateLimiter,
        enrichmentRateLimiter: rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    const tokA = result.find((t) => t.address === 'tok-a');
    const tokB = result.find((t) => t.address === 'tok-b');
    expect(tokA?.marketCapUsd).toBe(8_000_000);
    expect(tokB?.marketCapUsd).toBeUndefined();
  });

  it('skips CMC entirely when coinmarketcap config is absent', async () => {
    let cmcCalled = false;

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('coinmarketcap.com')) {
        cmcCalled = true;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // Return a valid pool so discovery doesn't throw "no providers returned data"
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-noncmc',
            attributes: { address: 'pool-noncmc', base_token_price_usd: '1.0', volume_usd: { h24: '50000' }, reserve_in_usd: '100000' },
            relationships: { base_token: { data: { id: 'bt-nc' } }, quote_token: { data: { id: 'qt-nc' } } },
          }],
          included: [
            { id: 'bt-nc', attributes: { address: 'noncmc-addr', symbol: 'NOC', name: 'NoCMC' } },
            { id: 'qt-nc', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    expect(cmcCalled).toBe(false);
  });

  it('makes 2 trending and 2 top-pools calls per network when extraGeckoTerminalPages is 1, but still 1 new-pools call', async () => {
    let trendingCalls = 0;
    let topPoolsCalls = 0;
    let newPoolsCalls = 0;

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('trending_pools')) trendingCalls++;
      if (url.includes('new_pools')) {
        newPoolsCalls++;
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{ id: 'pool-new', attributes: { address: 'pool-new', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' }, relationships: { base_token: { data: { id: 'bt-new' } }, quote_token: { data: { id: 'qt-new' } } } }],
            included: [{ id: 'bt-new', attributes: { address: 'new-token', symbol: 'NEW', name: 'NewToken' } }, { id: 'qt-new', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } }],
          }),
        } as Response;
      }
      if (url.includes('pools?sort=')) topPoolsCalls++;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      extraGeckoTerminalPages: 1,
      minLiquidityUsd: 0,
    });

    expect(trendingCalls).toBe(2);
    expect(topPoolsCalls).toBe(2);
    expect(newPoolsCalls).toBe(1);
  });

  it('calls applyAntiStaleness with the pre-slice merged list and markSeen with the sliced result', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: Array.from({ length: 3 }, (_, i) => ({
              id: `pool-${i}`,
              attributes: { address: `pool-${i}`, base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' },
              relationships: { base_token: { data: { id: `bt-${i}` } }, quote_token: { data: { id: 'qt-u' } } },
            })),
            included: [
              ...Array.from({ length: 3 }, (_, i) => ({ id: `bt-${i}`, attributes: { address: `token-${i}`, symbol: `TK${i}`, name: `Token${i}` } })),
              { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const appliedWith: unknown[][] = [];
    const markedWith: unknown[][] = [];
    const seenTracker: DiscoverySeenTracker = {
      async applyAntiStaleness(tokens) {
        appliedWith.push([...tokens]);
        return tokens;
      },
      async markSeen(tokens) {
        markedWith.push([...tokens]);
      },
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 0,
      maxResults: 2,
      antistalenessCooldownHours: 1,
      seenTracker,
    });

    expect(appliedWith).toHaveLength(1);
    expect(appliedWith[0]).toHaveLength(3);
    expect(markedWith).toHaveLength(1);
    expect(markedWith[0]).toHaveLength(2);
  });

  it('does not call seenTracker methods when antistalenessCooldownHours is 0', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{ id: 'pool-1', attributes: { address: 'pool-1', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' }, relationships: { base_token: { data: { id: 'bt-1' } }, quote_token: { data: { id: 'qt-u' } } } }],
            included: [{ id: 'bt-1', attributes: { address: 'token-1', symbol: 'TK1', name: 'Token1' } }, { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } }],
          }),
        } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const appliedWith: unknown[][] = [];
    const markedWith: unknown[][] = [];

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 0,
      antistalenessCooldownHours: 0,
      seenTracker: {
        async applyAntiStaleness(tokens) { appliedWith.push([...tokens]); return tokens; },
        async markSeen(tokens) { markedWith.push([...tokens]); },
      },
    });

    expect(appliedWith).toHaveLength(0);
    expect(markedWith).toHaveLength(0);
  });

  it('returns tokens normally and does not throw when seenTracker is absent', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{ id: 'pool-1', attributes: { address: 'pool-1', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' }, relationships: { base_token: { data: { id: 'bt-1' } }, quote_token: { data: { id: 'qt-u' } } } }],
            included: [{ id: 'bt-1', attributes: { address: 'token-1', symbol: 'TK1', name: 'Token1' } }, { id: 'qt-u', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } }],
          }),
        } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 0,
      maxResults: 10,
      antistalenessCooldownHours: 1,
      // seenTracker absent
    });

    expect(result).toHaveLength(1);
  });

  it('DexScreener boost tokens with real on-chain liquidity appear in discovery results', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'boost-addr', amount: 100 }],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('/tokens/v1/solana/boost-addr')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            pairs: [{
              baseToken: { address: 'boost-addr', symbol: 'BOOST', name: 'Boost Token' },
              priceUsd: '0.00001',
              volume: { h24: 200_000 },
              liquidity: { usd: 50_000 },
              chainId: 'solana',
            }],
          }),
        } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 10_000,
    });

    const boostToken = result.find((t) => t.address === 'boost-addr');
    expect(boostToken).toBeDefined();
    expect(boostToken?.liquidityUsd).toBe(50_000);
    expect(boostToken?.volume24hUsd).toBe(200_000);
    expect(boostToken?.source).toBe('dexscreener');
  });

  it('DexScreener boost tokens with no DexScreener pair remain filtered', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'no-pair-addr', amount: 100 }],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('/tokens/v1/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ pairs: [] }),
        } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 1,
    });

    expect(result).toEqual([]);
  });

  it('DexScreener boost tokens from non-configured networks do not appear', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'ethereum', tokenAddress: 'eth-addr', amount: 100 }],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    expect(result).toEqual([]);
  });

  it('Birdeye runtime failure does not block other providers', async () => {
    let birdeyeCalled = false;
    let dexscreenerReturned = false;

    globalThis.fetch = async (input) => {
      const url = String(input);
      // Birdeye trending — simulate a 500 failure
      if (url.includes('birdeye.so') && url.includes('token_trending')) {
        birdeyeCalled = true;
        return makeErrorResponse(500);
      }
      // DexScreener — return a valid token to prove it still works
      if (url.includes('token-boosts/top')) {
        dexscreenerReturned = true;
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'survivor-addr', amount: 200 }],
        } as Response;
      }
      // DexScreener enrichment pass (fetchDexScreenerTokensByAddress) —
      // provide real on-chain data so the boost token passes the liquidity threshold
      if (url.includes('/tokens/v1/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            pairs: [{
              chainId: 'solana',
              baseToken: { address: 'survivor-addr', symbol: 'SURV', name: 'Survivor' },
              priceUsd: '2.0',
              volume: { h24: 50000 },
              liquidity: { usd: 25000 },
            }],
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      birdeye: {
        baseUrl: 'https://public-api.birdeye.so',
        apiKey: 'test-key',
        rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    expect(birdeyeCalled).toBe(true);
    expect(dexscreenerReturned).toBe(true);
    // The DexScreener boost token should still appear even though Birdeye failed
    expect(result.some((t) => t.address === 'survivor-addr')).toBe(true);
  });

  it('logs rejected provider results via console.warn instead of silently dropping them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = async (input) => {
      const url = String(input);
      // Birdeye trending — simulate a 429 rate-limit failure
      if (url.includes('birdeye.so') && url.includes('token_trending')) {
        return makeErrorResponse(429);
      }
      // GeckoTerminal base — simulate a 500 failure
      if (url.includes('geckoterminal.com') && url.includes('/networks/base/')) {
        return makeErrorResponse(500);
      }
      // DexScreener — return a valid token so discovery still succeeds
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'survivor-addr', amount: 200 }],
        } as Response;
      }
      if (url.includes('/tokens/v1/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            pairs: [{
              chainId: 'solana',
              baseToken: { address: 'survivor-addr', symbol: 'SURV', name: 'Survivor' },
              priceUsd: '2.0',
              volume: { h24: 50000 },
              liquidity: { usd: 25000 },
            }],
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      birdeye: {
        baseUrl: 'https://public-api.birdeye.so',
        apiKey: 'test-key',
        rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana', 'base'],
      minLiquidityUsd: 0,
    });

    // The Birdeye 429 and GeckoTerminal base 500 failures must be surfaced with attributed labels.
    const warnCalls = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(warnCalls.some((msg) => msg.includes('HTTP error: 429'))).toBe(true);
    expect(warnCalls.some((msg) => msg.includes('HTTP error: 500'))).toBe(true);

    // Verify the Birdeye 429 carries provider/network/vector attribution.
    // Search by the labeled pattern rather than bare "429" to avoid matching
    // other console.warn calls (e.g. DexScreener enrichment failures).
    const birdeyeCall = warnSpy.mock.calls.find((call) => {
      const label = call[1];
      return label?.provider === 'birdeye' && label?.vector === 'trending';
    });
    expect(birdeyeCall).toBeDefined();
    expect(birdeyeCall![1].provider).toBe('birdeye');
    expect(birdeyeCall![1].network).toBe('solana');
    expect(birdeyeCall![1].vector).toBe('trending');

    // Verify GeckoTerminal base warnings carry the base network label
    const geckoBaseCalls = warnSpy.mock.calls.filter((call) => {
      const label = call[1];
      return label?.provider === 'geckoterminal' && label?.network === 'base';
    });
    expect(geckoBaseCalls.length).toBeGreaterThan(0);
    // Every GeckoTerminal base warning should include the network and vector fields
    for (const call of geckoBaseCalls) {
      expect(call[1].provider).toBe('geckoterminal');
      expect(call[1].network).toBe('base');
      expect(typeof call[1].vector).toBe('string');
    }

    warnSpy.mockRestore();
  });

  it('attributes a rejected GeckoTerminal Base trending_pools request with provider/network/vector', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = async (input) => {
      const url = String(input);
      // Only GeckoTerminal base trending_pools rejects — everything else succeeds
      if (url.includes('geckoterminal.com') && url.includes('/networks/base/trending_pools')) {
        return makeErrorResponse(429);
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // Return valid pools for other calls so discovery succeeds
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-ok',
            attributes: { address: 'pool-ok', base_token_price_usd: '1.0', volume_usd: { h24: '10000' }, reserve_in_usd: '20000' },
            relationships: { base_token: { data: { id: 'bt-ok' } }, quote_token: { data: { id: 'qt-ok' } } },
          }],
          included: [
            { id: 'bt-ok', attributes: { address: 'ok-addr', symbol: 'OK', name: 'OkToken' } },
            { id: 'qt-ok', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana', 'base'],
      minLiquidityUsd: 0,
    });

    // The Base trending_pools 429 should be logged with clear provider/network/vector attribution
    const baseTrendingWarn = warnSpy.mock.calls.find((call) => {
      const label = call[1];
      return label?.provider === 'geckoterminal' && label?.network === 'base' && label?.vector === 'trending_pools';
    });
    expect(baseTrendingWarn).toBeDefined();
    // The message should follow the labeled pattern
    expect(String(baseTrendingWarn![0])).toMatch(/geckoterminal\/base\/trending_pools: HTTP error: 429/);

    warnSpy.mockRestore();
  });

  it('returns usable results when one provider fails but others succeed (mixed fulfilled/rejected)', async () => {
    // All GeckoTerminal base calls fail, but solana GeckoTerminal + DexScreener succeed
    globalThis.fetch = async (input) => {
      const url = String(input);
      // GeckoTerminal base — all fail
      if (url.includes('geckoterminal.com') && url.includes('/networks/base/')) {
        return makeErrorResponse(429);
      }
      // DexScreener boost — return a solana token
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'mixed-addr', amount: 100 }],
        } as Response;
      }
      if (url.includes('/tokens/v1/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            pairs: [{
              chainId: 'solana',
              baseToken: { address: 'mixed-addr', symbol: 'MIX', name: 'MixedToken' },
              priceUsd: '1.0',
              volume: { h24: 50000 },
              liquidity: { usd: 25000 },
            }],
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // GeckoTerminal solana — succeed
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          data: [{
            id: 'pool-sol',
            attributes: { address: 'pool-sol', base_token_price_usd: '2.0', volume_usd: { h24: '100000' }, reserve_in_usd: '50000' },
            relationships: { base_token: { data: { id: 'bt-sol' } }, quote_token: { data: { id: 'qt-sol' } } },
          }],
          included: [
            { id: 'bt-sol', attributes: { address: 'sol-addr', symbol: 'SOLA', name: 'SolToken' } },
            { id: 'qt-sol', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
          ],
        }),
      } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana', 'base'],
      minLiquidityUsd: 0,
    });

    // Discovery must still return Solana results even though all Base provider calls failed
    expect(result.length).toBeGreaterThan(0);
    const solToken = result.find((t) => t.address === 'sol-addr');
    expect(solToken).toBeDefined();

    // No Base-only tokens should appear since all Base calls failed (and DexScreener boost
    // returned a Solana token, not a Base token).
    const baseTokens = result.filter((t) => t.network.toLowerCase() === 'base');
    expect(baseTokens).toEqual([]);
  });

  it('Birdeye discovery only runs when explicitly configured', async () => {
    let birdeyeCalled = false;

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('birdeye.so')) {
        birdeyeCalled = true;
        return makeErrorResponse(400);
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    // Birdeye not provided — when all other providers also return nothing
    // the function throws because there are no fulfilled results.
    await expect(discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      // birdeye NOT provided → should not be called
      networks: ['solana'],
      minLiquidityUsd: 0,
    })).rejects.toThrow('No discovery providers returned data');

    expect(birdeyeCalled).toBe(false);
  });

  it('Birdeye discovery is skipped when solana is not in the network list', async () => {
    let birdeyeCalled = false;

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('birdeye.so')) {
        birdeyeCalled = true;
        return makeErrorResponse(400);
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    // Birdeye is configured but solana is not in networks → birdeye fan-out is empty.
    // When other providers also return nothing, the function throws.
    await expect(discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      birdeye: {
        baseUrl: 'https://public-api.birdeye.so',
        apiKey: 'test-key',
        rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['base'], // Solana not included
      minLiquidityUsd: 0,
    })).rejects.toThrow('No discovery providers returned data');

    expect(birdeyeCalled).toBe(false);
  });

  it('filters out DexScreener Solana tokens on a base-only discovery call', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      // DexScreener global vectors — returns tokens from multiple networks
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [
            { chainId: 'solana', tokenAddress: 'sol-token', amount: 500 },
            { chainId: 'base', tokenAddress: 'base-token', amount: 300 },
          ],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'sol-token-2', totalAmount: 200 }],
        } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // GeckoTerminal base — returns base tokens
      if (url.includes('/networks/base/trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{
              id: 'pool-base',
              attributes: { address: 'pool-base', base_token_price_usd: '1.0', volume_usd: { h24: '100000' }, reserve_in_usd: '200000' },
              relationships: { base_token: { data: { id: 'bt-base' } }, quote_token: { data: { id: 'qt-base' } } },
            }],
            included: [
              { id: 'bt-base', attributes: { address: 'base-token', symbol: 'BASE', name: 'BaseToken' } },
              { id: 'qt-base', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['base'],
      minLiquidityUsd: 0,
    });

    // Only base tokens should be present; Solana tokens from DexScreener global
    // vectors must be filtered out before the merge.
    const addresses = result.map((t) => t.address);
    expect(addresses).toContain('base-token');
    expect(addresses).not.toContain('sol-token');
    expect(addresses).not.toContain('sol-token-2');
  });

  it('network filter matches exact adapter slug values (base, solana)', async () => {
    // DexScreener emits lowercase chainId: 'solana', 'base'.
    // GeckoTerminal receives the network from the fanout parameter, which is
    // lowercased from config.networks. Both adapters use the same slug format.
    // This test guards against silent drops from slug divergence by verifying
    // that the filter compares case-insensitively on the token.network side.
    globalThis.fetch = async (input) => {
      const url = String(input);
      // DexScreener returns tokens with exact lowercase slugs
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [
            { chainId: 'solana', tokenAddress: 'sol-exact', amount: 100 },
            { chainId: 'base', tokenAddress: 'base-exact', amount: 200 },
          ],
        } as Response;
      }
      if (url.includes('token-boosts/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      if (url.includes('token-profiles/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // GeckoTerminal solana returns a token with network='solana'
      if (url.includes('/networks/solana/trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{
              id: 'pool-sol',
              attributes: { address: 'pool-sol', base_token_price_usd: '1.0', volume_usd: { h24: '50000' }, reserve_in_usd: '100000' },
              relationships: { base_token: { data: { id: 'bt-sol' } }, quote_token: { data: { id: 'qt-sol' } } },
            }],
            included: [
              { id: 'bt-sol', attributes: { address: 'sol-exact', symbol: 'SOL', name: 'SolToken' } },
              { id: 'qt-sol', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['solana'],
      minLiquidityUsd: 0,
    });

    // base-exact should be filtered out; sol-exact should survive and be merged
    // with the GeckoTerminal entry for the same token.
    const addresses = result.map((t) => t.address);
    expect(addresses).toContain('sol-exact');
    expect(addresses).not.toContain('base-exact');
  });

  it('normalizes network casing so mixed-case input still matches adapter slugs', async () => {
    // Request networks with unusual casing — the implementation must
    // lowercase them before fanout and filtering so GeckoTerminal and
    // DexScreener adapters (which use lowercase slugs) still match.
    globalThis.fetch = async (input) => {
      const url = String(input);
      // DexScreener returns tokens with lowercase slugs
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [
            { chainId: 'solana', tokenAddress: 'sol-ci', amount: 100 },
            { chainId: 'base', tokenAddress: 'base-ci', amount: 200 },
          ],
        } as Response;
      }
      if (url.includes('token-boosts/latest') || url.includes('token-profiles/latest')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      // Expect ONLY lowercase networks in GeckoTerminal URLs because
      // discoverTokens lowercases the array before fanout.
      if (url.includes('/networks/solana/trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{
              id: 'pool-sol-ci',
              attributes: { address: 'pool-sol-ci', base_token_price_usd: '1.0', volume_usd: { h24: '50000' }, reserve_in_usd: '100000' },
              relationships: { base_token: { data: { id: 'bt-sol-ci' } }, quote_token: { data: { id: 'qt-sol-ci' } } },
            }],
            included: [
              { id: 'bt-sol-ci', attributes: { address: 'sol-ci', symbol: 'SOL', name: 'SolToken' } },
              { id: 'qt-sol-ci', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      }
      if (url.includes('/networks/base/trending_pools')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            data: [{
              id: 'pool-base-ci',
              attributes: { address: 'pool-base-ci', base_token_price_usd: '2.0', volume_usd: { h24: '40000' }, reserve_in_usd: '80000' },
              relationships: { base_token: { data: { id: 'bt-base-ci' } }, quote_token: { data: { id: 'qt-base-ci' } } },
            }],
            included: [
              { id: 'bt-base-ci', attributes: { address: 'base-ci', symbol: 'BASE', name: 'BaseToken' } },
              { id: 'qt-base-ci', attributes: { address: 'usdc', symbol: 'USDC', name: 'USD Coin' } },
            ],
          }),
        } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    // Request networks with UPPER and Mixed casing — should be normalized internally
    const result = await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      networks: ['SOLANA', 'Base'],
      minLiquidityUsd: 0,
    });

    // Both tokens should pass through — no tokens from networks outside ['solana','base']
    const addresses = result.map((t) => t.address);
    expect(addresses).toContain('sol-ci');
    expect(addresses).toContain('base-ci');
  });

  it('uses the provided DiscoveryLogger instead of console.warn when logger is configured', async () => {
    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const customLogger = {
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnCalls.push({ message, meta });
      },
    };
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = async (input) => {
      const url = String(input);
      // Birdeye — simulate failure so we get a rejection log
      if (url.includes('birdeye.so') && url.includes('token_trending')) {
        return makeErrorResponse(429);
      }
      // DexScreener — return a valid token so discovery still succeeds
      if (url.includes('token-boosts/top')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => [{ chainId: 'solana', tokenAddress: 'log-addr', amount: 100 }],
        } as Response;
      }
      if (url.includes('/tokens/v1/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            pairs: [{
              chainId: 'solana',
              baseToken: { address: 'log-addr', symbol: 'LOG', name: 'LogToken' },
              priceUsd: '1.0',
              volume: { h24: 50000 },
              liquidity: { usd: 25000 },
            }],
          }),
        } as Response;
      }
      if (url.includes('token-boosts') || url.includes('token-profiles')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [] } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], included: [] }) } as Response;
    };

    const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 1_000 });
    await discoverTokens({
      dexscreener: { baseUrl: 'https://api.dexscreener.com', timeoutMs: 5_000, rateLimiter },
      geckoterminal: { baseUrl: 'https://api.geckoterminal.com', timeoutMs: 5_000, rateLimiter },
      birdeye: {
        baseUrl: 'https://public-api.birdeye.so',
        apiKey: 'test-key',
        rateLimiter,
        timeoutMs: 5_000,
      },
      networks: ['solana'],
      minLiquidityUsd: 0,
      logger: customLogger,
    });

    // The custom logger should have captured the Birdeye rejection
    expect(warnCalls.length).toBeGreaterThan(0);
    const birdeyeWarn = warnCalls.find((call) => call.meta?.provider === 'birdeye');
    expect(birdeyeWarn).toBeDefined();
    expect(birdeyeWarn!.meta!.vector).toBe('trending');

    // console.warn should NOT have been called for the provider rejection
    // (but may have been called for other reasons — we only assert it was NOT
    // called for the labeled rejection pattern)
    const consoleBirdeyeCalls = consoleWarnSpy.mock.calls.filter((call) => {
      const label = call[1];
      return label?.provider === 'birdeye';
    });
    expect(consoleBirdeyeCalls).toHaveLength(0);

    consoleWarnSpy.mockRestore();
  });
});