import { describe, it, expect, vi } from 'vitest';
import { discoverScannerCandidates } from './scanner-candidate-discovery.js';
import type { ProviderRegistry } from '@herobids/market-data';
import type { FilterConfig } from './technical-phase.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHyperliquidAsset(overrides: {
  asset: string;
  markPrice?: number | null;
  volume24hUsd?: number | null;
  priceChange24hPct?: number | null;
}) {
  return {
    asset: overrides.asset,
    markPrice: overrides.markPrice ?? 100,
    fundingRate: 0.0001,
    annualizedFundingRatePct: 10,
    openInterest: 500,
    midPrice: 100,
    oraclePrice: 100,
    markOracleSpreadPct: 0,
    volume24hUsd: overrides.volume24hUsd ?? 1_000_000,
    prevDayPrice: 100,
    priceChange24hPct: overrides.priceChange24hPct ?? 1.5,
  };
}

function makeBybitTicker(overrides: {
  symbol: string;
  markPrice?: number | null;
  volume24hUsd?: number | null;
  priceChange24hPct?: number | null;
}) {
  return {
    symbol: overrides.symbol,
    markPrice: overrides.markPrice ?? 100,
    lastPrice: 100,
    volume24hUsd: overrides.volume24hUsd ?? 1_000_000,
    priceChange24hPct: overrides.priceChange24hPct ?? 1.5,
  };
}

const defaultMeta = {
  freshness: { isStale: false, ageMs: 0, fetchedAt: '2026-07-17T12:00:00.000Z' },
  provider: 'hyperliquid' as const,
};

function buildRegistry(overrides: {
  hyperliquidAssets?: ReturnType<typeof makeHyperliquidAsset>[];
  bybitTickers?: ReturnType<typeof makeBybitTicker>[];
} = {}): ProviderRegistry {
  return {
    hyperliquid: {
      assetContexts: vi.fn().mockResolvedValue({
        data: overrides.hyperliquidAssets ?? [],
        meta: defaultMeta,
      }),
    },
    bybit: {
      tickers: vi.fn().mockResolvedValue({
        data: overrides.bybitTickers ?? [],
        meta: { ...defaultMeta, provider: 'bybit' as const },
      }),
      longShortRatio: vi.fn(),
    },
  } as unknown as ProviderRegistry;
}

const baseFilters: FilterConfig = { venue: 'hyperliquid', venueType: 'orderbook' };

// ─── Hyperliquid path ───────────────────────────────────────────────────────

describe('discoverScannerCandidates — Hyperliquid', () => {
  it('discovers candidates from Hyperliquid asset contexts', async () => {
    const registry = buildRegistry({
      hyperliquidAssets: [
        makeHyperliquidAsset({ asset: 'BTC', volume24hUsd: 5_000_000 }),
        makeHyperliquidAsset({ asset: 'ETH', volume24hUsd: 3_000_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'hyperliquid',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.symbol).toBe('BTC');
    expect(results[0]!.instrumentId).toBe('BTC-PERP');
    expect(results[0]!.venue).toBe('hyperliquid');
    expect(results[0]!.venueType).toBe('orderbook');
    expect(results[0]!.pricingIdentity).toEqual({
      kind: 'perps',
      symbol: 'BTC',
      chain: 'hyperliquid',
    });
  });

  it('sorts Hyperliquid candidates by volume24hUsd descending', async () => {
    const registry = buildRegistry({
      hyperliquidAssets: [
        makeHyperliquidAsset({ asset: 'LOW', volume24hUsd: 1_000 }),
        makeHyperliquidAsset({ asset: 'MID', volume24hUsd: 5_000 }),
        makeHyperliquidAsset({ asset: 'HIGH', volume24hUsd: 10_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'hyperliquid',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.symbol).toBe('HIGH');
    expect(results[1]!.symbol).toBe('MID');
    expect(results[2]!.symbol).toBe('LOW');
  });

  it('applies maxCandidates bounding on Hyperliquid results', async () => {
    const registry = buildRegistry({
      hyperliquidAssets: [
        makeHyperliquidAsset({ asset: 'A', volume24hUsd: 10 }),
        makeHyperliquidAsset({ asset: 'B', volume24hUsd: 9 }),
        makeHyperliquidAsset({ asset: 'C', volume24hUsd: 8 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'hyperliquid',
      bindingVenueType: 'orderbook',
      maxCandidates: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.symbol).toBe('A');
    expect(results[1]!.symbol).toBe('B');
  });
});

// ─── Bybit path ──────────────────────────────────────────────────────────────

describe('discoverScannerCandidates — Bybit', () => {
  it('discovers candidates from Bybit tickers', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'BTCUSDT', volume24hUsd: 5_000_000 }),
        makeBybitTicker({ symbol: 'ETHUSDT', volume24hUsd: 3_000_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.symbol).toBe('BTC');
    expect(results[0]!.instrumentId).toBe('BTCUSDT');
    expect(results[0]!.venue).toBe('bybit');
    expect(results[0]!.venueType).toBe('orderbook');
    expect(results[0]!.pricingIdentity).toEqual({
      kind: 'perps',
      symbol: 'BTCUSDT',
      chain: 'bybit',
    });
  });

  it('parses base symbol from Bybit pair (BTCUSDT → BTC)', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'SOLUSDT', volume24hUsd: 1_000_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results[0]!.symbol).toBe('SOL');
    expect(results[0]!.instrumentId).toBe('SOLUSDT');
  });

  it('parses base symbol from Bybit pair with PERP suffix', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'DOGEPERP', volume24hUsd: 500_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results[0]!.symbol).toBe('DOGE');
    expect(results[0]!.instrumentId).toBe('DOGEPERP');
  });

  it('sorts Bybit candidates by volume24hUsd descending', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'LOWUSDT', volume24hUsd: 1_000 }),
        makeBybitTicker({ symbol: 'HIGHUSDT', volume24hUsd: 10_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results[0]!.symbol).toBe('HIGH');
    expect(results[1]!.symbol).toBe('LOW');
  });

  it('applies maxCandidates bounding on Bybit results', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'AUSDT', volume24hUsd: 10 }),
        makeBybitTicker({ symbol: 'BUSDT', volume24hUsd: 9 }),
        makeBybitTicker({ symbol: 'CUSDT', volume24hUsd: 8 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 2,
    });

    expect(results).toHaveLength(2);
  });
});

// ─── Filter application (venue-agnostic) ─────────────────────────────────────

describe('discoverScannerCandidates — filters', () => {
  it('filters candidates by minVolume24hUsd', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'HIGHUSDT', volume24hUsd: 10_000_000 }),
        makeBybitTicker({ symbol: 'LOWUSDT', volume24hUsd: 500_000 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: { ...baseFilters, minVolume24hUsd: 1_000_000 },
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe('HIGH');
  });

  it('filters candidates by symbols whitelist', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'BTCUSDT' }),
        makeBybitTicker({ symbol: 'ETHUSDT' }),
        makeBybitTicker({ symbol: 'SOLUSDT' }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: { ...baseFilters, symbols: ['BTC', 'SOL'] },
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(2);
    const symbols = results.map((r) => r.symbol);
    expect(symbols).toContain('BTC');
    expect(symbols).toContain('SOL');
    expect(symbols).not.toContain('ETH');
  });

  it('filters candidates by excludeSymbols blacklist', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'BTCUSDT' }),
        makeBybitTicker({ symbol: 'ETHUSDT' }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: { ...baseFilters, excludeSymbols: ['ETH'] },
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe('BTC');
  });

  it('applies both whitelist and blacklist when both are configured', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'BTCUSDT' }),
        makeBybitTicker({ symbol: 'ETHUSDT' }),
        makeBybitTicker({ symbol: 'SOLUSDT' }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: { ...baseFilters, symbols: ['BTC', 'SOL'], excludeSymbols: ['SOL'] },
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe('BTC');
  });

  it('returns empty array when all candidates filtered out', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'LOWUSDT', volume24hUsd: 10 }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: { ...baseFilters, minVolume24hUsd: 1_000_000 },
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results).toEqual([]);
  });

  it('discovery preserves pricingIdentity on Hyperliquid path', async () => {
    const registry = buildRegistry({
      hyperliquidAssets: [
        makeHyperliquidAsset({ asset: 'BTC' }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'hyperliquid',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results[0]!.pricingIdentity).toEqual({
      kind: 'perps',
      symbol: 'BTC',
      chain: 'hyperliquid',
    });
  });

  it('discovery preserves pricingIdentity on Bybit path', async () => {
    const registry = buildRegistry({
      bybitTickers: [
        makeBybitTicker({ symbol: 'BTCUSDT' }),
      ],
    });

    const results = await discoverScannerCandidates({
      registry,
      filters: baseFilters,
      bindingVenue: 'bybit',
      bindingVenueType: 'orderbook',
      maxCandidates: 10,
    });

    expect(results[0]!.pricingIdentity).toEqual({
      kind: 'perps',
      symbol: 'BTCUSDT',
      chain: 'bybit',
    });
  });
});
