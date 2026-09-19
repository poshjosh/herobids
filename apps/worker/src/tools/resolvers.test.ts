import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { resolverTools } from './resolvers.js';

const resolveBot = resolverTools.find((t) => t.name === 'resolve_bot')!;
const resolveWatch = resolverTools.find((t) => t.name === 'resolve_watch')!;
const resolveTask = resolverTools.find((t) => t.name === 'resolve_task')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ToolContext;
}

/** Stub the Traderton boundary so resolve_bot's `list_bots` read returns a
 * fixed `{ ok, bots }` payload (c4.9i: resolve_bot sources bots over the
 * boundary, then matches client-side). */
function ctxWithBots(bots: Array<{ id: string; status: string; symbol: string | null }>): ToolContext {
  return makeCtx({
    tradertonBoundary: {
      invoke: vi.fn(async () => ({ kind: 'success' as const, data: { ok: true, bots } })),
    },
  });
}

// ---------------------------------------------------------------------------
// resolve_bot
// ---------------------------------------------------------------------------

describe('resolve_bot', () => {
  it('fails closed when the Traderton boundary is unavailable', async () => {
    const ctx = makeCtx();

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
  });

  it('resolves a single bot by symbol', async () => {
    const ctx = ctxWithBots([{ id: 'bot-1', status: 'running', symbol: 'SOL/USDC' }]);

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(true);
    expect(data.botId).toBe('bot-1');
    expect(data.symbol).toBe('SOL/USDC');
    expect(data.status).toBe('running');
  });

  it('resolves a bot by partial ID match', async () => {
    const ctx = ctxWithBots([{ id: 'bot-xff-999', status: 'running', symbol: 'ETH/USDC' }]);

    const result = await resolveBot.execute({ name: 'xff' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(true);
    expect(data.botId).toBe('bot-xff-999');
  });

  it('returns all candidates when multiple bots match', async () => {
    const ctx = ctxWithBots([
      { id: 'bot-1', status: 'running', symbol: 'SOL/USDC' },
      { id: 'bot-2', status: 'running', symbol: 'SOL/ETH' },
    ]);

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(false);
    expect(data.ambiguous).toBe(true);
    const candidates = data.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(2);
    expect(candidates[0].botId).toBe('bot-1');
    expect(candidates[1].botId).toBe('bot-2');
  });

  it('returns not-resolved hint when no bots match', async () => {
    const ctx = ctxWithBots([]);

    const result = await resolveBot.execute({ name: 'NONEXISTENT' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(false);
    expect(data.hint).toContain('No bots found');
  });

  it('maps a boundary failure through the shared read→tool mapping', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(async () => ({
          kind: 'failure' as const,
          code: 'upstream.transient',
          message: 'slow',
          retryable: true,
        })),
      },
    });

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('upstream.transient');
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolve_watch
// ---------------------------------------------------------------------------

describe('resolve_watch', () => {
  // A6: resolve_watch re-points to the boundary's CURRENT watch list
  // (`list_watches` → in-app substring match, like resolve_bot). The legacy
  // local Redis hash read is deleted; fail closed when the boundary is absent.

  it('fails closed when the Traderton boundary is unavailable', async () => {
    const ctx = makeCtx();

    const result = await resolveWatch.execute({ note: 'BTC breakout' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
    // The legacy local Redis hash is never consulted.
    expect(ctx.redis.hgetall).not.toHaveBeenCalled();
  });

  it('resolves a single watch by note substring over the boundary list', async () => {
    const invoke = vi.fn(async () => ({
      kind: 'success' as const,
      data: {
        ok: true,
        watches: [
          {
            watchId: 'watch-1',
            symbol: 'BTC/USD',
            chain: 'solana',
            condition: 'above',
            thresholdPrice: 70000,
            note: 'BTC breakout above 70k',
            createdAt: '2026-01-01T00:00:00Z',
          },
          {
            watchId: 'watch-2',
            symbol: 'ETH/USD',
            chain: 'ethereum',
            condition: 'below',
            thresholdPrice: 2000,
            note: 'ETH dip watch',
            createdAt: '2026-01-02T00:00:00Z',
          },
        ],
      },
    }));
    const ctx = makeCtx({ tradertonBoundary: { invoke } });

    const result = await resolveWatch.execute({ note: 'breakout' }, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_watches', payload: {} });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    const watches = data.watches as Array<Record<string, unknown>>;
    expect(watches[0].watchId).toBe('watch-1');
    expect(watches[0].note).toBe('BTC breakout above 70k');
  });

  it('resolves a watch by symbol substring', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(async () => ({
          kind: 'success' as const,
          data: { ok: true, watches: [{ watchId: 'watch-1', symbol: 'ETH/USD', note: 'ETH dip' }] },
        })),
      },
    });

    const result = await resolveWatch.execute({ symbol: 'ETH' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    const watches = data.watches as Array<Record<string, unknown>>;
    expect(watches[0].symbol).toBe('ETH/USD');
  });

  it('returns empty with a hint when no boundary watches match', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(async () => ({
          kind: 'success' as const,
          data: { ok: true, watches: [{ watchId: 'watch-1', symbol: 'BTC/USD', note: 'BTC pump' }] },
        })),
      },
    });

    const result = await resolveWatch.execute({ note: 'nonexistent' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.watches).toEqual([]);
    expect((data.hint as string)).toContain('No watches matched');
  });

  it('maps a boundary failure through the shared read→tool mapping', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(async () => ({
          kind: 'failure' as const,
          code: 'upstream.transient',
          message: 'slow',
          retryable: true,
        })),
      },
    });

    const result = await resolveWatch.execute({ note: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('upstream.transient');
    expect(result.retryable).toBe(true);
  });

  it('returns resolve.watch_failed when the boundary throws', async () => {
    const ctx = makeCtx({
      tradertonBoundary: {
        invoke: vi.fn(async () => {
          throw new Error('Redis timeout');
        }),
      },
    });

    const result = await resolveWatch.execute({ note: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('resolve.watch_failed');
    expect(result.error).toContain('Redis timeout');
  });
});

// ---------------------------------------------------------------------------
// resolve_task
// ---------------------------------------------------------------------------

describe('resolve_task', () => {
  it('returns empty when no tasks exist', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => null),
      },
    });

    const result = await resolveTask.execute({ title: 'Review BTC' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.tasks).toEqual([]);
    expect(data.hint).toContain('No tasks found');
  });

  it('finds a task by title substring', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => ({
          'task-1': JSON.stringify({
            title: 'Review BTC position',
            status: 'pending',
            createdAt: '2026-01-01T00:00:00Z',
          }),
        })),
      },
    });

    const result = await resolveTask.execute({ title: 'BTC' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    const tasks = data.tasks as Array<Record<string, unknown>>;
    expect(tasks[0].taskId).toBe('task-1');
    expect(tasks[0].title).toBe('Review BTC position');
    expect(tasks[0].status).toBe('pending');
  });

  it('returns empty when no tasks match', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => ({
          'task-1': JSON.stringify({ title: 'Review SOL', status: 'pending' }),
        })),
      },
    });

    const result = await resolveTask.execute({ title: 'nonexistent' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.tasks).toEqual([]);
  });

  it('returns error on Redis failure', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => {
          throw new Error('Redis timeout');
        }),
      },
    });

    const result = await resolveTask.execute({ title: 'BTC' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('resolve.task_failed');
    expect(result.error).toContain('Redis timeout');
  });
});
