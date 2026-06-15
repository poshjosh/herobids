import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, ResolvedAgentRiskContract } from '@herobids/domain';
import { riskLimitsTools } from './risk-limits.js';

const getRiskLimitsTool = riskLimitsTools.find((t) => t.name === 'get_risk_limits')!;
const adjustRiskLimitsTool = riskLimitsTools.find((t) => t.name === 'adjust_risk_limits')!;

function makeContract(overrides?: Partial<ResolvedAgentRiskContract>): ResolvedAgentRiskContract {
  return {
    maxOpenPositions: { effectiveValue: 10, source: 'default', mutable: true, operatorCeiling: 10 },
    maxPositionSizePct: { effectiveValue: 100, source: 'default', mutable: true, operatorCeiling: 100 },
    stopLossPct: { effectiveValue: 5, source: 'user', mutable: false, operatorCeiling: 10, creatorValue: 5 },
    stopLossCooldownMs: { effectiveValue: 60000, source: 'agent_override', mutable: true, operatorCeiling: 300000, overrideValue: 60000 },
    ...overrides,
  };
}

function makeCtx(riskContractOps: ToolContext['riskContractOps']): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    redis: { hset: vi.fn(), hget: vi.fn(), hgetall: vi.fn(), hdel: vi.fn(), publish: vi.fn() },
    publishToInbound: vi.fn(),
    riskContractOps,
  };
}

describe('get_risk_limits tool', () => {
  it('returns structured contract with source and mutability', async () => {
    const contract = makeContract();
    const ctx = makeCtx({
      getContract: vi.fn().mockResolvedValue(contract),
      adjustOverrides: vi.fn(),
    });

    const result = await getRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const limits = (result.data as Record<string, unknown>).limits as Record<string, unknown>;
    expect(limits.maxOpenPositions).toEqual({ value: 10, source: 'default', mutable: true, ceiling: 10 });
    expect(limits.stopLossPct).toEqual({ value: 5, source: 'user', mutable: false, ceiling: 10 });
    expect(limits.stopLossCooldownMs).toEqual({ value: 60000, source: 'agent_override', mutable: true, ceiling: 300000 });
  });

  it('returns error when riskContractOps is not available', async () => {
    const ctx = makeCtx(undefined);
    const result = await getRiskLimitsTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });
});

describe('adjust_risk_limits tool', () => {
  it('successfully adjusts mutable fields', async () => {
    const updatedContract = makeContract({
      maxOpenPositions: { effectiveValue: 7, source: 'agent_override', mutable: true, operatorCeiling: 10, overrideValue: 7 },
    });
    const adjustOverrides = vi.fn().mockResolvedValue({ ok: true, contract: updatedContract });
    const ctx = makeCtx({
      getContract: vi.fn().mockResolvedValue(makeContract()),
      adjustOverrides,
    });

    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 7 }, ctx);

    expect(result.success).toBe(true);
    expect(adjustOverrides).toHaveBeenCalledWith({ maxOpenPositions: 7 });
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.note).toContain('next decision cycle');
  });

  it('passes null to reset a field to default', async () => {
    const adjustOverrides = vi.fn().mockResolvedValue({ ok: true, contract: makeContract() });
    const ctx = makeCtx({
      getContract: vi.fn().mockResolvedValue(makeContract()),
      adjustOverrides,
    });

    const result = await adjustRiskLimitsTool.execute({ stopLossCooldownMs: null }, ctx);

    expect(result.success).toBe(true);
    expect(adjustOverrides).toHaveBeenCalledWith({ stopLossCooldownMs: null });
  });

  it('returns error when adjustment is rejected', async () => {
    const adjustOverrides = vi.fn().mockResolvedValue({ ok: false, error: "Field 'stopLossPct' is creator-configured" });
    const ctx = makeCtx({
      getContract: vi.fn().mockResolvedValue(makeContract()),
      adjustOverrides,
    });

    const result = await adjustRiskLimitsTool.execute({ stopLossPct: 3 }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('creator-configured');
  });

  it('returns error when no fields are provided', async () => {
    const ctx = makeCtx({
      getContract: vi.fn(),
      adjustOverrides: vi.fn(),
    });

    const result = await adjustRiskLimitsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No fields provided');
  });

  it('returns error when riskContractOps is not available', async () => {
    const ctx = makeCtx(undefined);
    const result = await adjustRiskLimitsTool.execute({ maxOpenPositions: 5 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });
});
