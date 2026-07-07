import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { accountTools } from './account.js';

const getAccountSummary = accountTools.find((t) => t.name === 'get_account_summary')!;

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

function mockPosition(overrides: Record<string, unknown> = {}) {
  return {
    actorType: 'agent',
    actorId: 'agent-1',
    symbol: 'BTC/USD:USD',
    side: 'long',
    size: '0.5',
    entryPrice: '50000',
    openedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('get_account_summary', () => {
  // -------------------------------------------------------------------------
  // DB unavailable
  // -------------------------------------------------------------------------

  it('returns error when botRepo is unavailable', async () => {
    const ctx = makeCtx({ botRepo: undefined });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('account.db_unavailable');
  });

  // -------------------------------------------------------------------------
  // Happy path — full data
  // -------------------------------------------------------------------------

  it('returns capital, positions, risk limits and config when all deps are available', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => [
          mockPosition({ actorType: 'agent', symbol: 'BTC/USD:USD' }),
          mockPosition({ actorType: 'bot', actorId: 'bot-1', symbol: 'ETH/USD:USD' }),
        ]),
      } as unknown as ToolContext['botRepo'],
      riskContractOps: {
        getContract: vi.fn(async () => ({
          maxOpenPositions: { effectiveValue: 5, source: 'user' },
          maxPositionSizePct: { effectiveValue: 25, source: 'default' },
          stopLossCooldownMs: { effectiveValue: 300000, source: 'default' },
        })),
      } as unknown as ToolContext['riskContractOps'],
      agentConfigOps: {
        getCurrentConfig: vi.fn(async () => ({
          execution: {
            mode: 'paper',
            positionSizeMode: 'percent_equity',
            fixedPositionSize: '100',
          },
        })),
      } as unknown as ToolContext['agentConfigOps'],
      agentRepo: {
        getAgent: vi.fn(async () => ({ capital: '10000' })),
      } as unknown as ToolContext['agentRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.capital).toBe('10000');
    expect(data.capitalAvailable).toBe(true);
    expect(data.executionMode).toBe('paper');
    expect(data.positionSizeMode).toBe('percent_equity');
    expect(data.fixedPositionSize).toBe('100');
    expect(data.openPositionCount).toBe(2);
    expect(data.agentDirectPositions).toBe(1);
    expect(data.botManagedPositions).toBe(1);
    expect(data.riskLimits).toMatchObject({ maxOpenPositions: 5 });
    expect((data.riskLimits as Record<string, unknown>).stopLossPct).toBeUndefined();
    expect((data.riskLimits as Record<string, unknown>).stopLossPctSource).toBeUndefined();
    expect(data.guidance).toEqual(expect.stringContaining('10000'));
    expect(data.warnings).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Partially available deps
  // -------------------------------------------------------------------------

  it('returns warnings when sub-dependencies are unavailable or fail', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
      riskContractOps: undefined,
      agentConfigOps: undefined,
      agentRepo: undefined,
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.capital).toBeNull();
    expect(data.capitalAvailable).toBe(false);
    expect(data.executionMode).toBe('unknown');
    expect(data.riskLimits).toBe('unavailable');
    const warnings = data.warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings).toContain('risk_contract_unavailable');
    expect(warnings).toContain('agent_config_unavailable');
    expect(warnings).toContain('agent_repo_unavailable');
  });

  // -------------------------------------------------------------------------
  // Sub-dependency throws
  // -------------------------------------------------------------------------

  it('handles sub-dependency throwing gracefully', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
      riskContractOps: {
        getContract: vi.fn(async () => {
          throw new Error('Redis down');
        }),
      } as unknown as ToolContext['riskContractOps'],
      agentConfigOps: {
        getCurrentConfig: vi.fn(async () => {
          throw new Error('DB error');
        }),
      } as unknown as ToolContext['agentConfigOps'],
      agentRepo: {
        getAgent: vi.fn(async () => {
          throw new Error('DB timeout');
        }),
      } as unknown as ToolContext['agentRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.riskLimits).toBe('unavailable');
    const warnings = data.warnings as string[] | undefined;
    expect(warnings).toContain('risk_contract_unavailable');
    expect(warnings).toContain('agent_config_unavailable');
    expect(warnings).toContain('agent_repo_unavailable');
  });

  // -------------------------------------------------------------------------
  // Top-level error
  // -------------------------------------------------------------------------

  it('returns error when getOpenPositionsByCreator throws', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => {
          throw new Error('DB connection lost');
        }),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('account.summary_failed');
    expect(result.error).toContain('DB connection lost');
  });

  // -------------------------------------------------------------------------
  // No capital available
  // -------------------------------------------------------------------------

  it('provides safe guidance when capital is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
      agentRepo: {
        getAgent: vi.fn(async () => null),
      } as unknown as ToolContext['agentRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.capital).toBeNull();
    expect(data.guidance).toEqual(expect.stringContaining('Capital information unavailable'));
  });
});
