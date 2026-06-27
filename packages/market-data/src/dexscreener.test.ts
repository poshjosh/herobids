import { describe, it, expect, vi } from 'vitest';
import type { TokenInfo, DiscoveredToken } from './types.js';
import {
  normalizeDexScreenerSearchResults,
  mergeDexScreenerDiscoveryTokens,
  convertDexScreenerSearchToDiscovery,
  mergeDexScreenerSearchAndDiscovery,
  fetchDexScreenerSearch,
  fetchDexScreenerTrending,
  fetchDexScreenerBoostsLatest,
  fetchDexScreenerProfilesLatest,
  fetchDexScreenerTokensByAddress,
  enrichDexScreenerBoostTokens,
  type DexScreenerConfig,
} from './dexscreener.js';

function makeTokenInfo(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    address: '0xabc',
    symbol: 'BONK',
    name: 'Bonk',
    network: 'solana',
    priceUsd: 0.00001,
    volume24hUsd: 500_000,
    liquidityUsd: 100_000,
    priceChange24hPct: 5,
    dexId: 'raydium',
    ...overrides,
  };
}

function makeDiscoveredToken(overrides: Partial<DiscoveredToken> = {}): DiscoveredToken {
  return {
    address: '0xabc',
    symbol: 'BONK',
    name: 'Bonk',
    network: 'solana',
    priceUsd: 0.00001,
    volume24hUsd: 500_000,
    liquidityUsd: 100_000,
    source: 'dexscreener',
    discoveryVectors: ['search'],
    ...overrides,
  };
}

function makeMockConfig(fetchFn: typeof fetch): DexScreenerConfig {
  return {
    baseUrl: 'https://api.dexscreener.io',
    rateLimiter: { acquire: vi.fn().mockResolvedValue(undefined) },
    timeoutMs: 5_000,
    fetchFn,
  };
}

describe('normalizeDexScreenerSearchResults', () => {
  it('converts TokenInfo array to DiscoveredToken with default vector', () => {
    const tokens = [makeTokenInfo()];
    const result = normalizeDexScreenerSearchResults(tokens);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      address: '0xabc',
      symbol: 'BONK',
      name: 'Bonk',
      network: 'solana',
      source: 'dexscreener',
      discoveryVectors: ['search'],
    });
  });

  it('uses custom vector label when provided', () => {
    const tokens = [makeTokenInfo()];
    const result = normalizeDexScreenerSearchResults(tokens, 'trending');

    expect(result[0]!.discoveryVectors).toEqual(['trending']);
  });

  it('maps all numeric fields from TokenInfo', () => {
    const token = makeTokenInfo({ priceUsd: 1.5, volume24hUsd: 2_000_000, liquidityUsd: 500_000, priceChange24hPct: -3.2 });
    const result = normalizeDexScreenerSearchResults([token]);

    expect(result[0]!.priceUsd).toBe(1.5);
    expect(result[0]!.volume24hUsd).toBe(2_000_000);
    expect(result[0]!.liquidityUsd).toBe(500_000);
    expect(result[0]!.priceChange24hPct).toBe(-3.2);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeDexScreenerSearchResults([])).toEqual([]);
  });
});

describe('mergeDexScreenerDiscoveryTokens', () => {
  it('deduplicates tokens by network:address', () => {
    const tokens = [
      makeDiscoveredToken({ liquidityUsd: 100_000 }),
      makeDiscoveredToken({ liquidityUsd: 200_000 }), // same network:address
    ];
    const result = mergeDexScreenerDiscoveryTokens(tokens);

    expect(result).toHaveLength(1);
  });

  it('keeps the entry with higher liquidity', () => {
    const low = makeDiscoveredToken({ liquidityUsd: 50_000, discoveryVectors: ['search'] });
    const high = makeDiscoveredToken({ liquidityUsd: 200_000, discoveryVectors: ['trending'] });
    const result = mergeDexScreenerDiscoveryTokens([low, high]);

    expect(result[0]!.liquidityUsd).toBe(200_000);
  });

  it('merges discoveryVectors from both entries', () => {
    const first = makeDiscoveredToken({ discoveryVectors: ['search'], liquidityUsd: 100_000 });
    const second = makeDiscoveredToken({ discoveryVectors: ['trending'], liquidityUsd: 50_000 });
    const result = mergeDexScreenerDiscoveryTokens([first, second]);

    expect(result[0]!.discoveryVectors).toContain('search');
    expect(result[0]!.discoveryVectors).toContain('trending');
  });

  it('deduplicates discoveryVectors when the same vector appears in both', () => {
    const first = makeDiscoveredToken({ discoveryVectors: ['search'], liquidityUsd: 100_000 });
    const second = makeDiscoveredToken({ discoveryVectors: ['search', 'trending'], liquidityUsd: 50_000 });
    const result = mergeDexScreenerDiscoveryTokens([first, second]);

    const vectors = result[0]!.discoveryVectors;
    expect(vectors.filter((v) => v === 'search')).toHaveLength(1);
  });

  it('preserves distinct tokens with different addresses', () => {
    const tokenA = makeDiscoveredToken({ address: '0xaaa', symbol: 'AAVE' });
    const tokenB = makeDiscoveredToken({ address: '0xbbb', symbol: 'BONK' });
    const result = mergeDexScreenerDiscoveryTokens([tokenA, tokenB]);

    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(mergeDexScreenerDiscoveryTokens([])).toEqual([]);
  });
});

describe('convertDexScreenerSearchToDiscovery', () => {
  it('normalizes and deduplicates in one call', () => {
    const tokens = [
      makeTokenInfo({ liquidityUsd: 100_000 }),
      makeTokenInfo({ liquidityUsd: 200_000 }), // duplicate address
    ];
    const result = convertDexScreenerSearchToDiscovery(tokens);

    expect(result).toHaveLength(1);
    expect(result[0]!.liquidityUsd).toBe(200_000);
    expect(result[0]!.source).toBe('dexscreener');
  });
});

describe('mergeDexScreenerSearchAndDiscovery', () => {
  it('merges search TokenInfo with existing DiscoveredTokens and deduplicates', () => {
    const searchTokens = [makeTokenInfo({ liquidityUsd: 80_000, discoveryVectors: [] as unknown as undefined } as Partial<TokenInfo>)];
    const discoveryTokens = [makeDiscoveredToken({ liquidityUsd: 150_000, discoveryVectors: ['boosts_top'] })];

    const result = mergeDexScreenerSearchAndDiscovery(searchTokens, discoveryTokens);

    expect(result).toHaveLength(1);
    expect(result[0]!.liquidityUsd).toBe(150_000); // higher liquidity wins
    expect(result[0]!.discoveryVectors).toContain('boosts_top');
    expect(result[0]!.discoveryVectors).toContain('search');
  });

  it('keeps all tokens when there are no duplicates', () => {
    const searchTokens = [makeTokenInfo({ address: '0xaaa', symbol: 'WIF' })];
    const discoveryTokens = [makeDiscoveredToken({ address: '0xbbb', symbol: 'BONK' })];

    const result = mergeDexScreenerSearchAndDiscovery(searchTokens, discoveryTokens);

    expect(result).toHaveLength(2);
  });
});

describe('fetchDexScreenerSearch', () => {
  it('maps pair response to TokenInfo', async () => {
    const mockPairs = {
      pairs: [{
        baseToken: { address: '0xabc', symbol: 'BONK', name: 'Bonk' },
        priceUsd: '0.00001',
        volume: { h24: 500_000 },
        liquidity: { usd: 100_000 },
        priceChange: { h24: 5 },
        dexId: 'raydium',
        chainId: 'solana',
      }],
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPairs), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerSearch('BONK', config);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      symbol: 'BONK',
      network: 'solana',
      liquidityUsd: 100_000,
      priceUsd: 0.00001,
    });
  });

  it('returns empty array when pairs is missing in response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerSearch('NONEXISTENT', config);

    expect(result).toEqual([]);
  });

  it('handles pairs with missing fields gracefully', async () => {
    const mockPairs = {
      pairs: [{ chainId: 'solana' }], // minimal pair with no baseToken
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPairs), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerSearch('X', config);

    expect(result[0]).toMatchObject({
      address: '',
      symbol: '',
      network: 'solana',
      priceUsd: 0,
    });
  });
});

describe('fetchDexScreenerTrending / fetchDexScreenerBoostsLatest / fetchDexScreenerProfilesLatest', () => {
  function makeDiscoveryResponse(items: object[]) {
    return new Response(JSON.stringify(items), { status: 200 });
  }

  it('fetchDexScreenerTrending maps discovery items with boosts_top vector', async () => {
    const items = [
      { chainId: 'solana', tokenAddress: '0xabc', amount: 1_000, description: 'Bonk token' },
    ];
    const fetchFn = vi.fn().mockResolvedValue(makeDiscoveryResponse(items));
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerTrending(config);

    expect(result).toHaveLength(1);
    expect(result[0]!.discoveryVectors).toEqual(['boosts_top']);
    expect(result[0]!.network).toBe('solana');
    expect(result[0]!.source).toBe('dexscreener');
    expect(result[0]!.name).toBe('Bonk token');
  });

  it('fetchDexScreenerBoostsLatest uses boosts_latest vector', async () => {
    const items = [{ chainId: 'ethereum', tokenAddress: '0xdef', amount: 500 }];
    const fetchFn = vi.fn().mockResolvedValue(makeDiscoveryResponse(items));
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerBoostsLatest(config);

    expect(result[0]!.discoveryVectors).toEqual(['boosts_latest']);
  });

  it('fetchDexScreenerProfilesLatest uses profiles_latest vector', async () => {
    const items = [{ chainId: 'bsc', tokenAddress: '0x123', totalAmount: 250 }];
    const fetchFn = vi.fn().mockResolvedValue(makeDiscoveryResponse(items));
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerProfilesLatest(config);

    expect(result[0]!.discoveryVectors).toEqual(['profiles_latest']);
    expect(result[0]!.volume24hUsd).toBe(250); // falls back to totalAmount
  });

  it('uses tokenAddress first six chars as symbol when address is long', async () => {
    const items = [{ chainId: 'solana', tokenAddress: 'ABCDEF123456', amount: 100 }];
    const fetchFn = vi.fn().mockResolvedValue(makeDiscoveryResponse(items));
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerTrending(config);

    expect(result[0]!.symbol).toBe('ABCDEF');
    expect(result[0]!.address).toBe('ABCDEF123456');
  });
});

describe('fetchDexScreenerTokensByAddress', () => {
  it('returns [] for empty addresses', async () => {
    const config = makeMockConfig(vi.fn());
    const result = await fetchDexScreenerTokensByAddress('solana', [], config);
    expect(result).toEqual([]);
  });

  it('maps the highest-liquidity pair for each token address', async () => {
    const mockResponse = {
      pairs: [
        {
          baseToken: { address: 'addr-a', symbol: 'TOKA', name: 'Token A' },
          priceUsd: '0.5',
          volume: { h24: 100_000 },
          liquidity: { usd: 100_000 },
          chainId: 'solana',
        },
        {
          baseToken: { address: 'addr-a', symbol: 'TOKA', name: 'Token A' },
          priceUsd: '0.55',
          volume: { h24: 200_000 },
          liquidity: { usd: 200_000 },
          chainId: 'solana',
        },
        {
          baseToken: { address: 'addr-b', symbol: 'TOKB', name: 'Token B' },
          priceUsd: '0.1',
          volume: { h24: 50_000 },
          liquidity: { usd: 50_000 },
          chainId: 'solana',
        },
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerTokensByAddress('solana', ['addr-a', 'addr-b'], config);

    expect(result).toHaveLength(2);
    const tokenA = result.find((t) => t.address === 'addr-a');
    expect(tokenA?.liquidityUsd).toBe(200_000);
    expect(tokenA?.symbol).toBe('TOKA');
  });

  it('when a token has no pairs in the response, it is absent from the result', async () => {
    const mockResponse = {
      pairs: [
        {
          baseToken: { address: 'addr-found', symbol: 'FOUND', name: 'Found' },
          priceUsd: '0.5',
          volume: { h24: 100_000 },
          liquidity: { usd: 100_000 },
          chainId: 'solana',
        },
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await fetchDexScreenerTokensByAddress(
      'solana',
      ['addr-found', 'addr-not-found'],
      config,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe('addr-found');
  });

  it('batches >30 addresses into sequential requests of ≤30 each', async () => {
    const addresses = Array.from({ length: 45 }, (_, i) => `addr-${i}`);
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ pairs: [] }), { status: 200 })),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    await fetchDexScreenerTokensByAddress('solana', addresses, config);

    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstUrl = fetchFn.mock.calls[0]?.[0] as string;
    const secondUrl = fetchFn.mock.calls[1]?.[0] as string;

    // URLs have the shape: {baseUrl}/tokens/v1/solana/addr-0,addr-1,...
    const firstAddrs = (firstUrl.split('/').pop() ?? '').split(',');
    const secondAddrs = (secondUrl.split('/').pop() ?? '').split(',');

    expect(firstAddrs.length).toBe(30);
    expect(secondAddrs.length).toBe(15);
  });
});

describe('enrichDexScreenerBoostTokens', () => {
  it('overwrites liquidityUsd, volume24hUsd, priceUsd on source=dexscreener tokens with liquidityUsd=0', async () => {
    const tokens: DiscoveredToken[] = [
      {
        address: 'boost-addr',
        symbol: 'BOOST',
        name: 'Boost Token',
        network: 'solana',
        priceUsd: 0,
        volume24hUsd: 100,
        liquidityUsd: 0,
        source: 'dexscreener',
        discoveryVectors: ['boosts_top'],
      },
    ];

    const mockPairs = {
      pairs: [
        {
          baseToken: { address: 'boost-addr', symbol: 'BOOST', name: 'Boost Token' },
          priceUsd: '0.00001',
          volume: { h24: 500_000 },
          liquidity: { usd: 200_000 },
          chainId: 'solana',
        },
      ],
    };

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPairs), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await enrichDexScreenerBoostTokens(tokens, ['solana'], config);

    expect(result[0]?.liquidityUsd).toBe(200_000);
    expect(result[0]?.volume24hUsd).toBe(500_000);
    expect(result[0]?.priceUsd).toBe(0.00001);
  });

  it('preserves discoveryVectors and source from original token', async () => {
    const tokens: DiscoveredToken[] = [
      {
        address: 'boost-addr',
        symbol: 'BOOST',
        name: 'Boost Token',
        network: 'solana',
        priceUsd: 0,
        volume24hUsd: 100,
        liquidityUsd: 0,
        source: 'dexscreener',
        discoveryVectors: ['boosts_top'],
      },
    ];

    const mockPairs = {
      pairs: [
        {
          baseToken: { address: 'boost-addr', symbol: 'BOOST', name: 'Boost Token' },
          priceUsd: '0.00001',
          volume: { h24: 500_000 },
          liquidity: { usd: 200_000 },
          chainId: 'solana',
        },
      ],
    };

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPairs), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await enrichDexScreenerBoostTokens(tokens, ['solana'], config);

    expect(result[0]?.discoveryVectors).toContain('boosts_top');
    expect(result[0]?.source).toBe('dexscreener');
  });

  it('overwrites volume24hUsd with real trading volume (not boost spend amount)', async () => {
    const tokens: DiscoveredToken[] = [
      {
        address: 'boost-addr',
        symbol: 'BOOST',
        name: 'Boost Token',
        network: 'solana',
        priceUsd: 0,
        volume24hUsd: 999,
        liquidityUsd: 0,
        source: 'dexscreener',
        discoveryVectors: ['boosts_top'],
      },
    ];

    const mockPairs = {
      pairs: [
        {
          baseToken: { address: 'boost-addr', symbol: 'BOOST', name: 'Boost Token' },
          priceUsd: '0.00001',
          volume: { h24: 500_000 },
          liquidity: { usd: 200_000 },
          chainId: 'solana',
        },
      ],
    };

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPairs), { status: 200 }),
    );
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await enrichDexScreenerBoostTokens(tokens, ['solana'], config);

    expect(result[0]?.volume24hUsd).toBe(500_000);
  });

  it('skips tokens whose network is not in configured networks', async () => {
    const tokens: DiscoveredToken[] = [
      {
        address: 'eth-addr',
        symbol: 'ETH',
        name: 'Ethereum Token',
        network: 'ethereum',
        priceUsd: 0,
        volume24hUsd: 100,
        liquidityUsd: 0,
        source: 'dexscreener',
        discoveryVectors: ['boosts_top'],
      },
    ];

    const fetchFn = vi.fn();
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await enrichDexScreenerBoostTokens(tokens, ['solana'], config);

    // Token returned unchanged; no HTTP calls made because network was filtered out
    expect(result[0]?.liquidityUsd).toBe(0);
    expect(result[0]?.volume24hUsd).toBe(100);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips tokens that already have liquidityUsd > 0', async () => {
    const tokens: DiscoveredToken[] = [
      {
        address: 'rich-addr',
        symbol: 'RICH',
        name: 'Rich Token',
        network: 'solana',
        priceUsd: 1.0,
        volume24hUsd: 100_000,
        liquidityUsd: 50_000,
        source: 'dexscreener',
        discoveryVectors: ['search'],
      },
    ];

    const fetchFn = vi.fn();
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await enrichDexScreenerBoostTokens(tokens, ['solana'], config);

    expect(result[0]?.liquidityUsd).toBe(50_000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns original tokens unchanged when the fetch throws', async () => {
    const tokens: DiscoveredToken[] = [
      {
        address: 'boost-addr',
        symbol: 'BOOST',
        name: 'Boost Token',
        network: 'solana',
        priceUsd: 0,
        volume24hUsd: 100,
        liquidityUsd: 0,
        source: 'dexscreener',
        discoveryVectors: ['boosts_top'],
      },
    ];

    const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const config = makeMockConfig(fetchFn as unknown as typeof fetch);

    const result = await enrichDexScreenerBoostTokens(tokens, ['solana'], config);

    expect(result).toEqual(tokens);
    expect(result[0]?.liquidityUsd).toBe(0);
  });
});
