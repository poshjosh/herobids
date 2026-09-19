import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, TradertonReadResult } from '@herobids/domain';
import { accountTools } from './account.js';

const getAccountSummary = accountTools.find((t) => t.name === 'get_account_summary')!;

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
  } as unknown as ToolContext;
}

// c4.9i: get_account_summary sources solely over the Traderton boundary — it
// returns the same `data` shape it used to build locally, so the tool passes
// the boundary payload through unchanged. The former local-botRepo fallback
// tests (capital/positions/warnings assembly) were removed with that dead path.

describe('get_account_summary — Traderton boundary', () => {
  it('routes over the boundary, forwarding an empty payload (no spec resolver)', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, capital: '10000' } });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getAccountSummary.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_account_summary', payload: {} });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, capital: '10000' });
  });

  // A3: the PLATFORM attaches the risk spec (post-LLM, from the `agents` row via
  // agentRiskSpecResolver) so traderton serves capital + the contract from its
  // RiskSource seam.
  it('attaches the platform risk spec to the read payload when the resolver resolves', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, capital: '1000' } });
    const ctx = makeCtx({
      tradertonBoundary: boundary,
      agentRiskSpecResolver: vi.fn(async () => ({
        capital: '1000',
        riskPosture: { maxOpenPositions: 3 },
        riskOverrides: { maxDrawdownPct: 5 },
      })),
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith({
      toolName: 'get_account_summary',
      payload: {
        capital: '1000',
        riskPosture: { maxOpenPositions: 3 },
        riskOverrides: { maxDrawdownPct: 5 },
      },
    });
  });

  it('attaches nothing beyond present fields (null capital / null posture are omitted)', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true, capital: null } });
    const ctx = makeCtx({
      tradertonBoundary: boundary,
      agentRiskSpecResolver: vi.fn(async () => ({ capital: null, riskPosture: null, riskOverrides: null })),
    });

    await getAccountSummary.execute({}, ctx);
    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_account_summary', payload: {} });
  });

  it('degrades to an empty payload when the spec resolver throws', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true } });
    const ctx = makeCtx({
      tradertonBoundary: boundary,
      agentRiskSpecResolver: vi.fn(async () => { throw new Error('db down'); }),
    });

    const result = await getAccountSummary.execute({}, ctx);
    expect(invoke).toHaveBeenCalledWith({ toolName: 'get_account_summary', payload: {} });
    expect(result.success).toBe(true);
  });

  it('maps a content-level failure (not_found) to a non-fault failure preserving code/retryable', async () => {
    const { boundary } = stubBoundary({
      kind: 'failure',
      code: 'not_found.resource',
      message: 'no account',
      retryable: false,
    });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
    expect(result.error).toBe('no account');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
  });

  it('maps an infrastructure failure to a fault failure', async () => {
    const { boundary } = stubBoundary({
      kind: 'failure',
      code: 'internal.non_retryable',
      message: 'boom',
      retryable: false,
    });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('internal.non_retryable');
    expect(result.fault).toBe(true);
  });

  it('maps transport_error to a retryable fault', async () => {
    const { boundary } = stubBoundary({ kind: 'transport_error', message: 'down', retryable: true });
    const ctx = makeCtx({ tradertonBoundary: boundary });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('boundary.transport_error');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(true);
  });

  it('fails closed with a typed precondition when the boundary is absent', async () => {
    const ctx = makeCtx();

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('precondition.not_ready');
    expect(result.fault).toBe(false);
  });
});
