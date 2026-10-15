import { describe, expect, it, vi } from 'vitest';
import { listProvidersTool, projectProviders, requestConnectionTool } from './connections.js';
import type { ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';

describe('list_providers', () => {
  it('hides trading providers without a trading skill or explicit filter', () => {
    expect(projectProviders([], undefined, false).map((provider) => provider.provider)).toEqual(['gmail']);
    expect(projectProviders([], 'trading', false).map((provider) => provider.provider)).toEqual([
      'hyperliquid', 'bybit', '1inch', 'jupiter',
    ]);
    expect(projectProviders([], 'email', true).map((provider) => provider.provider)).toEqual(['gmail']);
  });

  it('distinguishes an active owner connection from an agent grant', () => {
    const providers = projectProviders([
      { provider: 'gmail', connectionId: 'owner-connection', granted: false },
      { provider: 'hyperliquid', connectionId: 'agent-connection', granted: true },
    ], undefined, true);
    expect(providers.find((provider) => provider.provider === 'gmail')).toMatchObject({
      hasActiveConnection: true, grantedToThisAgent: false, authMethod: 'oauth',
    });
    expect(providers.find((provider) => provider.provider === 'hyperliquid')).toMatchObject({
      hasActiveConnection: true, grantedToThisAgent: true,
    });
    expect(providers.find((provider) => provider.provider === 'bybit')).toMatchObject({
      hasActiveConnection: false, grantedToThisAgent: false,
    });
  });

  it('only advertises generated wallets when enabled by the operator', () => {
    expect(projectProviders([], 'trading', false).find((provider) => provider.provider === 'hyperliquid')?.authMethod).toBe('api_key');
    expect(projectProviders([], 'trading', false, ['hyperliquid']).find((provider) => provider.provider === 'hyperliquid')?.authMethod).toBe('generated_wallet');
  });

  it('does not imply that an unavailable database means no connections', async () => {
    const result = await listProvidersTool.execute({}, { agentId: 'agent-1' } as ToolContext);
    expect(result).toMatchObject({ success: false, errorCode: 'precondition.not_ready' });
  });
});

// ── request_connection ──────────────────────────────────────────────────────

function makeRedisMock(overrides: Partial<ToolContext['redis']> = {}): ToolContext['redis'] {
  return {
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
    hdel: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    blpop: vi.fn(async () => null),
    smembers: vi.fn(async () => []),
    sadd: vi.fn(async () => 0),
    srem: vi.fn(async () => 0),
    expire: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    authorizationMode: 'direct',
    permissionLevel: 'standard',
    redis: makeRedisMock(),
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

describe('request_connection', () => {
  it('is registered with write-database category', () => {
    expect(requestConnectionTool.category).toBe('write-database');
  });

  it('publishes REQUEST_CONNECTION with provider and requestMessageId', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisMock({
        blpop: vi.fn(async () => ['key', JSON.stringify({
          status: 'ok',
          requestId: 'req-1',
          link: 'http://localhost:3000/auth/connection-request/callback?token=abc',
          expiresAt: '2026-10-13T12:00:00.000Z',
        })]),
      }),
    });

    const result = await requestConnectionTool.execute({ provider: 'gmail' }, ctx);

    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.REQUEST_CONNECTION,
      expect.objectContaining({ provider: 'gmail' }),
    );
    const [, payload] = publishToInbound.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.requestMessageId).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      requestId: 'req-1',
      link: 'http://localhost:3000/auth/connection-request/callback?token=abc',
      expiresAt: '2026-10-13T12:00:00.000Z',
    });
  });

  it('returns a non-fault error on broker error reply', async () => {
    const ctx = makeCtx({
      redis: makeRedisMock({
        blpop: vi.fn(async () => ['key', JSON.stringify({
          status: 'error',
          error: 'A connection request for "gmail" is already pending.',
          errorCode: 'connection.request_pending',
        })]),
      }),
    });

    const result = await requestConnectionTool.execute({ provider: 'gmail' }, ctx);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'connection.request_pending',
      fault: false,
    });
  });

  it('handles a capability denial reply', async () => {
    const ctx = makeCtx({
      redis: makeRedisMock({
        blpop: vi.fn(async () => ['key', JSON.stringify({
          status: 'rejected',
          code: 'capability_denied:rate_limit_exceeded',
          message: 'Rate limited',
          retryAfterMs: 5000,
        })]),
      }),
    });

    const result = await requestConnectionTool.execute({ provider: 'gmail' }, ctx);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'capability_denied:rate_limit_exceeded',
      retryable: true,
      fault: false,
    });
  });

  it('returns a retryable timeout when the broker never replies', async () => {
    const ctx = makeCtx({
      redis: makeRedisMock({ blpop: vi.fn(async () => null) }),
    });

    const result = await requestConnectionTool.execute({ provider: 'gmail' }, ctx);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'broker.timeout',
      retryable: true,
    });
  });

  it('rejects invalid params', async () => {
    const ctx = makeCtx();
    const result = await requestConnectionTool.execute({ provider: '' }, ctx);
    expect(result).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
  });
});