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
    id: 'BTC-USD',
    symbol: 'BTC-USD',
    base: 'BTC',
    quote: 'USD',
    type: 'perpetual',
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
      instrumentId: 'BTC-USD',
      symbol: 'BTC-USD',
      base: 'BTC',
      quote: 'USD',
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
});
