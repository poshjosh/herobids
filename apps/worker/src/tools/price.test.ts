import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { priceTools, validateSymbolForChain, isOnChainAddress } from './price.js';

const getPriceTool = priceTools.find((tool) => tool.name === 'get_price');

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-price-test',
    sessionId: 'session-price-test',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

describe('validateSymbolForChain', () => {
  it('rejects address-like identifiers for hyperliquid lookups', () => {
    expect(validateSymbolForChain('0x1234567890123456789012345678901234567890', 'hyperliquid')).toContain('hyperliquid');
  });

  it('rejects Solana mint-like identifiers for EVM lookups', () => {
    expect(validateSymbolForChain('So11111111111111111111111111111111111111112', 'ethereum')).toContain('ethereum');
  });

  it('accepts tickers for hyperliquid and Solana', () => {
    expect(validateSymbolForChain('BTC-PERP', 'hyperliquid')).toBeNull();
    expect(validateSymbolForChain('BONK', 'solana')).toBeNull();
  });

  it('rejects address-shaped symbols when chain is any', () => {
    expect(validateSymbolForChain('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'any')).toContain('explicit chain');
    expect(validateSymbolForChain('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'any')).toContain('explicit chain');
  });

  it('accepts plain tickers when chain is any', () => {
    expect(validateSymbolForChain('BTC', 'any')).toBeNull();
    expect(validateSymbolForChain('SOL', 'any')).toBeNull();
  });
});

describe('get_price tool', () => {
  it('rejects invalid symbol formats before calling the price service', async () => {
    const getPrice = vi.fn();
    const result = await getPriceTool!.execute(
      { symbol: 'So11111111111111111111111111111111111111112', chain: 'ethereum' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ethereum');
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('returns the shared price-service payload for valid lookups', async () => {
    const result = await getPriceTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({
        priceService: {
          getPrice: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              priceUsd: 155,
              source: 'oracle',
              fetchedAt: '2026-06-09T00:00:00.000Z',
              stale: false,
            },
          }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      symbol: 'SOL',
      chain: 'solana',
      priceUsd: 155,
      source: 'oracle',
      stale: false,
    });
  });

  it('passes address-shaped symbol as address argument for identity-aware lookup', async () => {
    const evmAddress = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: { priceUsd: 0.00001, source: 'oracle', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    const result = await getPriceTool!.execute(
      { symbol: evmAddress, chain: 'ethereum' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(result.success).toBe(true);
    // Must pass the address as 3rd argument so the price service uses strict identity
    expect(getPrice).toHaveBeenCalledWith(evmAddress, 'ethereum', evmAddress);
  });

  it('passes Solana mint as address argument for identity-aware lookup', async () => {
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: { priceUsd: 0.00002, source: 'oracle', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    const result = await getPriceTool!.execute(
      { symbol: mint, chain: 'solana' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(result.success).toBe(true);
    expect(getPrice).toHaveBeenCalledWith(mint, 'solana', mint);
  });

  it('does not pass address for plain ticker symbols', async () => {
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: { priceUsd: 67000, source: 'execution', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    await getPriceTool!.execute(
      { symbol: 'BTC', chain: 'hyperliquid' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(getPrice).toHaveBeenCalledWith('BTC', 'hyperliquid', undefined);
  });

  it('routes the read through the boundary when configured (does NOT touch priceService)', async () => {
    const boundaryData = {
      ok: true,
      symbol: 'SOL',
      chain: 'solana',
      priceUsd: 155,
      source: 'oracle',
      fetchedAt: '2026-06-09T00:00:00.000Z',
      stale: false,
    };
    const invoke = vi.fn().mockResolvedValue({ kind: 'success', data: boundaryData });
    const getPrice = vi.fn();

    const result = await getPriceTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({ tradertonBoundary: { invoke }, priceService: { getPrice } }),
    );

    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_price', payload: { symbol: 'SOL', chain: 'solana' } });
    expect(getPrice).not.toHaveBeenCalled(); // boundary sourced, not in-process
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('does not pass address over the boundary for address-shaped symbols (boundary self-detects)', async () => {
    const evmAddress = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const invoke = vi.fn().mockResolvedValue({
      kind: 'success',
      data: { ok: true, symbol: evmAddress, chain: 'ethereum', priceUsd: 0.00001, source: 'oracle', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    const result = await getPriceTool!.execute(
      { symbol: evmAddress, chain: 'ethereum' },
      makeContext({ tradertonBoundary: { invoke } }),
    );

    expect(result.success).toBe(true);
    // Payload carries only { symbol, chain } — no address arg (unlike the in-process path).
    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_price', payload: { symbol: evmAddress, chain: 'ethereum' } });
  });

  it('maps a boundary validation failure to a typed non-fault failure preserving code', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'failure',
      code: 'validation.invalid_payload',
      message: 'unknown symbol',
      retryable: false,
    });

    const result = await getPriceTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({ tradertonBoundary: { invoke } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('unknown symbol');
    expect(result.errorCode).toBe('validation.invalid_payload');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
  });

  it('short-circuits on invalid symbol BEFORE calling the boundary', async () => {
    const invoke = vi.fn();

    const result = await getPriceTool!.execute(
      { symbol: 'So11111111111111111111111111111111111111112', chain: 'ethereum' },
      makeContext({ tradertonBoundary: { invoke } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ethereum');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('isOnChainAddress', () => {
  it('detects EVM addresses on EVM chains', () => {
    expect(isOnChainAddress('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'ethereum')).toBe(true);
    expect(isOnChainAddress('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'bsc')).toBe(true);
  });

  it('detects Solana mints on solana chain', () => {
    expect(isOnChainAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'solana')).toBe(true);
  });

  it('does not flag tickers as addresses', () => {
    expect(isOnChainAddress('BTC', 'hyperliquid')).toBe(false);
    expect(isOnChainAddress('SOL', 'solana')).toBe(false);
    expect(isOnChainAddress('PEPE', 'ethereum')).toBe(false);
  });

  it('does not flag Solana mints on non-solana chains', () => {
    expect(isOnChainAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'ethereum')).toBe(false);
  });
});