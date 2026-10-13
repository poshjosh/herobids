import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, ExternalBackendReadResult } from '@herobids/domain';
import { accountTools } from './account.js';

const getFundingInfo = accountTools.find((t) => t.name === 'get_funding_info')!;

function stubBoundary(result: ExternalBackendReadResult) {
  const invoke = vi.fn(async () => result);
  return { boundary: { invoke }, invoke };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {} as unknown as ToolContext['redis'],
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ToolContext;
}

describe('get_funding_info — Traderton boundary', () => {
  it('reads funding for the platform-selected venue account', async () => {
    const payload = { ok: true, fundingStatus: 'unfunded', fundingAddress: '0xWallet', network: 'Hyperliquid', balance: null };
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: payload });
    const ctx = makeCtx({
      externalBackend: boundary,
      selectedVenueAccountResolver: vi.fn(async () => ({ status: 'ready', venueAccountId: 'venue-account-1' })),
    });

    const result = await getFundingInfo.execute({}, ctx);

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'get_funding_info',
      payload: { venueAccountId: 'venue-account-1' },
    });
    expect(result.success).toBe(true);
  });

  it('returns connection.missing without calling the boundary when no connection is granted', async () => {
    const { boundary, invoke } = stubBoundary({ kind: 'success', data: { ok: true } });
    const ctx = makeCtx({
      externalBackend: boundary,
      selectedVenueAccountResolver: vi.fn(async () => ({ status: 'missing' })),
    });

    const result = await getFundingInfo.execute({}, ctx);

    expect(invoke).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
