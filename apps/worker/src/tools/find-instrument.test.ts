import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, TradertonReadResult } from '@herobids/domain';
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

/** A boundary success payload — the shape Traderton's find_instrument returns. */
function boundaryInstrumentsPayload(instruments: Array<Record<string, unknown>>) {
  return {
    ok: true,
    query: 'BTC',
    count: instruments.length,
    instruments,
  };
}

describe('find_instrument', () => {
  // -------------------------------------------------------------------------
  // Boundary unavailable — fail closed (no local instruments read)
  // -------------------------------------------------------------------------

  it('returns error when the Traderton boundary is unavailable', async () => {
    const ctx = makeCtx({ tradertonBoundary: undefined });

    const result = await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('instrument.repo_unavailable');
    expect(result.error).toContain('not available');
  });

  // -------------------------------------------------------------------------
  // Invokes the boundary find_instrument tool with mapped params
  // -------------------------------------------------------------------------

  it('invokes the boundary find_instrument tool with query/venue/limit', async () => {
    const invoke = vi.fn(
      async (): Promise<TradertonReadResult> => ({
        kind: 'success',
        data: boundaryInstrumentsPayload([]),
      }),
    );
    const ctx = makeCtx({ tradertonBoundary: { invoke } });

    await findInstrument.execute({ query: 'SOL', venue: 'jupiter', limit: 3 }, ctx);

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'find_instrument',
      payload: { query: 'SOL', venue: 'jupiter', limit: 3 },
    });
  });

  it('defaults limit to 5 when omitted', async () => {
    const invoke = vi.fn(
      async (): Promise<TradertonReadResult> => ({
        kind: 'success',
        data: boundaryInstrumentsPayload([]),
      }),
    );
    const ctx = makeCtx({ tradertonBoundary: { invoke } });

    await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'find_instrument',
      payload: { query: 'BTC', venue: undefined, limit: 5 },
    });
  });

  // -------------------------------------------------------------------------
  // Success — the boundary payload flows through unchanged
  // -------------------------------------------------------------------------

  it('passes the boundary success payload through unchanged', async () => {
    const payload = boundaryInstrumentsPayload([
      {
        instrumentId: 'BTC',
        id: 'uuid-btc-001',
        symbol: 'BTC/USDC:USDC',
        base: 'BTC',
        quote: 'USDC',
        type: 'perp',
        venue: 'hyperliquid',
        tickSize: '0.1',
        lotSize: '0.001',
      },
    ]);
    const ctx = makeCtx({
      tradertonBoundary: { invoke: vi.fn(async (): Promise<TradertonReadResult> => ({ kind: 'success', data: payload })) },
    });

    const result = await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(payload);
  });

  // -------------------------------------------------------------------------
  // Boundary typed failure — mapped to a non-fault tool failure
  // -------------------------------------------------------------------------

  it('maps a boundary not-found failure to a content-level tool failure', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(
          async (): Promise<TradertonReadResult> => ({
            kind: 'failure',
            code: 'not_found.resource',
            message: 'No instruments found for query "DOESNOTEXIST".',
            retryable: false,
          }),
        ),
      },
    });

    const result = await findInstrument.execute({ query: 'DOESNOTEXIST' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
    expect(result.fault).toBe(false);
    expect(result.retryable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Transport error — mapped to a retryable infrastructure fault
  // -------------------------------------------------------------------------

  it('maps a boundary transport error to a retryable fault', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(async (): Promise<TradertonReadResult> => ({ kind: 'transport_error', message: 'unreachable', retryable: true })),
      },
    });

    const result = await findInstrument.execute({ query: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('boundary.transport_error');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(true);
  });
});
