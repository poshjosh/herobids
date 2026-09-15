import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, TradertonReadResult } from '@herobids/domain';
import { analyticsTools } from './analytics.js';

const getAnalyticsTool = analyticsTools.find((t) => t.name === 'get_analytics')!;
const listPositionsTool = analyticsTools.find((t) => t.name === 'list_positions')!;

/** A stubbed tradertonBoundary whose invoke returns a fixed result + records calls. */
function stubBoundary(result: TradertonReadResult) {
  const invoke = vi.fn(async () => result);
  return { boundary: { invoke }, invoke };
}

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ToolContext;
}

// c4.9i: the analytics read tools source solely over the Traderton boundary —
// the boundary returns the same `data` shape the tools used to build locally,
// so the tools now pass the payload through unchanged. The former local-botRepo
// fallback tests were removed with that dead path.

describe('get_analytics — Traderton boundary', () => {
  it('routes over the boundary forwarding { days } and returns the payload as data', async () => {
    const { boundary, invoke } = stubBoundary({
      kind: 'success',
      data: { ok: true, totalTrades: 3, days: 14 },
    });
    const ctx = createToolContext({ tradertonBoundary: boundary });

    const result = await getAnalyticsTool.execute({ days: 14 }, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_analytics', payload: { days: 14 } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, totalTrades: 3, days: 14 });
  });

  it('maps a typed failure preserving code/retryable/fault', async () => {
    const { boundary } = stubBoundary({
      kind: 'failure',
      code: 'upstream.transient',
      message: 'slow',
      retryable: true,
    });
    const ctx = createToolContext({ tradertonBoundary: boundary });

    const result = await getAnalyticsTool.execute({ days: 7 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('upstream.transient');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(true);
  });

  it('maps transport_error to a retryable fault', async () => {
    const { boundary } = stubBoundary({ kind: 'transport_error', message: 'down', retryable: true });
    const ctx = createToolContext({ tradertonBoundary: boundary });

    const result = await getAnalyticsTool.execute({ days: 7 }, ctx);

    expect(result.errorCode).toBe('boundary.transport_error');
    expect(result.fault).toBe(true);
    expect(result.retryable).toBe(true);
  });

  it('fails closed with a typed precondition when the boundary is absent', async () => {
    const ctx = createToolContext();

    const result = await getAnalyticsTool.execute({ days: 7 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });
});

describe('list_positions — Traderton boundary', () => {
  it('routes over the boundary forwarding an empty payload', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, positions: [] } });
    const ctx = createToolContext({ tradertonBoundary: boundary });

    const result = await listPositionsTool.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_positions', payload: {} });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, positions: [] });
  });

  it('fails closed with a typed precondition when the boundary is absent', async () => {
    const ctx = createToolContext();

    const result = await listPositionsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });
});
