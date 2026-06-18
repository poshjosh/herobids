import { afterEach, describe, expect, it } from 'vitest';
import { discoverTokens } from './discovery.js';
import type { DiscoverySeenTracker } from './discovery-seen-tracker.js';
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
});