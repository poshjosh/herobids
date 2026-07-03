import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { botManagementTools } from './bots.js';

const adjustBotConfigTool = botManagementTools.find((t) => t.name === 'adjust_bot_config')!;

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
