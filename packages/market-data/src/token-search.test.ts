import { describe, it, expect, afterEach } from 'vitest';
import { searchTokens, searchTokensWithPolicy } from './token-search.js';
import type { DexScreenerConfig } from './dexscreener.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import type { MarketDataConfig } from './types.js';

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

// ---------------------------------------------------------------------------
// searchTokensWithPolicy
// ---------------------------------------------------------------------------

  function makeMarketDataConfig(
  overrides: { enabled?: boolean; minLiquidityUsd?: number; minVolume24hUsd?: number; preferCanonical?: boolean } = {},
): MarketDataConfig {
  const { enabled = true, minLiquidityUsd = 10_000, minVolume24hUsd = 25_000, preferCanonical = false } = overrides;
  return {
    dexscreener: {
      baseUrl: 'https://api.dexscreener.com',
      search: { requestsPerMinute: 100 },
      discovery: { requestsPerMinute: 100 },
    },
    geckoterminal: {
      baseUrl: 'https://api.geckoterminal.com',
      candles: { requestsPerMinute: 100 },
      discovery: { requestsPerMinute: 100 },
    },
    hyperliquid: {
      baseUrl: 'https://api.hyperliquid.xyz',
      intelligencePath: '/info',
      intelligence: { requestsPerMinute: 100 },
    },
    bybit: {
      baseUrl: 'https://api.bybit.com',
      longShortRatioPath: '/v5/market/account-ratio',
      intelligence: { requestsPerMinute: 100 },
      tickers: { requestsPerMinute: 30 },
    },
    binance: { baseUrl: 'https://api.binance.com', requestsPerMinute: 100 },
    birdeye: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
    coinMarketCap: { enabled: false, baseUrl: '', requestsPerMinute: 0, apiKey: '', cacheTtlMs: 0 },
    tokenSafety: {
      enabled,
      defaults: {
        minLiquidityUsd,
        minVolume24hUsd,
        minTokenAgeHours: 0,
        deadPoolMinAgeHours: 720,
        deadPoolMaxVolume24hUsd: 1_000,
        preferCanonical,
        requireCanonicalForKnownSymbols: false,
        includeBlockedSearchResults: false,
      },
      tradeGuard: { enabled: false, liquidityMultiplier: 5, allowOverrides: true, overrideTtlMs: 60_000 },
      canonicalTokens: {
        solana: {
          SOL: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', aliases: ['WSOL'] },
        },
      },
    },
    timeoutMs: 5_000,
  };
}

describe('searchTokensWithPolicy', () => {
  afterEach(restoreFetch);

  it('returns structured TokenSearchCandidate objects with safety metadata', async () => {
    mockFetch([
      makeDexScreenerPair({
        liquidity: { usd: 50_000 },
        volume: { h24: 80_000 },
        baseToken: { address: '0xgood', symbol: 'GOOD', name: 'Good Token' },
      }),
    ]);

    const results = await searchTokensWithPolicy('GOOD', config, makeMarketDataConfig());

    expect(results).toHaveLength(1);
    expect(results[0]!.safety).toBeDefined();
    expect(results[0]!.safety.eligible).toBe(true);
  });

  it('filters out tokens below policy minLiquidityUsd by default', async () => {
    mockFetch([
      makeDexScreenerPair({
        liquidity: { usd: 500 },
        baseToken: { address: '0xbad', symbol: 'BAD', name: 'Bad Token' },
      }),
    ]);

    const results = await searchTokensWithPolicy('BAD', config, makeMarketDataConfig({ minLiquidityUsd: 10_000 }));

    expect(results).toHaveLength(0);
  });

  it('includes blocked tokens when includeBlocked=true', async () => {
    mockFetch([
      makeDexScreenerPair({
        liquidity: { usd: 500 },
        baseToken: { address: '0xbad', symbol: 'BAD', name: 'Bad Token' },
      }),
    ]);

    const results = await searchTokensWithPolicy('BAD', config, makeMarketDataConfig(), { includeBlocked: true });

    expect(results).toHaveLength(1);
    expect(results[0]!.safety.eligible).toBe(false);
  });

  it('filters by network before policy evaluation', async () => {
    mockFetch([
      makeDexScreenerPair({ chainId: 'solana', baseToken: { address: '0x1', symbol: 'SOL1', name: 'S1' } }),
      makeDexScreenerPair({ chainId: 'base', baseToken: { address: '0x2', symbol: 'BASE1', name: 'B1' } }),
    ]);

    const results = await searchTokensWithPolicy('test', config, makeMarketDataConfig(), {
      network: 'solana',
      includeBlocked: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.network).toBe('solana');
  });

  it('promotes canonical token to front', async () => {
    const canonicalAddress = 'So11111111111111111111111111111111111111112';
    mockFetch([
      makeDexScreenerPair({
        liquidity: { usd: 2_000_000 },
        volume: { h24: 1_000_000 },
        chainId: 'solana',
        baseToken: { address: '0xfakesol', symbol: 'SOL', name: 'Fake SOL' },
      }),
      makeDexScreenerPair({
        liquidity: { usd: 500_000 },
        volume: { h24: 400_000 },
        chainId: 'solana',
        baseToken: { address: canonicalAddress, symbol: 'SOL', name: 'Wrapped SOL' },
      }),
    ]);

    const results = await searchTokensWithPolicy('SOL', config, makeMarketDataConfig({ preferCanonical: true }), { includeBlocked: true });

    const canonicalIdx = results.findIndex((r) => r.address === canonicalAddress);
    const fakeIdx = results.findIndex((r) => r.address === '0xfakesol');
    // Canonical should rank above the fake even though fake has higher liquidity
    expect(canonicalIdx).toBeLessThan(fakeIdx);
  });

  it('falls back to minimal defaults when tokenSafety is disabled', async () => {
    mockFetch([
      makeDexScreenerPair({
        liquidity: { usd: 1_000 },
        volume: { h24: 100 },
        baseToken: { address: '0xany', symbol: 'ANY', name: 'Any Token' },
      }),
    ]);

    // With disabled policy, no thresholds apply — tokens pass through
    const results = await searchTokensWithPolicy('ANY', config, makeMarketDataConfig({ enabled: false }), {
      includeBlocked: true,
    });

    expect(results).toHaveLength(1);
  });
});
