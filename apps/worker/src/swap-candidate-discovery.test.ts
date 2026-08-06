import { describe, it, expect, vi } from 'vitest';
import { discoverSwapScannerCandidates } from './swap-candidate-discovery.js';
import type { SwapDiscoveryPort, SwapDiscoveryLogger, SwapDiscoveryToken } from './swap-candidate-discovery.js';
import type { FilterConfig } from './technical-phase.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): SwapDiscoveryLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeBaseFilters(overrides?: Partial<FilterConfig>): FilterConfig {
  return {
    venue: 'jupiter',
    venueType: 'swap',
    minVolume24hUsd: 10_000,
    minLiquidityUsd: 5_000,
    symbols: [],
    excludeSymbols: [],
    ...overrides,
  } as FilterConfig;
}

function makeToken(overrides?: Partial<SwapDiscoveryToken>): SwapDiscoveryToken {
  return {
    symbol: 'BONK',
    network: 'solana',
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    volume24hUsd: 1_000_000,
    liquidityUsd: 500_000,
    pool: {
      network: 'solana',
      poolAddress: 'pool-abc-123',
      baseToken: {
        symbol: 'BONK',
        address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      },
      quoteToken: {
        symbol: 'USDC',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      },
    },
    ...overrides,
  };
}

function makeDiscovery(overrides?: { discover?: SwapDiscoveryPort['discover'] }): SwapDiscoveryPort {
  return {
    discover: overrides?.discover ?? vi.fn().mockResolvedValue({ data: [] }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('discoverSwapScannerCandidates', () => {
  const baseParams = {
    venue: 'jupiter' as const,
    swapNetwork: 'solana',
    quoteAssetSymbol: 'USDC',
    quoteAssetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    filters: makeBaseFilters(),
    maxCandidates: 50,
    logger: makeLogger(),
  };

  // ── Empty discovery ───────────────────────────────────────────────────────

  it('returns empty result and logs swap_discovery_empty with attribution context when discovery returns no tokens', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({ data: [] }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'scanner.swap_discovery_empty',
        venue: 'jupiter',
        network: 'solana',
        message: expect.stringContaining('provider supply failure'),
      }),
      expect.any(String),
    );
  });

  // ── Discovery error ───────────────────────────────────────────────────────

  it('returns empty result and logs swap_discovery_error when discovery throws', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockRejectedValue(new Error('network timeout')),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scanner.swap_discovery_error' }),
      expect.stringContaining('network timeout'),
    );
  });

  it('handles non-Error discovery rejections', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockRejectedValue('raw string error'),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scanner.swap_discovery_error' }),
      expect.stringContaining('raw string error'),
    );
  });

  // ── Non-pool-backed tokens filtered out ──────────────────────────────────

  it('filters out tokens without a pool', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({ symbol: 'NO_POOL', pool: undefined }),
          makeToken({
            symbol: 'WITH_POOL',
            pool: {
              network: 'solana',
              poolAddress: 'pool-has-pool',
              baseToken: { symbol: 'WITH_POOL', address: 'addr-with-pool' },
              quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('WITH_POOL');
  });

  // ── Non-matching quote asset ──────────────────────────────────────────────

  it('skips tokens with non-matching quote asset symbol', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-1',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111112' },
            },
          }),
          makeToken(),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('BONK');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ poolQuote: 'SOL', expected: 'USDC' }),
      expect.stringContaining('non-matching quote asset'),
    );
  });

  // ── Skip reasons ─────────────────────────────────────────────────────────

  it('skips token with missing_base_address', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-no-base',
              baseToken: { symbol: 'BONK', address: '' },
              quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: expect.arrayContaining(['missing_base_address']),
        event: 'scanner.swap_candidate_skipped',
      }),
      expect.any(String),
    );
  });

  it('skips token with missing_quote_address', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-no-quote',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'USDC', address: '' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: expect.arrayContaining(['missing_quote_address']),
        event: 'scanner.swap_candidate_skipped',
      }),
      expect.any(String),
    );
  });

  it('skips token with missing_pool_address', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: '',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: expect.arrayContaining(['missing_pool_address']),
        event: 'scanner.swap_candidate_skipped',
      }),
      expect.any(String),
    );
  });

  it('skips token with non_canonical_quote', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-wrong-quote',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'USDC', address: 'SomeFakeUSDCAddressNotCanonical' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: expect.arrayContaining(['non_canonical_quote']),
        event: 'scanner.swap_candidate_skipped',
      }),
      expect.any(String),
    );
  });

  it('does not flag non_canonical_quote when quoteAssetAddress is not provided', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-1',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'USDC', address: 'AnyAddressIsFine' },
            },
          }),
        ],
      }),
    });

    // No quoteAssetAddress → canonical check is skipped
    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      quoteAssetAddress: undefined,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('BONK');
  });

  it('skips token with incoherent_pool (network mismatch)', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'ethereum',
              poolAddress: 'pool-eth',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: expect.arrayContaining(['incoherent_pool']),
        event: 'scanner.swap_candidate_skipped',
      }),
      expect.any(String),
    );
  });

  it('aggregates multiple skip reasons on a single token', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'ethereum', // incoherent
              poolAddress: '',      // missing
              baseToken: { symbol: 'BONK', address: '' },   // missing
              quoteToken: { symbol: 'USDC', address: '' },   // missing
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.event === 'scanner.swap_candidate_skipped',
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0].reasons).toEqual(
      expect.arrayContaining([
        'missing_base_address',
        'missing_quote_address',
        'missing_pool_address',
        'incoherent_pool',
      ]),
    );
  });

  // ── Deduplication ─────────────────────────────────────────────────────────

  it('deduplicates by network:poolAddress', async () => {
    const logger = makeLogger();
    // Two tokens sharing the same pool
    const sharedPool = {
      network: 'solana',
      poolAddress: 'shared-pool-1',
      baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
      quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    };

    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({ symbol: 'BONK', pool: sharedPool }),
          makeToken({ symbol: 'BONK_DUP', pool: sharedPool }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('BONK');
  });

  // ── Sort and cap ─────────────────────────────────────────────────────────

  it('sorts by volume24hUsd descending and caps to maxCandidates', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({ symbol: 'LOW', volume24hUsd: 100_000, pool: { network: 'solana', poolAddress: 'p-low', baseToken: { symbol: 'LOW', address: 'addr-low' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } }),
          makeToken({ symbol: 'HIGH', volume24hUsd: 5_000_000, pool: { network: 'solana', poolAddress: 'p-high', baseToken: { symbol: 'HIGH', address: 'addr-high' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } }),
          makeToken({ symbol: 'MID', volume24hUsd: 1_000_000, pool: { network: 'solana', poolAddress: 'p-mid', baseToken: { symbol: 'MID', address: 'addr-mid' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      maxCandidates: 2,
      discovery,
      logger,
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.symbol).toBe('HIGH');
    expect(result[1]!.symbol).toBe('MID');
  });

  // ── Post-filters ─────────────────────────────────────────────────────────

  it('applies minVolume24hUsd post-filter', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            symbol: 'LOW_VOL', volume24hUsd: 1_000,
            pool: { network: 'solana', poolAddress: 'p-low', baseToken: { symbol: 'LOW_VOL', address: 'addr-low' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
          }),
          makeToken({
            symbol: 'HIGH_VOL', volume24hUsd: 500_000,
            pool: { network: 'solana', poolAddress: 'p-high', baseToken: { symbol: 'HIGH_VOL', address: 'addr-high' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      filters: makeBaseFilters({ minVolume24hUsd: 10_000 }),
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('HIGH_VOL');
  });

  it('applies symbols allowlist post-filter', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [makeToken({ symbol: 'BONK' }), makeToken({ symbol: 'WIF' })],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      filters: makeBaseFilters({ symbols: ['BONK'] }),
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('BONK');
  });

  it('applies excludeSymbols post-filter', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [makeToken({ symbol: 'BONK' }), makeToken({ symbol: 'SCAM' })],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      filters: makeBaseFilters({ excludeSymbols: ['SCAM'] }),
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('BONK');
  });

  it('applies minLiquidityUsd post-filter', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            symbol: 'LOW_LIQ', liquidityUsd: 100,
            pool: { network: 'solana', poolAddress: 'p-low-liq', baseToken: { symbol: 'LOW_LIQ', address: 'addr-low-liq' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
          }),
          makeToken({
            symbol: 'HIGH_LIQ', liquidityUsd: 50_000,
            pool: { network: 'solana', poolAddress: 'p-high-liq', baseToken: { symbol: 'HIGH_LIQ', address: 'addr-high-liq' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      filters: makeBaseFilters({ minLiquidityUsd: 5_000 }),
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('HIGH_LIQ');
  });

  // ── Instrument ID format ──────────────────────────────────────────────────

  it('produces exact instrumentId format: SYM:BASEADDR/QUOTE:QUOTEADDR', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({ data: [makeToken()] }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.instrumentId).toBe(
      'BONK:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  // ── Candidate shape ──────────────────────────────────────────────────────

  it('populates all candidate fields from the token', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            symbol: 'WIF',
            network: 'solana',
            volume24hUsd: 2_000_000,
            liquidityUsd: 800_000,
            priceChange24hPct: 5.5,
            pool: {
              network: 'solana',
              poolAddress: 'pool-wif-1',
              baseToken: { symbol: 'WIF', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
              quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    const c = result[0]!;
    expect(c.symbol).toBe('WIF');
    expect(c.venue).toBe('jupiter');
    expect(c.venueType).toBe('swap');
    expect(c.volume24hUsd).toBe(2_000_000);
    expect(c.liquidityUsd).toBe(800_000);
    expect(c.priceChange24hPct).toBe(5.5);
    expect(c.candleTarget).toEqual({
      venueType: 'swap',
      network: 'solana',
      poolAddress: 'pool-wif-1',
    });
    expect(c.pricingIdentity).toEqual({
      kind: 'dex',
      symbol: 'WIF',
      chain: 'solana',
      address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    });
    expect(c.swapExecutionIdentity).toEqual({
      network: 'solana',
      baseSymbol: 'WIF',
      baseAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
      quoteSymbol: 'USDC',
      quoteAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
  });

  // ── Zero value handling ──────────────────────────────────────────────────

  it('omits volume24hUsd when zero', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [makeToken({
          symbol: 'ZERO_VOL',
          volume24hUsd: 0,
          pool: { network: 'solana', poolAddress: 'p-zero-vol', baseToken: { symbol: 'ZERO_VOL', address: 'addr-zero-vol' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
        })],
      }),
    });

    // Use filters with no post-filter thresholds so the zero-volume token passes
    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      filters: makeBaseFilters({ minVolume24hUsd: undefined, minLiquidityUsd: undefined }),
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.volume24hUsd).toBeUndefined();
  });

  it('omits liquidityUsd when zero', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [makeToken({
          symbol: 'ZERO_LIQ',
          liquidityUsd: 0,
          pool: { network: 'solana', poolAddress: 'p-zero-liq', baseToken: { symbol: 'ZERO_LIQ', address: 'addr-zero-liq' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
        })],
      }),
    });

    // Use filters with no post-filter thresholds so the zero-liquidity token passes
    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      filters: makeBaseFilters({ minVolume24hUsd: undefined, minLiquidityUsd: undefined }),
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.liquidityUsd).toBeUndefined();
  });

  it('omits priceChange24hPct when zero or undefined', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({ priceChange24hPct: 0 }),
          makeToken({ symbol: 'WIF', priceChange24hPct: undefined, pool: { network: 'solana', poolAddress: 'p-wif', baseToken: { symbol: 'WIF', address: 'addr-wif' }, quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.priceChange24hPct).toBeUndefined();
    expect(result[1]!.priceChange24hPct).toBeUndefined();
  });

  // ── Case insensitivity ───────────────────────────────────────────────────

  it('matches quote asset symbol case-insensitively', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-1',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'usdc', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
  });

  it('matches canonical quote address case-insensitively', async () => {
    const logger = makeLogger();
    // Use well-known constant addresses to avoid typo-related failures
    const canonicalUsdc = 'So11111111111111111111111111111111111111112'; // fake but consistent
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          makeToken({
            pool: {
              network: 'solana',
              poolAddress: 'pool-case-test',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              // Lowercase version of the canonical address — should still match
              quoteToken: { symbol: 'USDC', address: canonicalUsdc.toLowerCase() },
            },
          }),
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      quoteAssetAddress: canonicalUsdc,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
  });

  // ── Base network regression tests (Phase 4+1+3 validation) ─────────────────

  const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  /**
   * Test (a): Regression — swap scanner obtains Base candidates when discovery
   * returns both noisy Solana DexScreener results and valid Base pool-backed tokens.
   * Validates the end-to-end pipeline after Phase 4 (supply) + Phase 1 (network filter).
   */
  it('filters out Solana tokens and returns only Base candidates when discovery returns mixed networks', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          // Solana noise — should be filtered as incoherent_pool (network mismatch)
          {
            symbol: 'BONK',
            network: 'solana',
            address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
            volume24hUsd: 5_000_000,
            liquidityUsd: 1_000_000,
            pool: {
              network: 'solana',
              poolAddress: 'sol-pool-bonk',
              baseToken: { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
              quoteToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            },
          },
          // Valid Base pool-backed token
          {
            symbol: 'DEGEN',
            network: 'base',
            address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
            volume24hUsd: 1_200_000,
            liquidityUsd: 300_000,
            pool: {
              network: 'base',
              poolAddress: '0xpool-degen-base-001',
              baseToken: { symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
              quoteToken: { symbol: 'USDC', address: baseUsdc },
            },
          },
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      venue: '1inch',
      swapNetwork: 'base',
      quoteAssetAddress: baseUsdc,
      discovery,
      logger,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('DEGEN');
    expect(result[0]!.swapExecutionIdentity?.network).toBe('base');
    // Solana token should be warned as incoherent_pool
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: expect.arrayContaining(['incoherent_pool']),
        token: 'BONK',
        event: 'scanner.swap_candidate_skipped',
      }),
      expect.any(String),
    );
  });

  /**
   * Test (b): Reproduce-the-bug — with GeckoTerminal Base 429'd (empty discovery),
   * the scanner logs an attributed empty result. Validates Phase 3 scanner attribution.
   */
  it('logs attributed swap_discovery_empty when Base discovery returns no tokens (simulated GeckoTerminal 429)', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({ data: [] }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      venue: '1inch',
      swapNetwork: 'base',
      quoteAssetAddress: baseUsdc,
      discovery,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'scanner.swap_discovery_empty',
        venue: '1inch',
        network: 'base',
        message: expect.stringContaining('provider supply failure'),
      }),
      expect.any(String),
    );
  });

  /**
   * Test (c): Positive path — with valid Base pool-backed tokens in discovery,
   * the scanner obtains non-empty Base candidates.
   */
  it('returns non-empty Base candidates when discovery provides valid Base pool-backed tokens', async () => {
    const logger = makeLogger();
    const discovery = makeDiscovery({
      discover: vi.fn().mockResolvedValue({
        data: [
          {
            symbol: 'DEGEN',
            network: 'base',
            address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
            volume24hUsd: 1_200_000,
            liquidityUsd: 300_000,
            pool: {
              network: 'base',
              poolAddress: '0xpool-degen-base-001',
              baseToken: { symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
              quoteToken: { symbol: 'USDC', address: baseUsdc },
            },
          },
          {
            symbol: 'AERO',
            network: 'base',
            address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
            volume24hUsd: 3_500_000,
            liquidityUsd: 800_000,
            pool: {
              network: 'base',
              poolAddress: '0xpool-aero-base-002',
              baseToken: { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
              quoteToken: { symbol: 'USDC', address: baseUsdc },
            },
          },
        ],
      }),
    });

    const result = await discoverSwapScannerCandidates({
      ...baseParams,
      venue: '1inch',
      swapNetwork: 'base',
      quoteAssetAddress: baseUsdc,
      discovery,
      logger,
    });

    expect(result).toHaveLength(2);
    // Sorted by volume descending
    expect(result[0]!.symbol).toBe('AERO');
    expect(result[0]!.swapExecutionIdentity?.network).toBe('base');
    expect(result[1]!.symbol).toBe('DEGEN');
    expect(result[1]!.swapExecutionIdentity?.network).toBe('base');
  });
});
