import { describe, expect, it, vi } from 'vitest';
import { createBoundaryPriceService } from './hybrid-price-adapter.js';
import type { TradertonReadBoundary } from './read-adapter.js';
import type { TradertonReadResult } from '@herobids/domain';
import { resolveHybridTargetSize } from '../hybrid-decision-sizing.js';
import type { HybridPricingIdentity } from '../runtime-composition.js';

function makeBoundary(invoke: TradertonReadBoundary['invoke']): TradertonReadBoundary {
  return { invoke };
}

function successPayload(overrides?: Partial<Record<string, unknown>>): TradertonReadResult {
  return {
    kind: 'success',
    data: {
      ok: true,
      symbol: 'PEPE',
      chain: 'ethereum',
      address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      name: 'Pepe',
      priceUsd: 0.00001,
      source: 'oracle',
      fetchedAt: '2026-09-12T00:00:00.000Z',
      stale: false,
      ...overrides,
    },
  };
}

describe('createBoundaryPriceService — resolvePriceTarget', () => {
  it('forwards {symbol, chain} to the resolve_price_target tool and narrows the resolved identity', async () => {
    const invoke = vi.fn().mockResolvedValue(successPayload());
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('PEPE', 'any');

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'resolve_price_target',
      payload: { symbol: 'PEPE', chain: 'any' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Resolved identity comes from the tool payload, not the input echo.
      expect(result.data.symbol).toBe('PEPE');
      expect(result.data.chain).toBe('ethereum');
      expect(result.data.address).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
      expect(result.data.name).toBe('Pepe');
      expect(result.data.priceUsd).toBe(0.00001);
      expect(result.data.source).toBe('oracle');
      expect(result.data.stale).toBe(false);
    }
  });

  it('forwards the pinned address AS the symbol so the tool re-detects it', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const invoke = vi.fn().mockResolvedValue(
      successPayload({ symbol: 'USDC', chain: 'solana', address: mint, source: 'oracle', priceUsd: 1 }),
    );
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    await svc.resolvePriceTarget('USDC', 'solana', mint);

    // Ticker symbol AND pinned address are forwarded SEPARATELY (not collapsed):
    // the resolver searches by ticker then prefers the exact-address match.
    expect(invoke).toHaveBeenCalledWith({
      toolName: 'resolve_price_target',
      payload: { symbol: 'USDC', chain: 'solana', address: mint },
    });
  });

  it('forwards the ticker symbol when no address is pinned', async () => {
    const invoke = vi.fn().mockResolvedValue(successPayload({ symbol: 'BTC', chain: 'hyperliquid', source: 'execution', address: undefined, name: undefined }));
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    await svc.resolvePriceTarget('BTC', 'hyperliquid');

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'resolve_price_target',
      payload: { symbol: 'BTC', chain: 'hyperliquid' },
    });
  });

  it('maps a boundary failure into a not-ok price result preserving code + message', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'failure',
      code: 'price.not_found',
      message: 'not found',
      retryable: false,
    } satisfies TradertonReadResult);
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('NOPE', 'solana');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.not_found');
      expect(result.error.message).toBe('not found');
    }
  });

  it('maps a transport_error into a transport-coded price error', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'transport_error',
      message: 'connection reset',
      retryable: true,
    } satisfies TradertonReadResult);
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('SOL', 'solana');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.transport_error');
      expect(result.error.message).toBe('connection reset');
    }
  });

  it('maps in_progress into a fail-closed price error', async () => {
    const invoke = vi.fn().mockResolvedValue({ kind: 'in_progress' } satisfies TradertonReadResult);
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('SOL', 'solana');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.in_progress');
    }
  });

  it('maps a thrown invoke into a transport error rather than throwing', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'));
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('SOL', 'solana');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.transport_error');
      expect(result.error.message).toBe('boom');
    }
  });

  it('fails closed when the success payload is missing required fields', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'success',
      data: { ok: true, symbol: 'PEPE', chain: 'ethereum' /* no priceUsd/source/... */ },
    } satisfies TradertonReadResult);
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('PEPE', 'ethereum');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.malformed');
    }
  });

  it('fails closed when the payload is not an object', async () => {
    const invoke = vi.fn().mockResolvedValue({ kind: 'success', data: null } satisfies TradertonReadResult);
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const result = await svc.resolvePriceTarget('PEPE', 'ethereum');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('price.malformed');
    }
  });
});

describe('createBoundaryPriceService — hybrid sizing parity', () => {
  it('yields the same resolved-identity result shape through resolveHybridTargetSize', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const invoke = vi.fn().mockResolvedValue(
      successPayload({
        symbol: 'USDC',
        chain: 'solana',
        address: mint,
        name: 'USD Coin',
        priceUsd: 1.2,
        source: 'oracle',
      }),
    );
    const svc = createBoundaryPriceService(makeBoundary(invoke));

    const identity: HybridPricingIdentity = { kind: 'dex', symbol: 'USDC', chain: 'solana', address: mint };
    const result = await resolveHybridTargetSize({
      instrumentId: 'USDC-SOL',
      sizeUsd: 120,
      priceService: svc,
      pricingIdentity: identity,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetSize).toBe('100.000000000000000000');
      expect(result.resolvedChain).toBe('solana');
      expect(result.resolvedAddress).toBe(mint);
      expect(result.resolvedSymbol).toBe('USDC');
      expect(result.source).toBe('oracle');
    }
    // The ticker symbol AND the pinned address are forwarded separately so the
    // resolver reproduces the in-process ticker-search + address-preference.
    expect(invoke).toHaveBeenCalledWith({
      toolName: 'resolve_price_target',
      payload: { symbol: 'USDC', chain: 'solana', address: mint },
    });
  });
});
