import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPriceService } from './price-service.js';
import type { ProviderRegistry } from './provider-registry.js';

function makeHyperliquidAsset(asset: string, markPrice: number | null) {
  return {
    asset,
    markPrice,
    fundingRate: 0.0001,
    annualizedFundingRatePct: 10,
    openInterest: 500,
    midPrice: markPrice,
    oraclePrice: markPrice,
    markOracleSpreadPct: 0,
    volume24hUsd: 1_000_000,
    prevDayPrice: markPrice,
    priceChange24hPct: 1.5,
  };
}

function makeDexToken(symbol: string, network: string, priceUsd: number, liquidityUsd = 500_000) {
  return {
    address: '0xabc',
    symbol,
    name: symbol,
    network,
    priceUsd,
    volume24hUsd: 100_000,
    liquidityUsd,
    priceChange24hPct: 2,
    dexId: 'raydium',
  };
}

function makeBybitTicker(symbol: string, markPrice: number | null, volume24hUsd = 1_000_000) {
  return {
    symbol,
    markPrice,
    lastPrice: markPrice,
    volume24hUsd,
    priceChange24hPct: 1.5,
  };
}

function buildRegistry(overrides: Partial<{
  hyperliquidData: ReturnType<typeof makeHyperliquidAsset>[];
  hyperliquidStale: boolean;
  hyperliquidThrow: boolean;
  hyperliquidFetchedAt: string;
  dexData: ReturnType<typeof makeDexToken>[];
  dexStale: boolean;
  dexThrow: boolean;
  dexFetchedAt: string;
  bybitTickersData: ReturnType<typeof makeBybitTicker>[];
  bybitTickersStale: boolean;
  bybitTickersThrow: boolean;
  bybitTickersFetchedAt: string;
}> = {}): ProviderRegistry {
  const defaultFetchedAt = '2026-06-09T12:00:00.000Z';
  const hyperliquidAssetContexts = overrides.hyperliquidThrow
    ? vi.fn().mockRejectedValue(new Error('Hyperliquid error'))
    : vi.fn().mockResolvedValue({
        data: overrides.hyperliquidData ?? [],
        meta: {
          freshness: { isStale: overrides.hyperliquidStale ?? false, ageMs: 0, fetchedAt: overrides.hyperliquidFetchedAt ?? defaultFetchedAt },
          provider: 'hyperliquid',
        },
      });

  const dexscreenerSearch = overrides.dexThrow
    ? vi.fn().mockRejectedValue(new Error('DexScreener error'))
    : vi.fn().mockResolvedValue({
        data: overrides.dexData ?? [],
        meta: {
          freshness: { isStale: overrides.dexStale ?? false, ageMs: 0, fetchedAt: overrides.dexFetchedAt ?? defaultFetchedAt },
          provider: 'dexscreener',
        },
      });

  const bybitTickers = overrides.bybitTickersThrow
    ? vi.fn().mockRejectedValue(new Error('Bybit error'))
    : vi.fn().mockResolvedValue({
        data: overrides.bybitTickersData ?? [],
        meta: {
          freshness: { isStale: overrides.bybitTickersStale ?? false, ageMs: 0, fetchedAt: overrides.bybitTickersFetchedAt ?? defaultFetchedAt },
          provider: 'bybit',
        },
      });

  return {
    hyperliquid: { assetContexts: hyperliquidAssetContexts },
    dexscreener: {
      search: dexscreenerSearch,
      trending: vi.fn(),
      boostsLatest: vi.fn(),
      profilesLatest: vi.fn(),
    },
    bybit: { tickers: bybitTickers },
  } as unknown as ProviderRegistry;
}

describe('createPriceService — source selection', () => {
  beforeEach(() => {
    // Clear module-level price cache between tests by resetting fetch mocks
  });

  it('returns execution price for hyperliquid chain', async () => {
    const registry = buildRegistry({
      hyperliquidData: [makeHyperliquidAsset('BTC', 67_000)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('BTC', 'hyperliquid');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(67_000);
      expect(result.data.source).toBe('execution');
      expect(result.data.stale).toBe(false);
    }
  });

  it('normalises BTC-PERP to BTC for hyperliquid lookup', async () => {
    const registry = buildRegistry({
      hyperliquidData: [makeHyperliquidAsset('BTC', 67_000)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('BTC-PERP', 'hyperliquid');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('execution');
    }
  });

  it('falls back to oracle when hyperliquid mark price is null', async () => {
    const registry = buildRegistry({
      hyperliquidData: [makeHyperliquidAsset('BTC', null)],
      // DexScreener oracle fallback uses 'any' chain when original chain is 'hyperliquid'
      dexData: [makeDexToken('BTC', 'solana', 67_100)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('BTC', 'hyperliquid');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(67_100);
      expect(result.data.source).toBe('oracle');
    }
  });

  it('falls back to oracle when hyperliquid throws', async () => {
    const registry = buildRegistry({
      hyperliquidThrow: true,
      // DexScreener oracle fallback uses 'any' chain when original chain is 'hyperliquid'
      dexData: [makeDexToken('SOL', 'solana', 155)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('SOL', 'hyperliquid');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
    }
  });

  it('uses oracle source directly for non-hyperliquid chains', async () => {
    const registry = buildRegistry({
      dexData: [makeDexToken('WIF', 'solana', 2.5)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('WIF', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(2.5);
      expect(result.data.source).toBe('oracle');
    }
  });

  it('filters dexscreener results by chain', async () => {
    const registry = buildRegistry({
      dexData: [
        makeDexToken('USDC', 'ethereum', 1.0, 10_000_000),
        makeDexToken('USDC', 'solana', 0.9999, 5_000_000),
      ],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('USDC', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(0.9999);
    }
  });

  it('prefers highest-liquidity token from dexscreener results', async () => {
    const registry = buildRegistry({
      dexData: [
        makeDexToken('BONK', 'solana', 0.00001, 100_000),
        makeDexToken('BONK', 'solana', 0.00002, 900_000),
      ],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('BONK', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(0.00002);
    }
  });

  it('returns error when both sources fail and no cache entry exists', async () => {
    // Use unique symbol that won't be in cache from other tests
    const registry = buildRegistry({
      hyperliquidThrow: true,
      dexThrow: true,
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('UNKNOWN_TOKEN_XYZ_999', 'solana');

    expect(result.ok).toBe(false);
  });

  it('marks stale when provider reports stale freshness', async () => {
    const registry = buildRegistry({
      dexData: [makeDexToken('SOL', 'solana', 155)],
      dexStale: true,
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('SOL', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stale).toBe(true);
    }
  });

  it('falls back to cached/stale when all live sources fail', async () => {
    // First call succeeds and populates cache
    const registry1 = buildRegistry({
      dexData: [makeDexToken('CACHE_TEST_TOK', 'solana', 42)],
    });
    const svc1 = createPriceService(registry1);
    await svc1.getPrice('CACHE_TEST_TOK', 'solana');

    // Second call with same service but different registry (simulating source failure)
    // We need a second service instance backed by a failing registry, but sharing the module cache.
    // The module-level cache is shared across service instances — so create a new service with failing registry.
    const registry2 = buildRegistry({ dexThrow: true });
    const svc2 = createPriceService(registry2);

    const result = await svc2.getPrice('CACHE_TEST_TOK', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('cached');
      expect(result.data.stale).toBe(true);
      expect(result.data.priceUsd).toBe(42);
    }
  });
});

describe('createPriceService — execution vs monitoring separation', () => {
  it('does not call dexscreener when hyperliquid returns a valid execution price', async () => {
    const registry = buildRegistry({
      hyperliquidData: [makeHyperliquidAsset('ETH', 3_500)],
      dexData: [makeDexToken('ETH', 'ethereum', 3_600)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('ETH', 'hyperliquid');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should be the hyperliquid mark price, not dexscreener
      expect(result.data.priceUsd).toBe(3_500);
      expect(result.data.source).toBe('execution');
    }
    expect((registry.dexscreener.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('createPriceService — address-aware lookup', () => {
  it('prefers exact address match when address is provided and multiple same-symbol tokens exist', async () => {
    const registry = buildRegistry({
      dexData: [
        makeDexToken('PEPE', 'solana', 0.0001, 900_000),
        { ...makeDexToken('PEPE', 'solana', 0.00005, 100_000), address: '0xdiscovered' },
      ],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('PEPE', 'solana', '0xdiscovered');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must return the price of the exact-address token, not the higher-liquidity one
      expect(result.data.priceUsd).toBe(0.00005);
      expect(result.data.source).toBe('oracle');
    }
  });

  it('returns not_found when address does not match any candidate', async () => {
    const registry = buildRegistry({
      dexData: [
        makeDexToken('PEPE', 'solana', 0.0001, 900_000),
        makeDexToken('PEPE', 'solana', 0.00005, 100_000),
      ],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('PEPE', 'solana', '0xnonexistent');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.not_found');
    }
  });

  it('does not use address filtering when address is omitted', async () => {
    const registry = buildRegistry({
      dexData: [
        makeDexToken('PEPE', 'solana', 0.0001, 900_000),
        { ...makeDexToken('PEPE', 'solana', 0.00005, 100_000), address: '0xdiscovered' },
      ],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('PEPE', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Without address → highest-liquidity wins
      expect(result.data.priceUsd).toBe(0.0001);
    }
  });
});

describe('createPriceService — freshness propagation and cache TTL', () => {
  it('propagates provider fetchedAt for oracle source instead of fabricating timestamp', async () => {
    const providerFetchedAt = '2026-06-08T10:30:00.000Z';
    const registry = buildRegistry({
      dexData: [makeDexToken('AAVE', 'ethereum', 320)],
      dexFetchedAt: providerFetchedAt,
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('AAVE', 'ethereum');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fetchedAt).toBe(providerFetchedAt);
    }
  });

  it('propagates provider fetchedAt for execution source', async () => {
    const providerFetchedAt = '2026-06-08T09:00:00.000Z';
    const registry = buildRegistry({
      hyperliquidData: [makeHyperliquidAsset('ETH', 3_500)],
      hyperliquidFetchedAt: providerFetchedAt,
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('ETH', 'hyperliquid');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fetchedAt).toBe(providerFetchedAt);
    }
  });

  it('stale cache fallback expires after TTL elapses', async () => {
    // Populate cache
    const registry1 = buildRegistry({
      dexData: [makeDexToken('TTL_TEST_TOK', 'solana', 99)],
    });
    const svc1 = createPriceService(registry1);
    await svc1.getPrice('TTL_TEST_TOK', 'solana');

    // Advance time beyond 5-minute TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const registry2 = buildRegistry({ dexThrow: true });
    const svc2 = createPriceService(registry2);

    const result = await svc2.getPrice('TTL_TEST_TOK', 'solana');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.source_failed');
    }

    vi.useRealTimers();
  });

  it('stale cache returns data within TTL window', async () => {
    // Populate cache with unique token
    const registry1 = buildRegistry({
      dexData: [makeDexToken('TTL_FRESH_TOK', 'solana', 77)],
    });
    const svc1 = createPriceService(registry1);
    await svc1.getPrice('TTL_FRESH_TOK', 'solana');

    // Advance time but stay within TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 minutes < 5 minute TTL

    const registry2 = buildRegistry({ dexThrow: true });
    const svc2 = createPriceService(registry2);

    const result = await svc2.getPrice('TTL_FRESH_TOK', 'solana');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('cached');
      expect(result.data.stale).toBe(true);
      expect(result.data.priceUsd).toBe(77);
    }

    vi.useRealTimers();
  });

  it('does not reuse cached price across different same-symbol addresses', async () => {
    const registry1 = buildRegistry({
      dexData: [
        { ...makeDexToken('PEPE', 'solana', 0.00005, 100_000), address: '0xfirst' },
      ],
    });
    const svc1 = createPriceService(registry1);
    await svc1.getPrice('PEPE', 'solana', '0xfirst');

    const registry2 = buildRegistry({ dexThrow: true });
    const svc2 = createPriceService(registry2);

    const result = await svc2.getPrice('PEPE', 'solana', '0xsecond');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.source_failed');
    }
  });
});

describe('createPriceService — resolvePriceTarget (identity + price)', () => {
  it('returns concrete network and address for chain "any"', async () => {
    const registry = buildRegistry({
      dexData: [
        { ...makeDexToken('PEPE', 'solana', 0.00005, 100_000), address: '0xsolana_pepe' },
        { ...makeDexToken('PEPE', 'ethereum', 0.00004, 500_000), address: '0xeth_pepe' },
      ],
    });
    const svc = createPriceService(registry);
    const result = await svc.resolvePriceTarget('PEPE', 'any');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chain).toBe('ethereum'); // highest liquidity
      expect(result.data.address).toBe('0xeth_pepe');
      expect(result.data.symbol).toBe('PEPE');
    }
  });

  it('honors exact address when provided (not just highest liquidity)', async () => {
    const registry = buildRegistry({
      dexData: [
        { ...makeDexToken('PEPE', 'solana', 0.00005, 100_000), address: '0xdiscovered' },
        { ...makeDexToken('PEPE', 'solana', 0.0001, 500_000), address: '0xrich' },
      ],
    });
    const svc = createPriceService(registry);
    const result = await svc.resolvePriceTarget('PEPE', 'solana', '0xdiscovered');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(0.00005);
      expect(result.data.address).toBe('0xdiscovered');
    }
  });

  it('chooses highest-liquidity candidate when no address is given', async () => {
    const registry = buildRegistry({
      dexData: [
        { ...makeDexToken('PEPE', 'solana', 0.00005, 100_000), address: '0xlowsol' },
        { ...makeDexToken('PEPE', 'solana', 0.0001, 500_000), address: '0xhighsol' },
      ],
    });
    const svc = createPriceService(registry);
    const result = await svc.resolvePriceTarget('PEPE', 'solana');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(0.0001);
      expect(result.data.address).toBe('0xhighsol');
    }
  });

  it('returns not_found for unresolvable symbol', async () => {
    const registry = buildRegistry({ dexData: [] });
    const svc = createPriceService(registry);
    const result = await svc.resolvePriceTarget('NONEXISTENT', 'any');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.not_found');
    }
  });

  it('getPrice returns same payload shape as before the refactor', async () => {
    const registry = buildRegistry({
      dexData: [{ ...makeDexToken('SOL', 'solana', 25, 1_000_000), address: '0xsol' }],
    });
    const svc = createPriceService(registry);
    const result = await svc.getPrice('SOL', 'solana');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty('priceUsd');
      expect(result.data).toHaveProperty('source');
      expect(result.data).toHaveProperty('fetchedAt');
      expect(result.data).toHaveProperty('stale');
      // Should NOT have identity fields
      expect(result.data).not.toHaveProperty('symbol');
      expect(result.data).not.toHaveProperty('chain');
      expect(result.data).not.toHaveProperty('address');
    }
  });
});

// ─── Bybit price resolution ──────────────────────────────────────────────────

describe('createPriceService — Bybit execution pricing', () => {
  it('resolves bybit chain via ticker mark price', async () => {
    const registry = buildRegistry({
      bybitTickersData: [makeBybitTicker('BTCUSDT', 67_000)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('BTCUSDT', 'bybit');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.priceUsd).toBe(67_000);
      expect(result.data.source).toBe('execution');
      expect(result.data.stale).toBe(false);
    }
  });

  it('returns error when Bybit ticker symbol not found', async () => {
    const registry = buildRegistry({
      bybitTickersData: [makeBybitTicker('ETHUSDT', 3_500)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('NONEXISTENT', 'bybit');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.not_found');
      expect(result.error.message).toContain('not found on Bybit');
    }
  });

  it('fails closed when Bybit ticker markPrice is null — no DexScreener fallback', async () => {
    const symbol = 'BYBIT_NULLMARK_TST';
    const registry = buildRegistry({
      bybitTickersData: [makeBybitTicker(symbol, null)],
      dexData: [makeDexToken('BTC', 'solana', 67_100)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice(symbol, 'bybit');

    // Must fail — no DexScreener fallback for Bybit
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.not_found');
      expect(result.error.message).toContain('not found on Bybit');
    }
    // Should NOT have called DexScreener
    expect((registry.dexscreener.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('does not fall back to DexScreener when Bybit throws', async () => {
    const symbol = 'BYBIT_THROW_TST';
    const registry = buildRegistry({
      bybitTickersThrow: true,
      dexData: [makeDexToken('BTC', 'solana', 67_100)],
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice(symbol, 'bybit');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.source_failed');
    }
    // Should NOT have called DexScreener
    expect((registry.dexscreener.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('marks stale when Bybit provider reports stale freshness', async () => {
    const registry = buildRegistry({
      bybitTickersData: [makeBybitTicker('BTCUSDT', 67_000)],
      bybitTickersStale: true,
    });
    const svc = createPriceService(registry);

    const result = await svc.getPrice('BTCUSDT', 'bybit');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('execution');
      expect(result.data.stale).toBe(true);
    }
  });

  it('resolvePriceTarget returns bybit chain and execution source', async () => {
    const registry = buildRegistry({
      bybitTickersData: [makeBybitTicker('BTCUSDT', 67_000)],
    });
    const svc = createPriceService(registry);

    const result = await svc.resolvePriceTarget('BTCUSDT', 'bybit');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.symbol).toBe('BTCUSDT');
      expect(result.data.chain).toBe('bybit');
      expect(result.data.priceUsd).toBe(67_000);
      expect(result.data.source).toBe('execution');
      expect(result.data.address).toBeUndefined();
    }
  });

  it('resolvePriceTarget returns error for Bybit when no ticker match', async () => {
    const symbol = 'BYBIT_NOMATCH_TST';
    const registry = buildRegistry({
      bybitTickersData: [],
    });
    const svc = createPriceService(registry);

    const result = await svc.resolvePriceTarget(symbol, 'bybit');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.not_found');
    }
  });

  it('falls back to cached stale data when Bybit live lookup fails', async () => {
    // Populate cache first
    const registry1 = buildRegistry({
      bybitTickersData: [makeBybitTicker('BYBIT_CACHE_TOK', 42)],
    });
    const svc1 = createPriceService(registry1);
    await svc1.getPrice('BYBIT_CACHE_TOK', 'bybit');

    // Failing registry — but module cache still holds the previous entry
    const registry2 = buildRegistry({ bybitTickersThrow: true });
    const svc2 = createPriceService(registry2);

    const result = await svc2.getPrice('BYBIT_CACHE_TOK', 'bybit');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('cached');
      expect(result.data.stale).toBe(true);
      expect(result.data.priceUsd).toBe(42);
    }
  });
});
