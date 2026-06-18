import { describe, it, expect, vi } from 'vitest';
import { resolveSwapTokenData, type DexScreenerProvider, type CanonicalResolver } from '../swap-token-resolver.js';
import type { TokenInfo } from '@herobids/market-data';

function makeToken(overrides: Partial<TokenInfo> & { address: string; network: string }): TokenInfo {
  return {
    address: overrides.address,
    network: overrides.network,
    symbol: overrides.symbol ?? 'UNK',
    name: overrides.name ?? 'Unknown',
    priceUsd: overrides.priceUsd ?? 0,
    volume24hUsd: overrides.volume24hUsd ?? 0,
    liquidityUsd: overrides.liquidityUsd ?? 0,
    priceChange24hPct: overrides.priceChange24hPct ?? 0,
    dexId: overrides.dexId ?? 'unknown',
    poolCreatedAt: overrides.poolCreatedAt,
  };
}

function makeCanonicalResolver(canonicalMap: Record<string, { address: string; symbol: string; name: string }>): CanonicalResolver {
  return {
    resolve(symbol: string, _network: string): { address: string; symbol: string; name: string } | undefined {
      const entry = canonicalMap[symbol.toUpperCase()];
      return entry ? { ...entry, aliases: [], network: 'ethereum' } : undefined;
    },
  };
}

function makeDexScreener(results: TokenInfo[]): DexScreenerProvider {
  return {
    search: async () => ({ data: results }),
  };
}

const BASE_NETWORK = 'ethereum';

describe('resolveSwapTokenData — canonical, symbol, and address resolution', () => {
  it('test-1: canonical lookup succeeds, DexScreener returns no match → synthetic canonical result', async () => {
    const canonical = makeCanonicalResolver({
      ETH: { address: '0xeth-weth', symbol: 'WETH', name: 'Wrapped Ether' },
    });
    const dexscreener = makeDexScreener([]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'ETH', canonical);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xeth-weth');
    expect(result!.symbol).toBe('WETH');
    expect(result!.name).toBe('Wrapped Ether');
    expect(result!.network).toBe(BASE_NETWORK);
    expect(result!.dexId).toBe('canonical');
    expect(result!.ageResolution).toBe('available');
    expect(result!.poolCreatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(result!.liquidityUsd).toBe(Number.MAX_SAFE_INTEGER);
    expect(result!.volume24hUsd).toBe(Number.MAX_SAFE_INTEGER);
    expect(result!.isCanonical).toBe(true);
    expect(result!.hasRealMarketData).toBe(false);
  });

  it('test-2: no canonical match, DexScreener returns no match → null', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'UNKNOWN', canonical);

    expect(result).toBeNull();
  });

  it('test-3: canonical lookup succeeds, DexScreener returns a match → DexScreener data wins', async () => {
    const canonical = makeCanonicalResolver({
      ETH: { address: '0xeth-weth', symbol: 'WETH', name: 'Wrapped Ether' },
    });
    const dexscreener = makeDexScreener([
      makeToken({
        address: '0xeth-weth',
        network: BASE_NETWORK,
        symbol: 'WETH',
        name: 'Wrapped Ether',
        priceUsd: 2500,
        liquidityUsd: 1_000_000,
        poolCreatedAt: '2024-01-15T00:00:00.000Z',
      }),
    ]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'ETH', canonical);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xeth-weth');
    expect(result!.symbol).toBe('WETH');
    expect(result!.priceUsd).toBe(2500);
    expect(result!.liquidityUsd).toBe(1_000_000);
    expect(result!.ageResolution).toBe('available');
  });

  it('test-4: canonical lookup fails, DexScreener returns a match → DexScreener data', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([
      makeToken({
        address: '0xrandom-token',
        network: BASE_NETWORK,
        symbol: 'FOO',
        name: 'Foo Token',
        priceUsd: 0.5,
        liquidityUsd: 50_000,
        poolCreatedAt: '2025-06-01T00:00:00.000Z',
      }),
    ]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, '0xrandom-token', canonical);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xrandom-token');
    expect(result!.symbol).toBe('FOO');
    expect(result!.priceUsd).toBe(0.5);
    expect(result!.ageResolution).toBe('available');
  });

  it('test-5: symbol search succeeds — no canonical match, input is a symbol, DexScreener returns tokens with that symbol on the requested network', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([
      makeToken({
        address: '0xwbtc-real',
        network: BASE_NETWORK,
        symbol: 'WBTC',
        name: 'Wrapped Bitcoin',
        priceUsd: 60_000,
        liquidityUsd: 2_000_000,
        poolCreatedAt: '2023-05-10T00:00:00.000Z',
      }),
    ]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'WBTC', canonical);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xwbtc-real');
    expect(result!.symbol).toBe('WBTC');
    expect(result!.name).toBe('Wrapped Bitcoin');
    expect(result!.priceUsd).toBe(60_000);
    expect(result!.liquidityUsd).toBe(2_000_000);
    expect(result!.network).toBe(BASE_NETWORK);
    expect(result!.ageResolution).toBe('available');
  });

  it('test-6: symbol search returns no match — no canonical match, input is a symbol, DexScreener has no tokens with that symbol on that network', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([
      makeToken({
        address: '0xsome-other',
        network: BASE_NETWORK,
        symbol: 'OTHER',
        name: 'Other Token',
      }),
    ]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'NONEXISTENT', canonical);

    expect(result).toBeNull();
  });

  it('test-7: symbol search picks highest liquidity — multiple tokens with same symbol on same network, highest liquidityUsd wins', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([
      makeToken({
        address: '0xusdc-low',
        network: BASE_NETWORK,
        symbol: 'USDC',
        name: 'USD Coin (low liquidity)',
        liquidityUsd: 100_000,
        priceUsd: 1.0,
      }),
      makeToken({
        address: '0xusdc-high',
        network: BASE_NETWORK,
        symbol: 'USDC',
        name: 'USD Coin (high liquidity)',
        liquidityUsd: 50_000_000,
        priceUsd: 1.0,
      }),
      makeToken({
        address: '0xusdc-mid',
        network: BASE_NETWORK,
        symbol: 'USDC',
        name: 'USD Coin (mid liquidity)',
        liquidityUsd: 5_000_000,
        priceUsd: 1.0,
      }),
    ]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'USDC', canonical);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xusdc-high');
    expect(result!.liquidityUsd).toBe(50_000_000);
    expect(result!.symbol).toBe('USDC');
  });

  it('test-8: address path still works — no canonical match, input looks like an address, DexScreener matches by exact address among multiple results', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([
      makeToken({
        address: '0xabcd1234',
        network: BASE_NETWORK,
        symbol: 'TEST',
        name: 'Test Token',
        liquidityUsd: 10_000,
        poolCreatedAt: '2025-01-01T00:00:00.000Z',
      }),
      makeToken({
        address: '0xdifferent-addr',
        network: BASE_NETWORK,
        symbol: 'OTHER',
        name: 'Other Token',
        liquidityUsd: 50_000,
      }),
    ]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, '0xabcd1234', canonical);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xabcd1234');
    expect(result!.symbol).toBe('TEST');
    expect(result!.liquidityUsd).toBe(10_000);
    expect(result!.ageResolution).toBe('available');
  });
});
