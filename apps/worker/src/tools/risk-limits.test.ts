import { describe, it, expect, vi } from 'vitest';
import { TRADING_SKILL, type ToolContext, type ResolvedAgentRiskContract } from '@herobids/domain';
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
  agentConfigOps?: ToolContext['agentConfigOps'];
  agentRepo?: ToolContext['agentRepo'];
  tradertonWriteBoundary?: ToolContext['tradertonWriteBoundary'];
  tradertonBoundary?: ToolContext['tradertonBoundary'];
  selectedVenueAccountResolver?: ToolContext['selectedVenueAccountResolver'];
} = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    redis: { hset: vi.fn(), hget: vi.fn(), hgetall: vi.fn(), hdel: vi.fn(), publish: vi.fn(), blpop: vi.fn() },
    publishToInbound: vi.fn(),
    riskContractOps: opts.riskContractOps,
    agentConfigOps: opts.agentConfigOps,
    agentRepo: opts.agentRepo,
    tradertonWriteBoundary: opts.tradertonWriteBoundary,
    tradertonBoundary: opts.tradertonBoundary,
    selectedVenueAccountResolver: opts.selectedVenueAccountResolver,
  } as unknown as ToolContext;
}

describe('get_risk_limits tool', () => {
  // A6: the read is boundary-first and FAILS CLOSED when the read boundary is
  // absent — the in-process riskContractOps read fallback is deleted (A3's
  // RiskSource seam serves the reads; keeping an in-process copy would be a
  // split-brain trap). Same typed posture as the adjust write.
  it('HARD-FAILS with precondition.not_ready when the read boundary is absent (no in-process fallback)', async () => {
    const getContract = vi.fn();
    const ctx = makeCtx({
      riskContractOps: { getContract },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.error).toContain('boundary not configured');
    expect(result.fault).toBe(false);
    // The in-process riskContractOps read is NEVER consulted (fail-closed).
    expect(getContract).not.toHaveBeenCalled();
  });

  it('routes the read through the boundary when configured (does NOT touch riskContractOps)', async () => {
    const boundaryData = { ok: true, limits: { maxOpenPositions: { value: 7 } }, runtime: {} };
    const invoke = vi.fn().mockResolvedValue({ kind: 'success', data: boundaryData });
    const getContract = vi.fn();
    const ctx = makeCtx({
      tradertonBoundary: { invoke },
      riskContractOps: { getContract },
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(TRADING_SKILL.requiredTools).toContain('get_risk_limits');
    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_risk_limits', payload: {} });
    expect(getContract).not.toHaveBeenCalled(); // boundary sourced, not in-process
    expect(result.success).toBe(true);
    expect(result.data).toEqual(boundaryData);
  });

  it('attaches the platform-resolved selected account to the read payload', async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: 'failure',
      code: 'precondition.not_ready',
      message: 'risk context unavailable',
      retryable: true,
    });
    const ctx = makeCtx({
      tradertonBoundary: { invoke },
      selectedVenueAccountResolver: vi.fn(async () => 'venue-account-1'),
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'get_risk_limits',
      payload: { venueAccountId: 'venue-account-1' },
    });
    // The typed precondition maps through without counting as a fault.
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });

  it('degrades to an empty payload when the spec resolver is absent or throws', async () => {
    const invoke = vi.fn().mockResolvedValue({ kind: 'success', data: { ok: true } });
    const ctx = makeCtx({ tradertonBoundary: { invoke } });
    await getRiskLimitsTool.execute({}, ctx);
    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_risk_limits', payload: {} });

    const throwingCtx = makeCtx({
      tradertonBoundary: { invoke },
      selectedVenueAccountResolver: vi.fn(async () => { throw new Error('db down'); }),
    });
    await getRiskLimitsTool.execute({}, throwingCtx);
    expect(invoke).toHaveBeenLastCalledWith({ toolName: 'get_risk_limits', payload: {} });
  });

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
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      selectedVenueAccountResolver: vi.fn(async () => 'venue-account-1'),
    });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 7 }, ctx);

    expect(result.success).toBe(true);
    // The LLM schema contains overrides only; the selected venue account is
    // platform-resolved and added to the private boundary payload.
    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    const call = invokeAndAwait.mock.calls[0]![0] as { toolName: string; payload: unknown; deadlineMs: number };
    expect(call.toolName).toBe('adjust_risk_limits');
    expect(call.payload).toEqual({ maxOpenPositions: 7, venueAccountId: 'venue-account-1' });
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
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      selectedVenueAccountResolver: vi.fn(async () => 'venue-account-1'),
    });

    const result = await adjustRiskLimitsTool.execute({ stopLossCooldownMs: null }, ctx);

    expect(result.success).toBe(true);
    const call = invokeAndAwait.mock.calls[0]![0] as { payload: unknown };
    expect(call.payload).toEqual({ stopLossCooldownMs: null, venueAccountId: 'venue-account-1' });
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
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      selectedVenueAccountResolver: vi.fn(async () => 'venue-account-1'),
    });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 3 }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('creator-configured');
    expect(result.errorCode).toBe('validation.invalid_payload');
    expect(result.fault).toBe(false);
  });

  it('maps a boundary in_progress to a precondition.not_ready failure', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      selectedVenueAccountResolver: vi.fn(async () => 'venue-account-1'),
    });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 3 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });

  it('maps a boundary transport_error to a retryable fault', async () => {
    const invokeAndAwait = vi.fn().mockResolvedValue({ kind: 'transport_error', requestId: 'req-1', retryable: true, message: 'down' });
    const ctx = makeCtx({
      tradertonWriteBoundary: { invokeAndAwait },
      selectedVenueAccountResolver: vi.fn(async () => 'venue-account-1'),
    });

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
    const ctx = makeCtx({
      // riskContractOps (read fallback) present but NO write boundary — the
      // write has nothing to fall back to (adjust is boundary fail-closed).
      riskContractOps: {
        getContract: vi.fn(),
      },
    });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 5 }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.error).toContain('boundary not configured');
    expect(result.fault).toBe(false);
  });
});
