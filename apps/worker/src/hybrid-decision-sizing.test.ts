import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHybridTargetSize } from './hybrid-decision-sizing.js';
import type { PriceService } from './traderton/price-contracts.js';
import type { HybridPricingIdentity } from './runtime-composition.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePriceService(overrides?: {
  priceUsd?: number;
  source?: 'execution' | 'oracle' | 'cached';
  stale?: boolean;
  symbol?: string;
  chain?: string;
  address?: string;
  errorCode?: string;
  errorMessage?: string;
}): PriceService {
  return {
    getPrice: vi.fn(),
    resolvePriceTarget: vi.fn().mockResolvedValue(
      overrides?.errorCode
        ? {
            ok: false as const,
            error: { code: overrides.errorCode, message: overrides.errorMessage ?? 'Not found' },
          }
        : {
            ok: true as const,
            data: {
              symbol: overrides?.symbol ?? 'BTC',
              chain: overrides?.chain ?? 'hyperliquid',
              address: overrides?.address,
              priceUsd: overrides?.priceUsd ?? 2500,
              source: overrides?.source ?? 'execution',
              fetchedAt: new Date().toISOString(),
              stale: overrides?.stale ?? false,
            },
          },
    ),
  };
}

function makePerpIdentity(symbol = 'BTC'): HybridPricingIdentity {
  return { kind: 'perps', symbol, chain: 'hyperliquid' };
}

function makeDexIdentity(symbol = 'USDC', chain = 'solana', address?: string): HybridPricingIdentity {
  return { kind: 'dex', symbol, chain, address };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('resolveHybridTargetSize', () => {
  let priceService: PriceService;

  beforeEach(() => {
    priceService = makePriceService();
  });

  // ── Successful conversions ──────────────────────────────────────────────

  it('converts $50 at $2500 to 0.02 (perps)', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: 50,
      priceService: makePriceService({ priceUsd: 2500 }),
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetSize).toBe('0.020000000000000000');
      expect(result.priceUsd).toBe(2500);
      expect(result.source).toBe('execution');
    }
  });

  it('converts $100 at $100 to 1', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'SOL-PERP',
      sizeUsd: 100,
      priceService: makePriceService({ priceUsd: 100 }),
      pricingIdentity: makePerpIdentity('SOL'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetSize).toBe('1.000000000000000000');
      expect(result.priceUsd).toBe(100);
    }
  });

  it('converts $25 at $0.50 to 50', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'MEME-PERP',
      sizeUsd: 25,
      priceService: makePriceService({ priceUsd: 0.5 }),
      pricingIdentity: makePerpIdentity('MEME'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetSize).toBe('50.000000000000000000');
    }
  });

  it('passes chain and address for DEX lookup when available', async () => {
    const svc = makePriceService({ priceUsd: 1.2, source: 'oracle', chain: 'solana', symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    const resolveSpy = vi.spyOn(svc, 'resolvePriceTarget');

    const result = await resolveHybridTargetSize({
      instrumentId: 'USDC-SOL',
      sizeUsd: 120,
      priceService: svc,
      pricingIdentity: makeDexIdentity('USDC', 'solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetSize).toBe('100.000000000000000000');
      expect(result.resolvedChain).toBe('solana');
    }
    expect(resolveSpy).toHaveBeenCalledWith('USDC', 'solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('uses hyperliquid chain for perp pricing', async () => {
    const svc = makePriceService({ priceUsd: 3000 });
    const resolveSpy = vi.spyOn(svc, 'resolvePriceTarget');

    await resolveHybridTargetSize({
      instrumentId: 'ETH-PERP',
      sizeUsd: 300,
      priceService: svc,
      pricingIdentity: makePerpIdentity('ETH'),
    });

    expect(resolveSpy).toHaveBeenCalledWith('ETH', 'hyperliquid', undefined);
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it('rejects non-positive sizeUsd (zero)', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: 0,
      priceService,
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.invalid_size_usd');
    }
  });

  it('rejects non-positive sizeUsd (negative)', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: -10,
      priceService,
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.invalid_size_usd');
    }
  });

  it('rejects NaN sizeUsd', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: NaN,
      priceService,
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.invalid_size_usd');
    }
  });

  it('rejects Infinity sizeUsd', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: Infinity,
      priceService,
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.invalid_size_usd');
    }
  });

  it('rejects DEX signal missing chain identity', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'MEME-DEX',
      sizeUsd: 100,
      priceService,
      pricingIdentity: { kind: 'dex', symbol: 'MEME' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.dex_missing_chain');
    }
  });

  it('rejects missing price lookup', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'UNKNOWN-PERP',
      sizeUsd: 100,
      priceService: makePriceService({ errorCode: 'price.not_found', errorMessage: 'Not found' }),
      pricingIdentity: makePerpIdentity('UNKNOWN'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toContain('price_lookup_failed');
    }
  });

  it('rejects stale price', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: 100,
      priceService: makePriceService({ priceUsd: 2500, stale: true }),
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.stale_price');
    }
  });

  it('rejects zero price', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: 100,
      priceService: makePriceService({ priceUsd: 0 }),
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.invalid_price');
    }
  });

  it('rejects negative price', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: 100,
      priceService: makePriceService({ priceUsd: -1 }),
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sizing.invalid_price');
    }
  });

  it('returns metadata fields on success', async () => {
    const result = await resolveHybridTargetSize({
      instrumentId: 'ETH-PERP',
      sizeUsd: 600,
      priceService: makePriceService({
        priceUsd: 3000,
        source: 'execution',
        symbol: 'ETH',
        chain: 'hyperliquid',
      }),
      pricingIdentity: makePerpIdentity('ETH'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetSize).toBe('0.200000000000000000');
      expect(result.priceUsd).toBe(3000);
      expect(result.source).toBe('execution');
      expect(result.resolvedSymbol).toBe('ETH');
      expect(result.resolvedChain).toBe('hyperliquid');
      expect(result.resolvedAddress).toBeUndefined();
    }
  });

  it('produces a plain decimal string (no scientific notation)', async () => {
    // Very small sizeUsd / large priceUsd could produce scientific notation
    // with .toString().  .toFixed() must keep it decimal.
    const result = await resolveHybridTargetSize({
      instrumentId: 'BTC-PERP',
      sizeUsd: 0.01,
      priceService: makePriceService({ priceUsd: 100_000_000 }),
      pricingIdentity: makePerpIdentity('BTC'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must be a plain decimal, not like '1e-10'
      expect(result.targetSize).not.toContain('e');
      expect(result.targetSize).toMatch(/^\d+\.\d+$/);
    }
  });
});
