import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, ResolvedAgentRiskContract } from '@herobids/domain';
import { riskLimitsTools } from './risk-limits.js';

const getRiskLimitsTool = riskLimitsTools.find((t) => t.name === 'get_risk_limits')!;
const adjustRiskLimitsTool = riskLimitsTools.find((t) => t.name === 'adjust_risk_limits')!;

function makeContract(overrides?: Partial<ResolvedAgentRiskContract>): ResolvedAgentRiskContract {
  return {
    maxOpenPositions: { effectiveValue: 10, source: 'default', mutable: true, operatorCeiling: 10 },
    maxPositionSizePct: { effectiveValue: 100, source: 'default', mutable: true, operatorCeiling: 100 },
    stopLossPct: { effectiveValue: 100, source: 'default', mutable: true, operatorCeiling: 100 },
    stopLossCooldownMs: { effectiveValue: 60000, source: 'agent_override', mutable: true, operatorCeiling: 300000, overrideValue: 60000 },
    maxDrawdownPct: { effectiveValue: 1_000_000_000, source: 'default', mutable: true, operatorCeiling: 1_000_000_000 },
    ...overrides,
  };
}

function makeCtx(opts: {
  riskContractOps?: ToolContext['riskContractOps'];
  botRepo?: ToolContext['botRepo'];
  agentConfigOps?: ToolContext['agentConfigOps'];
  agentRepo?: ToolContext['agentRepo'];
  tradertonWriteBoundary?: ToolContext['tradertonWriteBoundary'];
  tradertonBoundary?: ToolContext['tradertonBoundary'];
} = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    redis: { hset: vi.fn(), hget: vi.fn(), hgetall: vi.fn(), hdel: vi.fn(), publish: vi.fn(), blpop: vi.fn() },
    publishToInbound: vi.fn(),
    riskContractOps: opts.riskContractOps,
    botRepo: opts.botRepo,
    agentConfigOps: opts.agentConfigOps,
    agentRepo: opts.agentRepo,
    tradertonWriteBoundary: opts.tradertonWriteBoundary,
    tradertonBoundary: opts.tradertonBoundary,
  };
}

describe('get_risk_limits tool', () => {
  it('returns structured contract with source and mutability', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      riskContractOps: {
        getContract: vi.fn().mockResolvedValue(contract),
        adjustOverrides: vi.fn(),
      },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const limits = data.limits as Record<string, unknown>;
    expect(limits.maxOpenPositions).toEqual({ value: 10, source: 'default', mutable: true, ceiling: 10 });
    expect(limits.stopLossCooldownMs).toEqual({ value: 60000, source: 'agent_override', mutable: true, ceiling: 300000 });
    // Runtime is present with defaults when botRepo absent
    const runtime = data.runtime as Record<string, unknown>;
    expect(runtime).toBeDefined();
    const openPositions = runtime.openPositions as Record<string, unknown>;
    expect(openPositions.current).toBe(0);
    expect(openPositions.limit).toBe(10);
    expect(openPositions.blocked).toBe(false);
    const dailyLoss = runtime.dailyLoss as Record<string, unknown>;
    expect(dailyLoss.current).toBe('0');
    expect(dailyLoss.limit).toBeNull();
    expect(dailyLoss.blocked).toBe(false);
    expect(dailyLoss.oldestFillAgesOutAt).toBeNull();
    expect(dailyLoss.remainingMs).toBeNull();
    const drawdown = runtime.drawdown as Record<string, unknown>;
    expect(drawdown.current).toBeNull();
    // drawdown.limit defaults to the operator default (1B) when no user/agent config is present
    expect(drawdown.limit).toBe('1000000000');
    expect(drawdown.approaching).toBe(false);
  });

  it('returns runtime with open positions from botRepo', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      riskContractOps: {
        getContract: vi.fn().mockResolvedValue(contract),
        adjustOverrides: vi.fn(),
      },
      botRepo: {
        getOpenPositionsByCreator: vi.fn().mockResolvedValue([
          { actorType: 'agent', actorId: 'agent-1', symbol: 'BTC-USD', side: 'long', size: '0.1', entryPrice: '50000', openedAt: new Date() },
          { actorType: 'agent', actorId: 'agent-1', symbol: 'ETH-USD', side: 'short', size: '2', entryPrice: '3000', openedAt: new Date() },
          { actorType: 'agent', actorId: 'agent-1', symbol: 'SOL-USD', side: 'long', size: '0', entryPrice: '100', openedAt: new Date() },
        ]),
        getAnalyticsByCreator: vi.fn().mockResolvedValue({ realizedPnlUsd: '0', botCount: 0, openPositions: 0, closedPositions: 0, winningPositions: 0, totalFeesUsd: '0', recentFills: 0, avgHoldTimeHours: null, byBot: [] }),
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
      },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const runtime = (result.data as Record<string, unknown>).runtime as Record<string, unknown>;
    const openPositions = runtime.openPositions as Record<string, unknown>;
    // 3 positions, but SOL has size '0' → counts as flat, so 2 non-flat
    expect(openPositions.current).toBe(2);
    expect(openPositions.limit).toBe(10);
    expect(openPositions.blocked).toBe(false);
  });

  it('marks openPositions.blocked when current >= limit', async () => {
    const contract = makeContract({ maxOpenPositions: { effectiveValue: 2, source: 'default', mutable: true, operatorCeiling: 10 } });
    const ctx = makeCtx({
      riskContractOps: {
        getContract: vi.fn().mockResolvedValue(contract),
        adjustOverrides: vi.fn(),
      },
      botRepo: {
        getOpenPositionsByCreator: vi.fn().mockResolvedValue([
          { actorType: 'agent', actorId: 'agent-1', symbol: 'BTC-USD', side: 'long', size: '0.1', entryPrice: '50000', openedAt: new Date() },
          { actorType: 'agent', actorId: 'agent-1', symbol: 'ETH-USD', side: 'short', size: '2', entryPrice: '3000', openedAt: new Date() },
        ]),
        getAnalyticsByCreator: vi.fn().mockResolvedValue({ realizedPnlUsd: '0', botCount: 0, openPositions: 0, closedPositions: 0, winningPositions: 0, totalFeesUsd: '0', recentFills: 0, avgHoldTimeHours: null, byBot: [] }),
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
      },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const runtime = (result.data as Record<string, unknown>).runtime as Record<string, unknown>;
    const openPositions = runtime.openPositions as Record<string, unknown>;
    expect(openPositions.current).toBe(2);
    expect(openPositions.limit).toBe(2);
    expect(openPositions.blocked).toBe(true);
  });

  it('marks dailyLoss.blocked when loss exceeds limit', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      riskContractOps: {
        getContract: vi.fn().mockResolvedValue(contract),
        adjustOverrides: vi.fn(),
      },
      botRepo: {
        getOpenPositionsByCreator: vi.fn().mockResolvedValue([]),
        getAnalyticsByCreator: vi.fn().mockResolvedValue({ realizedPnlUsd: '-600', botCount: 1, openPositions: 0, closedPositions: 5, winningPositions: 3, totalFeesUsd: '10', recentFills: 10, avgHoldTimeHours: 2, byBot: [] }),
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
      },
      agentRepo: {
        getAgent: vi.fn().mockResolvedValue({ capital: '5000', risk: { dailyMaxLossPct: 10 } }),
      },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const runtime = (result.data as Record<string, unknown>).runtime as Record<string, unknown>;
    const dailyLoss = runtime.dailyLoss as Record<string, unknown>;
    expect(dailyLoss.current).toBe('-600');
    // capital 5000 × 10% = 500
    expect(dailyLoss.limit).toBe('500');
    expect(dailyLoss.limitPct).toBe(10);
    // |-600| = 600 >= 500 → blocked
    expect(dailyLoss.blocked).toBe(true);
  });

  it('dailyLoss.blocked is false when loss is within limit', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      riskContractOps: {
        getContract: vi.fn().mockResolvedValue(contract),
        adjustOverrides: vi.fn(),
      },
      botRepo: {
        getOpenPositionsByCreator: vi.fn().mockResolvedValue([]),
        getAnalyticsByCreator: vi.fn().mockResolvedValue({ realizedPnlUsd: '-200', botCount: 1, openPositions: 0, closedPositions: 5, winningPositions: 3, totalFeesUsd: '10', recentFills: 10, avgHoldTimeHours: 2, byBot: [] }),
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
      },
      agentRepo: {
        getAgent: vi.fn().mockResolvedValue({ capital: '5000', risk: { dailyMaxLossPct: 10 } }),
      },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const runtime = (result.data as Record<string, unknown>).runtime as Record<string, unknown>;
    const dailyLoss = runtime.dailyLoss as Record<string, unknown>;
    expect(dailyLoss.current).toBe('-200');
    expect(dailyLoss.limit).toBe('500');
    // |-200| = 200 < 500 → not blocked
    expect(dailyLoss.blocked).toBe(false);
  });

  it('dailyLoss.blocked is false when agent is profitable (realizedPnlUsd positive)', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      riskContractOps: {
        getContract: vi.fn().mockResolvedValue(contract),
        adjustOverrides: vi.fn(),
      },
      botRepo: {
        getOpenPositionsByCreator: vi.fn().mockResolvedValue([]),
        getAnalyticsByCreator: vi.fn().mockResolvedValue({ realizedPnlUsd: '500', botCount: 1, openPositions: 0, closedPositions: 5, winningPositions: 3, totalFeesUsd: '10', recentFills: 10, avgHoldTimeHours: 2, byBot: [] }),
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
      },
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ risk: { dailyMaxLossPct: 2 } }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn(),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn(),
      },
      agentRepo: {
        getAgent: vi.fn().mockResolvedValue({ capital: '10000' }),
      },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const runtime = (result.data as Record<string, unknown>).runtime as Record<string, unknown>;
    const dailyLoss = runtime.dailyLoss as Record<string, unknown>;
    expect(dailyLoss.blocked).toBe(false);
    expect(dailyLoss.current).toBe('500');
  });

  it('returns error when riskContractOps is not available', async () => {
    const ctx = makeCtx();
    const result = await getRiskLimitsTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('routes the read through the boundary when configured (does NOT touch riskContractOps)', async () => {
    const boundaryData = { ok: true, limits: { maxOpenPositions: { value: 7 } }, runtime: {} };
    const invoke = vi.fn().mockResolvedValue({ kind: 'success', data: boundaryData });
    const getContract = vi.fn();
    const ctx = makeCtx({
      tradertonBoundary: { invoke },
      riskContractOps: { getContract, adjustOverrides: vi.fn() },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_risk_limits', payload: {} });
    expect(getContract).not.toHaveBeenCalled(); // boundary sourced, not in-process
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('falls back to the in-process read when the boundary is absent (read-fallback posture)', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      riskContractOps: { getContract: vi.fn().mockResolvedValue(contract), adjustOverrides: vi.fn() },
    });
    const result = await getRiskLimitsTool.execute({}, ctx);
    expect(result.success).toBe(true);
    const limits = (result.data as Record<string, unknown>).limits as Record<string, unknown>;
    expect(limits.maxOpenPositions).toEqual({ value: 10, source: 'default', mutable: true, ceiling: 10 });
  });
});

describe('adjust_risk_limits tool', () => {
  it('routes the write through the boundary and returns the boundary success payload', async () => {
    const successPayload = {
      ok: true,
      note: 'Risk limits updated. Changes take effect on next decision cycle.',
      limits: { maxOpenPositions: { value: 7, source: 'agent_override', mutable: true, ceiling: 10 } },
    };
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'success',
      requestId: 'req-1',
      correlationId: 'corr-1',
      payload: successPayload,
    });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 7 }, ctx);

    expect(result.success).toBe(true);
    // The tool forwards ONLY the explicitly-provided overrides as the payload.
    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    const call = invokeAndAwait.mock.calls[0]![0] as { toolName: string; payload: unknown; deadlineMs: number };
    expect(call.toolName).toBe('adjust_risk_limits');
    expect(call.payload).toEqual({ maxOpenPositions: 7 });
    expect(call.deadlineMs).toBeGreaterThan(0);
    // Boundary success shape passes through unchanged (parity).
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.note).toContain('next decision cycle');
  });

  it('forwards a null override to reset a field to default', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'success',
      requestId: 'req-1',
      correlationId: 'corr-1',
      payload: { ok: true, note: 'Risk limits updated.' },
    });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await adjustRiskLimitsTool.execute({ stopLossCooldownMs: null }, ctx);

    expect(result.success).toBe(true);
    const call = invokeAndAwait.mock.calls[0]![0] as { payload: unknown };
    expect(call.payload).toEqual({ stopLossCooldownMs: null });
  });

  it('maps a boundary failure to a typed non-fault failure preserving code', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'validation.invalid_payload',
      message: "Field 'maxOpenPositions' is creator-configured",
      retryable: false,
    });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 3 }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('creator-configured');
    expect(result.errorCode).toBe('validation.invalid_payload');
    expect(result.fault).toBe(false);
  });

  it('maps a boundary in_progress to a precondition.not_ready failure', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 3 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });

  it('maps a boundary transport_error to a retryable fault', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({ kind: 'transport_error', requestId: 'req-1', retryable: true, message: 'down' });
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 3 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('boundary.transport_error');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(true);
  });

  it('returns error when no fields are provided (before touching the boundary)', async () => {
    const invokeAndAwait = vi.fn();
    const ctx = makeCtx({ tradertonWriteBoundary: { invokeAndAwait } });

    const result = await adjustRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No fields provided');
    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('HARD-FAILS with precondition.not_ready when the write boundary is absent (no in-process fallback)', async () => {
    const adjustOverrides = vi.fn();
    const ctx = makeCtx({
      // riskContractOps present (read path uses it) but NO write boundary.
      riskContractOps: {
        getContract: vi.fn(),
        adjustOverrides,
      },
    });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 5 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.error).toContain('boundary not configured');
    expect(result.fault).toBe(false);
    // The in-process riskContractOps.adjustOverrides is NEVER called (fail-closed).
    expect(adjustOverrides).not.toHaveBeenCalled();
  });
});
