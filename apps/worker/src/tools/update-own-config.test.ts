import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, UnifiedAgentConfig } from '@herobids/domain';
import { updateOwnConfigTools } from './update-own-config.js';

const updateOwnConfigTool = updateOwnConfigTools.find((t) => t.name === 'update_own_config')!;

const MINIMAL_TECHNICAL: UnifiedAgentConfig['technical'] = {
  filters: { venue: 'hyperliquid', venueType: 'orderbook' },
  indicators: {},
  candles: { interval: '15m', limit: 100 },
  signalBias: 'trend-following',
  scanIntervalMs: 60_000,
  scanBatchSize: 5,
};

function makeOps(overrides: Partial<NonNullable<ToolContext['agentConfigOps']>> = {}): NonNullable<ToolContext['agentConfigOps']> {
  return {
    getCurrentConfig: vi.fn().mockResolvedValue(null),
    persistConfig: vi.fn().mockResolvedValue(undefined),
    appendJournal: vi.fn().mockResolvedValue(undefined),
    notifyActorConfigUpdate: vi.fn().mockResolvedValue(undefined),
    getLlmTickCount: vi.fn().mockReturnValue(0),
    getMinPaperCyclesBeforeLive: vi.fn().mockReturnValue(10),
    ...overrides,
  };
}

function makeCtx(agentConfigOps: ToolContext['agentConfigOps']): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    redis: { hset: vi.fn(), hget: vi.fn(), hgetall: vi.fn(), hdel: vi.fn(), publish: vi.fn() },
    publishToInbound: vi.fn(),
    agentConfigOps,
  };
}

describe('update_own_config tool', () => {
  it('returns error when agentConfigOps is not available', async () => {
    const ctx = makeCtx(undefined);
    const result = await updateOwnConfigTool.execute({ technical: MINIMAL_TECHNICAL }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('adds technical config — merges and persists', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({ intelligence: { model: 'gpt-4' } }),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ technical: MINIMAL_TECHNICAL }, ctx);

    expect(result.success).toBe(true);
    expect(ops.persistConfig).toHaveBeenCalledOnce();
    const [persisted] = (ops.persistConfig as ReturnType<typeof vi.fn>).mock.calls[0] as [UnifiedAgentConfig, string?];
    expect(persisted.technical).toMatchObject({ filters: { venue: 'hyperliquid' } });
    expect((persisted as Record<string, unknown>).intelligence).toEqual({ model: 'gpt-4' });
  });

  it('removes technical (sets to null) when intelligence is present', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({
        intelligence: { model: 'gpt-4' },
        technical: MINIMAL_TECHNICAL,
      }),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ technical: null }, ctx);

    expect(result.success).toBe(true);
    const [persisted] = (ops.persistConfig as ReturnType<typeof vi.fn>).mock.calls[0] as [UnifiedAgentConfig, string?];
    expect(persisted.technical).toBeUndefined();
    expect((persisted as Record<string, unknown>).intelligence).toEqual({ model: 'gpt-4' });
  });

  it('rejects removing technical when there is no intelligence config', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({ technical: MINIMAL_TECHNICAL }),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ technical: null }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/intelligence/i);
    expect(ops.persistConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid config (Zod validation failure)', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({ intelligence: { model: 'gpt-4' } }),
    });
    const ctx = makeCtx(ops);

    // Pass invalid technical config (missing required 'venue' field in filters)
    const result = await updateOwnConfigTool.execute(
      {
        technical: { filters: { venueType: 'orderbook' } as unknown as NonNullable<UnifiedAgentConfig['technical']>['filters'] },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('validation failed');
  });

  it('live mode safety gate: null/unconfigured → live is rejected', async () => {
    const ops = makeOps({
      // No current execution.mode — unconfigured
      getCurrentConfig: vi.fn().mockResolvedValue({ technical: MINIMAL_TECHNICAL }),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ execution: { mode: 'live' } }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/live/i);
    expect(ops.persistConfig).not.toHaveBeenCalled();
  });

  it('live mode safety gate: paper → live allowed when paper cycles >= threshold', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({
        technical: MINIMAL_TECHNICAL,
        execution: { mode: 'paper' },
      }),
      getLlmTickCount: vi.fn().mockReturnValue(15),
      getMinPaperCyclesBeforeLive: vi.fn().mockReturnValue(10),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ execution: { mode: 'live' } }, ctx);

    expect(result.success).toBe(true);
    const [persisted, executionMode] = (ops.persistConfig as ReturnType<typeof vi.fn>).mock.calls[0] as [UnifiedAgentConfig, string?];
    expect(persisted.execution?.mode).toBe('live');
    expect(executionMode).toBe('live');
  });

  it('live mode safety gate: paper → live rejected when paper cycles < threshold', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({
        technical: MINIMAL_TECHNICAL,
        execution: { mode: 'paper' },
      }),
      getLlmTickCount: vi.fn().mockReturnValue(3),
      getMinPaperCyclesBeforeLive: vi.fn().mockReturnValue(10),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ execution: { mode: 'live' } }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/3.*cycle|cycle.*3/i);
    expect(ops.persistConfig).not.toHaveBeenCalled();
  });

  it('journals config change with before/after snapshot', async () => {
    const currentConfig: UnifiedAgentConfig = {
      intelligence: { model: 'gpt-4' },
    };
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue(currentConfig),
    });
    const ctx = makeCtx(ops);

    await updateOwnConfigTool.execute({ technical: MINIMAL_TECHNICAL }, ctx);

    expect(ops.appendJournal).toHaveBeenCalledOnce();
    const [type, payload] = (ops.appendJournal as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(type).toBe('agent.config_updated');
    expect(payload.before).toEqual(currentConfig);
    expect((payload.after as UnifiedAgentConfig).technical).toBeDefined();
    expect(payload.updatedBy).toBe('agent');
  });

  it('persists config to DB via persistConfig', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({ intelligence: { model: 'gpt-4' } }),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute(
      { technical: MINIMAL_TECHNICAL, execution: { mode: 'paper' } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ops.persistConfig).toHaveBeenCalledOnce();
    const [persisted, executionMode] = (ops.persistConfig as ReturnType<typeof vi.fn>).mock.calls[0] as [UnifiedAgentConfig, string | undefined];
    expect(persisted.technical).toBeDefined();
    expect(executionMode).toBe('paper');
  });

  it('shadow → live is allowed without paper cycle check', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({
        technical: MINIMAL_TECHNICAL,
        execution: { mode: 'shadow' },
      }),
      getLlmTickCount: vi.fn().mockReturnValue(0),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ execution: { mode: 'live' } }, ctx);

    expect(result.success).toBe(true);
  });

  it('deep-merges execution fields without overwriting others', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({
        technical: MINIMAL_TECHNICAL,
        execution: { mode: 'paper', positionSizeMode: 'fixed', fixedPositionSize: '100' },
      }),
    });
    const ctx = makeCtx(ops);

    const result = await updateOwnConfigTool.execute({ execution: { mode: 'shadow' } }, ctx);

    expect(result.success).toBe(true);
    const [persisted] = (ops.persistConfig as ReturnType<typeof vi.fn>).mock.calls[0] as [UnifiedAgentConfig];
    expect(persisted.execution?.mode).toBe('shadow');
    expect(persisted.execution?.positionSizeMode).toBe('fixed');
    expect(persisted.execution?.fixedPositionSize).toBe('100');
  });

  it('ignores attempts to modify intelligence field (not in schema)', async () => {
    const ops = makeOps({
      getCurrentConfig: vi.fn().mockResolvedValue({ intelligence: { model: 'gpt-4' } }),
    });
    const ctx = makeCtx(ops);

    // Zod strips the unknown 'intelligence' key because it's not in UpdateOwnConfigPayloadSchema
    const result = await updateOwnConfigTool.execute({ intelligence: null } as unknown as Record<string, unknown>, ctx);

    expect(result.success).toBe(true);
    const [persisted] = (ops.persistConfig as ReturnType<typeof vi.fn>).mock.calls[0] as [UnifiedAgentConfig];
    // intelligence must be preserved from the current config — not nulled out
    expect((persisted as Record<string, unknown>).intelligence).toEqual({ model: 'gpt-4' });
  });
});
