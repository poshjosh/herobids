import { describe, it, expect, afterEach } from 'vitest';
import { searchTokens } from './token-search.js';
import type { DexScreenerConfig } from './dexscreener.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import type { TokenInfo } from './types.js';

// Mock fetch globally for these tests
const originalFetch = globalThis.fetch;

function mockFetch(pairs: Array<Partial<Record<string, unknown>>>) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ pairs }),
  }) as Response;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function makeDexScreenerPair(overrides: Record<string, unknown> = {}) {
  return {
    baseToken: { address: '0xabc', symbol: 'TEST', name: 'Test Token' },
    priceUsd: '1.50',
    volume: { h24: 100000 },
    liquidity: { usd: 50000 },
    priceChange: { h24: 5.2 },
    dexId: 'raydium',
    chainId: 'solana',
    ...overrides,
  };
}

const config: DexScreenerConfig = {
  baseUrl: 'https://api.dexscreener.com',
  rateLimiter: new TokenBucketRateLimiter({ requestsPerMinute: 1000 }),
  timeoutMs: 5000,
};

describe('searchTokens', () => {
  afterEach(restoreFetch);

  it('filters out tokens below minLiquidityUsd', async () => {
    mockFetch([
      makeDexScreenerPair({ liquidity: { usd: 5000 } }),
      makeDexScreenerPair({ liquidity: { usd: 50000 }, baseToken: { address: '0xdef', symbol: 'GOOD', name: 'Good' } }),
    ]);
    const results = await searchTokens('test', config, { minLiquidityUsd: 10000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe('GOOD');
  });

  it('filters by network', async () => {
    mockFetch([
      makeDexScreenerPair({ chainId: 'solana', baseToken: { address: '0x1', symbol: 'SOL1', name: 'Sol1' } }),
      makeDexScreenerPair({ chainId: 'ethereum', baseToken: { address: '0x2', symbol: 'ETH1', name: 'Eth1' } }),
    ]);
    const results = await searchTokens('test', config, { network: 'solana', minLiquidityUsd: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.network).toBe('solana');
  });

  it('sorts by liquidity descending', async () => {
    mockFetch([
      makeDexScreenerPair({ liquidity: { usd: 20000 }, baseToken: { address: '0x1', symbol: 'LOW', name: 'Low' } }),
      makeDexScreenerPair({ liquidity: { usd: 80000 }, baseToken: { address: '0x2', symbol: 'HIGH', name: 'High' } }),
    ]);
    const results = await searchTokens('test', config, { minLiquidityUsd: 0 });
    expect(results[0]!.symbol).toBe('HIGH');
    expect(results[1]!.symbol).toBe('LOW');
  });

  it('deduplicates by address+network', async () => {
    mockFetch([
      makeDexScreenerPair({ liquidity: { usd: 80000 } }),
      makeDexScreenerPair({ liquidity: { usd: 50000 } }), // same address+network
    ]);
    const results = await searchTokens('test', config, { minLiquidityUsd: 0 });
    expect(results).toHaveLength(1);
  });

  it('respects limit option', async () => {
    const pairs = Array.from({ length: 20 }, (_, i) =>
      makeDexScreenerPair({
        liquidity: { usd: 50000 + i * 1000 },
        baseToken: { address: `0x${i}`, symbol: `T${i}`, name: `Token ${i}` },
      }),
    );
    mockFetch(pairs);
    const results = await searchTokens('test', config, { limit: 5, minLiquidityUsd: 0 });
    expect(results).toHaveLength(5);
  });
});
