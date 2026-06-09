import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { fetchCmcTrending, fetchCmcNewListings, enrichWithCmc, type CoinMarketCapConfig } from './coinmarketcap.js';
import type { DiscoveredToken } from './types.js';

function makeConfig(overrides: Partial<CoinMarketCapConfig> = {}): CoinMarketCapConfig {
  const rateLimiter = new TokenBucketRateLimiter({ requestsPerMinute: 10_000 });
  return {
    baseUrl: 'https://pro-api.coinmarketcap.com',
    apiKey: 'test-key',
    discoveryRateLimiter: rateLimiter,
    enrichmentRateLimiter: rateLimiter,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeTrendingResponse(coins: object[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: coins }),
  } as Response;
}

const SOL_COIN = {
  id: 5426,
  name: 'MyToken',
  symbol: 'MYT',
  slug: 'mytoken',
  num_market_pairs: 12,
  platform: { slug: 'solana', token_address: 'So1abc123' },
  quote: { USD: { price: 2.5, volume_24h: 500_000, market_cap: 10_000_000, fully_diluted_market_cap: 15_000_000, percent_change_24h: 5.0 } },
};

describe('fetchCmcTrending', () => {
  it('maps a CMC trending coin to DiscoveredToken with correct fields', async () => {
    const config = makeConfig({
      fetchFn: async () => makeTrendingResponse([SOL_COIN]),
    });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result).toHaveLength(1);
    const token = result[0]!;
    expect(token.address).toBe('So1abc123');
    expect(token.symbol).toBe('MYT');
    expect(token.name).toBe('MyToken');
    expect(token.network).toBe('solana');
    expect(token.priceUsd).toBe(2.5);
    expect(token.volume24hUsd).toBe(500_000);
    expect(token.source).toBe('coinmarketcap');
    expect(token.discoveryVectors).toEqual(['cmc_trending']);
    expect(token.marketCapUsd).toBe(10_000_000);
    expect(token.fullyDilutedValuationUsd).toBe(15_000_000);
    expect(token.cexListings).toBe(12);
    expect(token.riskLevel).toBe('medium'); // 10M is in the 1M–50M medium band
  });

  it('sets riskLevel to medium for market cap between 1M and 50M', async () => {
    const coin = { ...SOL_COIN, quote: { USD: { ...SOL_COIN.quote.USD, market_cap: 10_000_000 } } };
    const config = makeConfig({ fetchFn: async () => makeTrendingResponse([coin]) });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result[0]?.riskLevel).toBe('medium');
  });

  it('sets riskLevel to low for market cap at or above 50M', async () => {
    const coin = { ...SOL_COIN, quote: { USD: { ...SOL_COIN.quote.USD, market_cap: 50_000_000 } } };
    const config = makeConfig({ fetchFn: async () => makeTrendingResponse([coin]) });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result[0]?.riskLevel).toBe('low');
  });

  it('sets riskLevel to high when market cap is below 1M', async () => {
    const coin = { ...SOL_COIN, quote: { USD: { ...SOL_COIN.quote.USD, market_cap: 500_000 } } };
    const config = makeConfig({ fetchFn: async () => makeTrendingResponse([coin]) });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result[0]?.riskLevel).toBe('high');
  });

  it('sets riskLevel to high when market cap is absent', async () => {
    const coin = { ...SOL_COIN, quote: { USD: { price: 1.0, volume_24h: 1000 } } }; // no market_cap
    const config = makeConfig({ fetchFn: async () => makeTrendingResponse([coin]) });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result[0]?.riskLevel).toBe('high');
  });

  it('filters out coins whose platform is not in the requested networks', async () => {
    const ethCoin = { ...SOL_COIN, platform: { slug: 'ethereum', token_address: '0xabc' } };
    const config = makeConfig({
      fetchFn: async () => makeTrendingResponse([SOL_COIN, ethCoin]),
    });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result).toHaveLength(1);
    expect(result[0]?.network).toBe('solana');
  });

  it('returns [] without making any network call when no requested network is supported', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return makeTrendingResponse([]);
      },
    });

    const result = await fetchCmcTrending(['unsupported-chain-xyz'], config);

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('filters out coins with no platform data', async () => {
    const noPlatformCoin = { ...SOL_COIN, platform: null };
    const config = makeConfig({
      fetchFn: async () => makeTrendingResponse([noPlatformCoin, SOL_COIN]),
    });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('So1abc123');
  });

  it('filters out coins whose platform has no token address', async () => {
    const missingAddressCoin = { ...SOL_COIN, platform: { slug: 'solana', token_address: '' } };
    const config = makeConfig({
      fetchFn: async () => makeTrendingResponse([missingAddressCoin, SOL_COIN]),
    });

    const result = await fetchCmcTrending(['solana'], config);

    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('So1abc123');
  });
});

describe('fetchCmcNewListings', () => {
  it('maps new-listings coins to DiscoveredToken with cmc_new_listings vector', async () => {
    const config = makeConfig({
      fetchFn: async () => makeTrendingResponse([SOL_COIN]),
    });

    const result = await fetchCmcNewListings(['solana'], config);

    expect(result).toHaveLength(1);
    expect(result[0]?.discoveryVectors).toEqual(['cmc_new_listings']);
  });

  it('returns [] without a network call for unsupported networks', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return makeTrendingResponse([]);
      },
    });

    const result = await fetchCmcNewListings(['unknown-net'], config);

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('enrichWithCmc', () => {
  function makeToken(overrides: Partial<DiscoveredToken> = {}): DiscoveredToken {
    return {
      address: 'addr1',
      symbol: 'MYT',
      name: 'MyToken',
      network: 'solana',
      priceUsd: 2.0,
      volume24hUsd: 100_000,
      liquidityUsd: 50_000,
      source: 'dexscreener',
      discoveryVectors: ['boosts_top'],
      ...overrides,
    };
  }

  it('merges market cap, FDV, and CEX listings from CMC onto existing tokens', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            MYT: [{ symbol: 'MYT', platform: { slug: 'solana', token_address: 'addr1' }, num_market_pairs: 25, quote: { USD: { market_cap: 5_000_000, fully_diluted_market_cap: 8_000_000 } } }],
          },
        }),
      } as Response),
    });

    const tokens = [makeToken()];
    const result = await enrichWithCmc(tokens, config);

    expect(result[0]?.marketCapUsd).toBe(5_000_000);
    expect(result[0]?.fullyDilutedValuationUsd).toBe(8_000_000);
    expect(result[0]?.cexListings).toBe(25);
  });

  it('leaves tokens unchanged when symbol is absent from CMC response', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: {} }),
      } as Response),
    });

    const token = makeToken({ marketCapUsd: 1_000_000 });
    const result = await enrichWithCmc([token], config);

    expect(result[0]?.marketCapUsd).toBe(1_000_000);
    expect(result[0]?.cexListings).toBeUndefined();
  });

  it('returns the input array unchanged when tokens is empty without making a network call', async () => {
    let called = false;
    const config = makeConfig({
      fetchFn: async () => {
        called = true;
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: {} }) } as Response;
      },
    });

    const result = await enrichWithCmc([], config);

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('does a case-insensitive symbol match', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            MYT: [{ symbol: 'MYT', platform: { slug: 'solana', token_address: 'addr1' }, num_market_pairs: 10, quote: { USD: { market_cap: 999_000 } } }],
          },
        }),
      } as Response),
    });

    const result = await enrichWithCmc([makeToken({ symbol: 'myt' })], config);

    expect(result[0]?.marketCapUsd).toBe(999_000);
  });

  it('prefers existing enrichment fields when CMC returns undefined values', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            MYT: [{ symbol: 'MYT', platform: { slug: 'solana', token_address: 'addr1' }, quote: { USD: {} } }], // no market_cap
          },
        }),
      } as Response),
    });

    const token = makeToken({ marketCapUsd: 7_000_000 });
    const result = await enrichWithCmc([token], config);

    expect(result[0]?.marketCapUsd).toBe(7_000_000);
  });

  it('matches CMC quotes by network and address when symbols collide', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            DUP: [
              {
                symbol: 'DUP',
                platform: { slug: 'solana', token_address: 'sol-addr' },
                quote: { USD: { market_cap: 1_000_000 } },
              },
              {
                symbol: 'DUP',
                platform: { slug: 'base', token_address: 'base-addr' },
                quote: { USD: { market_cap: 2_000_000 } },
              },
            ],
          },
        }),
      } as Response),
    });

    const result = await enrichWithCmc([
      makeToken({ address: 'sol-addr', symbol: 'DUP', network: 'solana' }),
      makeToken({ address: 'base-addr', symbol: 'DUP', network: 'base' }),
    ], config);

    expect(result.find((token) => token.network === 'solana')?.marketCapUsd).toBe(1_000_000);
    expect(result.find((token) => token.network === 'base')?.marketCapUsd).toBe(2_000_000);
  });

  it('derives riskLevel from the market cap returned by CMC', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            MYT: [{ symbol: 'MYT', platform: { slug: 'solana', token_address: 'addr1' }, quote: { USD: { market_cap: 75_000_000 } } }],
          },
        }),
      } as Response),
    });

    const result = await enrichWithCmc([makeToken()], config);

    expect(result[0]?.riskLevel).toBe('low'); // 75M >= 50M
  });

  it('sets riskLevel to high when CMC returns no market cap during enrichment', async () => {
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            MYT: [{ symbol: 'MYT', platform: { slug: 'solana', token_address: 'addr1' }, quote: { USD: {} } }],
          },
        }),
      } as Response),
    });

    const result = await enrichWithCmc([makeToken()], config);

    expect(result[0]?.riskLevel).toBe('high'); // no market cap falls back to high
  });

  it('does not bleed metadata to a same-network token with a different address', async () => {
    // CMC has one entry for SYM on solana mapped to addr1. addr2 shares the symbol
    // and network but has a different address — it must not receive the metadata.
    const config = makeConfig({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            SYM: [{ symbol: 'SYM', platform: { slug: 'solana', token_address: 'addr1' }, quote: { USD: { market_cap: 5_000_000 } } }],
          },
        }),
      } as Response),
    });

    const result = await enrichWithCmc([
      makeToken({ address: 'addr1', symbol: 'SYM', network: 'solana' }),
      makeToken({ address: 'addr2', symbol: 'SYM', network: 'solana' }),
    ], config);

    expect(result.find((t) => t.address === 'addr1')?.marketCapUsd).toBe(5_000_000);
    expect(result.find((t) => t.address === 'addr2')?.marketCapUsd).toBeUndefined();
  });
});
