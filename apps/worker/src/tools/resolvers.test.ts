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

function makeBot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-abc-123',
    config: { symbol: 'SOL/USDC' },
    status: 'running',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolve_bot
// ---------------------------------------------------------------------------

describe('resolve_bot', () => {
  it('returns error when botRepo is unavailable', async () => {
    const ctx = makeCtx({ botRepo: undefined });

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('resolve.bot_repo_unavailable');
  });

  it('resolves a single bot by symbol', async () => {
    const ctx = makeCtx({
      botRepo: {
        getBotsByCreator: vi.fn(async () => [
          makeBot({ id: 'bot-1', config: { symbol: 'SOL/USDC' } }),
        ]),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(true);
    expect(data.botId).toBe('bot-1');
    expect(data.symbol).toBe('SOL/USDC');
    expect(data.status).toBe('running');
  });

  it('resolves a bot by partial ID match', async () => {
    const ctx = makeCtx({
      botRepo: {
        getBotsByCreator: vi.fn(async () => [
          makeBot({ id: 'bot-xff-999', config: { symbol: 'ETH/USDC' } }),
        ]),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await resolveBot.execute({ name: 'xff' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(true);
    expect(data.botId).toBe('bot-xff-999');
  });

  it('returns all candidates when multiple bots match', async () => {
    const ctx = makeCtx({
      botRepo: {
        getBotsByCreator: vi.fn(async () => [
          makeBot({ id: 'bot-1', config: { symbol: 'SOL/USDC' } }),
          makeBot({ id: 'bot-2', config: { symbol: 'SOL/ETH' } }),
        ]),
      } as unknown as ToolContext['botRepo'],
    });

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
    const ctx = makeCtx({
      botRepo: {
        getBotsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await resolveBot.execute({ name: 'NONEXISTENT' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.resolved).toBe(false);
    expect(data.hint).toContain('No bots found');
  });

  it('returns error when getBotsByCreator throws', async () => {
    const ctx = makeCtx({
      botRepo: {
        getBotsByCreator: vi.fn(async () => {
          throw new Error('DB failure');
        }),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await resolveBot.execute({ name: 'SOL' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('resolve.bot_failed');
    expect(result.error).toContain('DB failure');
  });
});

// ---------------------------------------------------------------------------
// resolve_watch
// ---------------------------------------------------------------------------

describe('resolve_watch', () => {
  it('returns empty when no watches exist', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => null),
      },
    });

    const result = await resolveWatch.execute({ note: 'BTC breakout' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.watches).toEqual([]);
    expect(data.hint).toContain('No watches found');
  });

  it('finds a watch by note text', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => ({
          'watch-1': JSON.stringify({
            symbol: 'BTC/USD',
            note: 'BTC breakout above 70k',
            condition: 'above',
            thresholdPrice: '70000',
            createdAt: '2026-01-01T00:00:00Z',
          }),
        })),
      },
    });

    const result = await resolveWatch.execute({ note: 'breakout' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    const watches = data.watches as Array<Record<string, unknown>>;
    expect(watches[0].watchId).toBe('watch-1');
    expect(watches[0].note).toBe('BTC breakout above 70k');
  });

  it('finds a watch by symbol', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => ({
          'watch-1': JSON.stringify({ symbol: 'ETH/USD', note: 'ETH dip' }),
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

  it('returns empty when no watches match search', async () => {
    const ctx = makeCtx({
      redis: {
        ...makeCtx().redis,
        hgetall: vi.fn(async () => ({
          'watch-1': JSON.stringify({ symbol: 'BTC/USD', note: 'BTC pump' }),
        })),
      },
    });

    const result = await resolveWatch.execute({ note: 'nonexistent' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.watches).toEqual([]);
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
