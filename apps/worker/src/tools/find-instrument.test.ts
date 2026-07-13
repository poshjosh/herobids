import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { instrumentTools } from './find-instrument.js';

const findInstrument = instrumentTools.find((t) => t.name === 'find_instrument')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeInstrument(overrides: Record<string, string> = {}) {
  return {
    id: 'uuid-btc-001',
    symbol: 'BTC/USDC:USDC',
    base: 'BTC',
    quote: 'USDC',
    type: 'perp',
    venue: 'hyperliquid',
    tickSize: '0.1',
    lotSize: '0.001',
    ...overrides,
  };
}

describe('find_instrument', () => {
  // -------------------------------------------------------------------------
  // Repo unavailable
  // -------------------------------------------------------------------------

  it('returns error when instrumentRepo is unavailable', async () => {
    const ctx = makeCtx({ instrumentRepo: undefined });

    const result = await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('instrument.repo_unavailable');
    expect(result.error).toContain('not available');
  });

  // -------------------------------------------------------------------------
  // Happy path — single result
  // -------------------------------------------------------------------------

  it('returns matching instruments when found', async () => {
    const ctx = makeCtx({
      instrumentRepo: {
        search: vi.fn(async () => [makeInstrument()]),
      },
    });

    const result = await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.count).toBe(1);
    const instruments = data.instruments as Array<Record<string, unknown>>;
    expect(instruments[0]).toMatchObject({
      instrumentId: 'BTC',        // perp → base ticker
      id: 'uuid-btc-001',         // DB internal ID
      symbol: 'BTC/USDC:USDC',
      base: 'BTC',
      quote: 'USDC',
      type: 'perp',
      venue: 'hyperliquid',
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — venue filter
  // -------------------------------------------------------------------------

  it('passes venue filter to the repository', async () => {
    const search = vi.fn(async () => [makeInstrument({ venue: 'jupiter' })]);
    const ctx = makeCtx({ instrumentRepo: { search } });

    await findInstrument.execute({ query: 'SOL', venue: 'jupiter' }, ctx);

    expect(search).toHaveBeenCalledWith({
      query: 'SOL',
      venue: 'jupiter',
      limit: 5,
    });
  });

  // -------------------------------------------------------------------------
  // No results
  // -------------------------------------------------------------------------

  it('returns error when no instruments match', async () => {
    const ctx = makeCtx({
      instrumentRepo: {
        search: vi.fn(async () => []),
      },
    });

    const result = await findInstrument.execute({ query: 'DOESNOTEXIST' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('instrument.not_found');
    expect(result.error).toContain('No instruments found');
  });

  // -------------------------------------------------------------------------
  // Repo throws
  // -------------------------------------------------------------------------

  it('returns error when repository throws', async () => {
    const ctx = makeCtx({
      instrumentRepo: {
        search: vi.fn(async () => {
          throw new Error('DB connection lost');
        }),
      },
    });

    const result = await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('instrument.lookup_failed');
    expect(result.error).toContain('DB connection lost');
  });

  // -------------------------------------------------------------------------
  // instrumentId mapping — perp → base ticker
  // -------------------------------------------------------------------------

  it('maps instrumentId to base ticker for perp instruments', async () => {
    const ctx = makeCtx({
      instrumentRepo: {
        search: vi.fn(async () => [
          makeInstrument({ id: 'uuid-zec', symbol: 'ZEC/USDC:USDC', base: 'ZEC', type: 'perp', venue: 'hyperliquid' }),
        ]),
      },
    });

    const result = await findInstrument.execute({ query: 'ZEC' }, ctx);

    expect(result.success).toBe(true);
    const instruments = (result.data as Record<string, unknown>).instruments as Array<Record<string, unknown>>;
    expect(instruments[0]).toMatchObject({
      instrumentId: 'ZEC',        // perp → base ticker
      id: 'uuid-zec',             // DB internal ID preserved
      symbol: 'ZEC/USDC:USDC',
    });
  });

  // -------------------------------------------------------------------------
  // instrumentId mapping — spot/swap → pair symbol
  // -------------------------------------------------------------------------

  it('maps instrumentId to pair symbol for spot (swap) instruments', async () => {
    const ctx = makeCtx({
      instrumentRepo: {
        search: vi.fn(async () => [
          makeInstrument({ id: 'uuid-sol', symbol: 'SOL/USDC', base: 'SOL', type: 'spot', venue: 'jupiter' }),
        ]),
      },
    });

    const result = await findInstrument.execute({ query: 'SOL', venue: 'jupiter' }, ctx);

    expect(result.success).toBe(true);
    const instruments = (result.data as Record<string, unknown>).instruments as Array<Record<string, unknown>>;
    expect(instruments[0]).toMatchObject({
      instrumentId: 'SOL/USDC',   // spot/swap → pair symbol
      id: 'uuid-sol',             // DB internal ID preserved
      symbol: 'SOL/USDC',
      base: 'SOL',
    });
  });

  // -------------------------------------------------------------------------
  // instrumentId mapping — mixed perp + spot results
  // -------------------------------------------------------------------------

  it('maps instrumentId correctly for mixed perp and spot results', async () => {
    const ctx = makeCtx({
      instrumentRepo: {
        search: vi.fn(async () => [
          makeInstrument({ id: 'uuid-eth', symbol: 'ETH/USDC:USDC', base: 'ETH', type: 'perp', venue: 'hyperliquid' }),
          makeInstrument({ id: 'uuid-weth', symbol: 'WETH/USDC', base: 'WETH', type: 'spot', venue: 'jupiter' }),
        ]),
      },
    });

    const result = await findInstrument.execute({ query: 'ETH' }, ctx);

    expect(result.success).toBe(true);
    const instruments = (result.data as Record<string, unknown>).instruments as Array<Record<string, unknown>>;
    // perp → base ticker
    expect(instruments[0]!.instrumentId).toBe('ETH');
    expect(instruments[0]!.id).toBe('uuid-eth');
    // spot → pair symbol
    expect(instruments[1]!.instrumentId).toBe('WETH/USDC');
    expect(instruments[1]!.id).toBe('uuid-weth');
  });
});
