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

describe('adjust_bot_config — L3c: mode-rank gate + boundary routing', () => {
  // The mode-escalation gate (a platform check on ctx.executionMode) stays in the
  // tool and rejects BEFORE any side effect. Allowed adjustments now publish
  // MANAGE_BOT to the broker (which invokes the boundary) instead of writing
  // ctx.botRepo directly — herobids owns no bot state; ownership is enforced
  // boundary-side.

  // ── Mode escalation rejections (publish NOT called) ────────────────────

  it('rejects paper agent adjusting bot to shadow mode — MANAGE_BOT NOT published', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ executionMode: 'paper', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'shadow' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('shadow');
    expect(result.error).toContain('paper');
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  it('rejects paper agent adjusting bot to live mode — MANAGE_BOT NOT published', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ executionMode: 'paper', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('live');
    expect(result.error).toContain('paper');
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  it('rejects shadow agent adjusting bot to live mode — MANAGE_BOT NOT published', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ executionMode: 'shadow', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('live');
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  // ── Allowed adjustments publish MANAGE_BOT adjust_config ────────────────

  it('allows paper→paper and publishes MANAGE_BOT adjust_config', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ executionMode: 'paper', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
    const [type, payload] = publishToInbound.mock.calls[0]!;
    expect(type).toBe('agent.manage_bot');
    expect(payload).toEqual({ action: 'adjust_config', botId: 'bot-1', config: { execution: { mode: 'paper' } } });
  });

  it('allows live agent adjusting bot to any mode', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ executionMode: 'live', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
  });

  it('publishes MANAGE_BOT when execution.mode is absent from the adjustment', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ executionMode: 'paper', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { symbol: 'BTC/USDC' } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
  });

  it('surfaces a publish failure as a non-fault tool failure', async () => {
    const publishToInbound = vi.fn(async () => { throw new Error('redis down'); });
    const ctx = makeCtx({ executionMode: 'paper', publishToInbound });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { symbol: 'BTC/USDC' } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
  });
});

describe('stop_bot / start_bot — L3c: boundary routing via MANAGE_BOT', () => {
  const stopBotTool = botManagementTools.find((t) => t.name === 'stop_bot')!;
  const startBotTool = botManagementTools.find((t) => t.name === 'start_bot')!;

  it('stop_bot publishes MANAGE_BOT stop (no direct botRepo write)', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ publishToInbound });

    const result = await stopBotTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledWith('agent.manage_bot', { action: 'stop', botId: 'bot-1' });
  });

  it('start_bot publishes MANAGE_BOT start', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ publishToInbound });

    const result = await startBotTool.execute({ botId: 'bot-1', rationale: 'resume' }, ctx);

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledWith('agent.manage_bot', { action: 'start', botId: 'bot-1', rationale: 'resume' });
  });

  it('stop_bot surfaces a publish failure as a non-fault failure', async () => {
    const publishToInbound = vi.fn(async () => { throw new Error('redis down'); });
    const ctx = makeCtx({ publishToInbound });

    const result = await stopBotTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
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

  it('fails closed with a typed precondition when the boundary is absent', async () => {
    const ctx = makeCtx();

    const result = await listBotsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
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

  it('fails closed with a typed precondition when the boundary is absent', async () => {
    const ctx = makeCtx();

    const result = await getBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });
});
