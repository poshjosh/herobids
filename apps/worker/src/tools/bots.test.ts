import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, TradertonReadResult } from '@herobids/domain';
import { botManagementTools } from './bots.js';

const adjustBotConfigTool = botManagementTools.find((t) => t.name === 'adjust_bot_config')!;
const listBotsTool = botManagementTools.find((t) => t.name === 'list_bots')!;
const getBotStatusTool = botManagementTools.find((t) => t.name === 'get_bot_status')!;

/** A stubbed tradertonBoundary whose invoke returns a fixed result + records calls. */
function stubBoundary(result: TradertonReadResult) {
  const invoke = vi.fn(async () => result);
  return { boundary: { invoke }, invoke };
}

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
  };
}

function makeBotRecord(overrides: Partial<{
  id: string;
  config: Record<string, unknown>;
  creatorType: string;
  creatorId: string;
}> = {}) {
  return {
    id: 'bot-1',
    status: 'running',
    config: { execution: { mode: 'paper' }, symbol: 'SOL/USDC' },
    creatorType: 'agent',
    creatorId: 'agent-1',
    startedAt: null,
    stoppedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('adjust_bot_config — mode-rank enforcement', () => {
  // ── Mode escalation rejections ─────────────────────────────────────────

  it('rejects paper agent adjusting bot to shadow mode', async () => {
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'shadow' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('shadow');
    expect(result.error).toContain('paper');
  });

  it('rejects paper agent adjusting bot to live mode', async () => {
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('live');
    expect(result.error).toContain('paper');
  });

  it('rejects shadow agent adjusting bot to live mode', async () => {
    const ctx = makeCtx({
      executionMode: 'shadow',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('live');
    expect(result.error).toContain('paper');
    expect(result.error).toContain('shadow');
  });

  // ── Allowed adjustments ────────────────────────────────────────────────

  it('allows paper agent adjusting bot to paper mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  it('allows shadow agent adjusting bot to shadow mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'shadow',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord({ config: { execution: { mode: 'shadow' }, symbol: 'SOL/USDC' } })),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'shadow' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  it('allows shadow agent to downgrade bot to paper mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'shadow',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  it('allows live agent adjusting bot to any mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'live',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  // ── No execution.mode in adjustment ─────────────────────────────────────

  it('no-op when execution.mode is absent from the adjustment', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { symbol: 'BTC/USDC' } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  // ── Ownership check (existing behaviour, unchanged) ────────────────────

  it('rejects when bot is not owned by the agent', async () => {
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord({ creatorId: 'other-agent' })),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not owned');
  });
});

describe('list_bots — Traderton boundary (L3b)', () => {
  it('routes over the boundary forwarding { days } and returns the payload as data', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, bots: [] } });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await listBotsTool.execute({ days: 30 }, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_bots', payload: { days: 30 } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, bots: [] });
  });

  it('forwards { days: undefined } when days is omitted', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, bots: [] } });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    await listBotsTool.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'list_bots', payload: { days: undefined } });
  });

  it('falls back to the DB path when the boundary is absent', async () => {
    const getBotsByCreator = vi.fn(async () => []);
    const ctx = makeCtx({
      botRepo: { getBotsByCreator } as unknown as ToolContext['botRepo'],
    });

    const result = await listBotsTool.execute({}, ctx);

    expect(getBotsByCreator).toHaveBeenCalled();
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });
});

describe('get_bot_status — Traderton boundary (L3b)', () => {
  it('routes over the boundary forwarding { botId } and returns the payload as data', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, id: 'bot-1', status: 'running' } });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_bot_status', payload: { botId: 'bot-1' } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, id: 'bot-1', status: 'running' });
  });

  it('maps a not_found failure to a non-fault failure', async () => {
    const { boundary } = stubBoundary({
      kind: 'failure',
      code: 'not_found.resource',
      message: 'bot bot-9 not found',
      retryable: false,
    });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getBotStatusTool.execute({ botId: 'bot-9' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
    expect(result.fault).toBe(false);
  });

  it('maps transport_error to a retryable fault', async () => {
    const { boundary } = stubBoundary({ kind: 'transport_error', message: 'down', retryable: true });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.errorCode).toBe('boundary.transport_error');
    expect(result.fault).toBe(true);
    expect(result.retryable).toBe(true);
  });

  it('maps in_progress to a retryable non-fault failure', async () => {
    const { boundary } = stubBoundary({ kind: 'in_progress' });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('boundary.in_progress');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(false);
  });

  it('falls back to the DB path when the boundary is absent', async () => {
    const getBotById = vi.fn(async () => makeBotRecord({ id: 'bot-1' }));
    const ctx = makeCtx({
      botRepo: { getBotById } as unknown as ToolContext['botRepo'],
    });

    const result = await getBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(getBotById).toHaveBeenCalledWith('bot-1');
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe('bot-1');
  });
});
