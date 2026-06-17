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
    resolve(symbol: string): { address: string; symbol: string; name: string } | undefined {
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
const EMPTY_CONFIG = {} as Parameters<typeof resolveSwapTokenData>[4];

describe('resolveSwapTokenData — canonical fallback', () => {
  it('test-1: canonical lookup succeeds, DexScreener returns no match → synthetic canonical result', async () => {
    const canonical = makeCanonicalResolver({
      ETH: { address: '0xeth-weth', symbol: 'WETH', name: 'Wrapped Ether' },
    });
    const dexscreener = makeDexScreener([]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'ETH', canonical, EMPTY_CONFIG);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xeth-weth');
    expect(result!.symbol).toBe('WETH');
    expect(result!.name).toBe('Wrapped Ether');
    expect(result!.network).toBe(BASE_NETWORK);
    expect(result!.dexId).toBe('canonical');
    expect(result!.ageResolution).toBe('available');
    expect(result!.poolCreatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(result!.liquidityUsd).toBe(0);
    expect(result!.volume24hUsd).toBe(0);
    expect(result!.isCanonical).toBe(true);
    expect(result!.hasRealMarketData).toBe(false);
  });

  it('test-2: no canonical match, DexScreener returns no match → null', async () => {
    const canonical = makeCanonicalResolver({});
    const dexscreener = makeDexScreener([]);

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'UNKNOWN', canonical, EMPTY_CONFIG);

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

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, 'ETH', canonical, EMPTY_CONFIG);

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

    const result = await resolveSwapTokenData(dexscreener, BASE_NETWORK, '0xrandom-token', canonical, EMPTY_CONFIG);

    expect(result).not.toBeNull();
    expect(result!.address).toBe('0xrandom-token');
    expect(result!.symbol).toBe('FOO');
    expect(result!.priceUsd).toBe(0.5);
    expect(result!.ageResolution).toBe('available');
  });
});
