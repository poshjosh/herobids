import { describe, it, expect } from 'vitest';
import {
  computeUniverseScopeHash,
  createSegmentKey,
  segmentKeyFromTechnicalConfig,
} from './market-assessment.js';
import type { TechnicalConfig } from './config/schema.js';

describe('computeUniverseScopeHash', () => {
  it('produces the same hash for identical inputs', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 1_000_000,
      networks: ['ethereum', 'arbitrum'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 1_000_000,
      networks: ['arbitrum', 'ethereum'], // different order
    });
    expect(h1).toBe(h2); // normalized sorting ensures determinism
  });

  it('produces different hashes for different venue families', () => {
    const h1 = computeUniverseScopeHash({ venueFamily: 'hyperliquid-orderbook' });
    const h2 = computeUniverseScopeHash({ venueFamily: 'bybit-orderbook' });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different volume thresholds', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 1_000_000,
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 10_000_000,
    });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different symbol lists', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['BTC', 'ETH'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['BTC', 'ETH', 'SOL'],
    });
    expect(h1).not.toBe(h2);
  });

  it('produces same hash regardless of symbol list order', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['SOL', 'ETH', 'BTC'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['BTC', 'ETH', 'SOL'],
    });
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different network lists', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['ethereum', 'arbitrum'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['ethereum', 'arbitrum', 'polygon'],
    });
    expect(h1).not.toBe(h2);
  });

  it('produces same hash regardless of network list order', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['arbitrum', 'ethereum'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['ethereum', 'arbitrum'],
    });
    expect(h1).toBe(h2);
  });

  it('excludes null/undefined optional fields from hash', () => {
    const h1 = computeUniverseScopeHash({ venueFamily: 'hyperliquid-orderbook' });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: undefined,
    });
    expect(h1).toBe(h2);
  });

  it('treats zero volume threshold same as unset', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 0,
      minLiquidityUsd: 0,
    });
    expect(h1).toBe(h2);
  });

  it('returns a 16-character hex string', () => {
    const hash = computeUniverseScopeHash({ venueFamily: 'hyperliquid-orderbook' });
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('createSegmentKey', () => {
  it('creates a segment key with all three components', () => {
    const key = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'standard',
      networks: ['ethereum'],
    });
    expect(key.venueFamily).toBe('hyperliquid-orderbook');
    expect(key.styleTier).toBe('standard');
    expect(key.universeScopeHash).toHaveLength(16);
  });

  it('produces the same key for equivalent inputs', () => {
    const k1 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'economy',
      symbols: ['BTC', 'ETH'],
    });
    const k2 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'economy',
      symbols: ['ETH', 'BTC'],
    });
    expect(k1).toEqual(k2);
  });

  it('produces different keys for different style tiers', () => {
    const k1 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'economy',
    });
    const k2 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'premium',
    });
    expect(k1).not.toEqual(k2);
  });
});

describe('segmentKeyFromTechnicalConfig', () => {
  it('derives a correct segment key from a minimal technical config', () => {
    const config = {
      filters: {
        venue: 'hyperliquid',
        venueType: 'orderbook' as const,
      },
    } as TechnicalConfig;
    const key = segmentKeyFromTechnicalConfig(config, 'standard');
    expect(key.venueFamily).toBe('hyperliquid-orderbook');
    expect(key.styleTier).toBe('standard');
    expect(key.universeScopeHash).toHaveLength(16);
  });

  it('includes all discovery filters in the hash', () => {
    const fullConfig = {
      filters: {
        venue: 'hyperliquid',
        venueType: 'orderbook' as const,
        minVolume24hUsd: 5_000_000,
        minLiquidityUsd: 500_000,
        networks: ['ethereum', 'arbitrum'],
        symbols: ['BTC', 'ETH'],
        excludeSymbols: ['DOGE'],
      },
    } as TechnicalConfig;
    const key = segmentKeyFromTechnicalConfig(fullConfig, 'premium');
    expect(key.universeScopeHash).toHaveLength(16);

    const minimalKey = segmentKeyFromTechnicalConfig(
      { filters: { venue: 'hyperliquid', venueType: 'orderbook' } } as TechnicalConfig,
      'premium',
    );
    expect(key.universeScopeHash).not.toBe(minimalKey.universeScopeHash);
  });
});
