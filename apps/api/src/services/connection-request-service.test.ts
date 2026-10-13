import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@herobids/domain';

vi.mock('./agent-config-service.js', () => ({
  grantConnectionToRunningAgent: vi.fn(),
}));
vi.mock('./agent-runtime-refresh.js', () => ({
  publishAgentRuntimeRefresh: vi.fn(async () => undefined),
}));

import { grantConnectionToRunningAgent } from './agent-config-service.js';
import { publishAgentRuntimeRefresh } from './agent-runtime-refresh.js';
import { completeConnectionRequest, declineConnectionRequest, isConnectionRequestRedeemed, markConnectionRequestRedeemed, readConnectionRequestByToken } from './connection-request-service.js';

const pendingRecord = {
  requestId: 'req-1',
  token: 'tok-1',
  agentId: 'agent-1',
  userId: 'user-1',
  provider: 'gmail',
  mode: 'create',
  status: 'pending',
  createdAt: '2026-10-13T10:00:00.000Z',
  expiresAt: '2026-10-13T10:30:00.000Z',
};

function makeRedis(record: Record<string, unknown> = pendingRecord) {
  const store = new Map<string, string>([[`connection-request:${record.requestId}`, JSON.stringify(record)]]);
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    ttl: vi.fn(async () => 1200),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    srem: vi.fn(async () => 1),
    zrem: vi.fn(async () => 1),
  };
}

function makeDeps(redis: ReturnType<typeof makeRedis>) {
  const wakePublisher = { emitAgentWake: vi.fn(async () => undefined) };
  return {
    deps: { redis, db: {} as never, saga: {} as never, budgets: {} as never, wakePublisher },
    wakePublisher,
  };
}

const completeInput = { requestId: 'req-1', userId: 'user-1', provider: 'gmail', connectionId: 'conn-1' };

describe('completeConnectionRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants the connection, marks the request completed and wakes the agent once', async () => {
    vi.mocked(grantConnectionToRunningAgent).mockResolvedValue(ok({ granted: true }));
    const redis = makeRedis();
    const { deps, wakePublisher } = makeDeps(redis);

    const result = await completeConnectionRequest(deps, completeInput);

    expect(result.ok).toBe(true);
    expect(grantConnectionToRunningAgent).toHaveBeenCalledWith({}, 'agent-1', 'conn-1', 'user-1', {});
    expect(publishAgentRuntimeRefresh).toHaveBeenCalledWith({}, redis, {}, 'agent-1');
    expect(wakePublisher.emitAgentWake).toHaveBeenCalledTimes(1);
    expect(wakePublisher.emitAgentWake).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      source: 'connection',
      context: { requestId: 'req-1', provider: 'gmail', connectionId: 'conn-1', reason: 'completed' },
    }));
    expect(JSON.parse(redis.store.get('connection-request:req-1')!).status).toBe('completed');
  });

  it('keeps the request pending and does not wake when the grant fails', async () => {
    vi.mocked(grantConnectionToRunningAgent).mockResolvedValue(err({ code: 'config.internal_error', message: 'boom' }));
    const redis = makeRedis();
    const { deps, wakePublisher } = makeDeps(redis);

    const result = await completeConnectionRequest(deps, completeInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'config.internal_error' } });
    expect(wakePublisher.emitAgentWake).not.toHaveBeenCalled();
    expect(JSON.parse(redis.store.get('connection-request:req-1')!).status).toBe('pending');
  });

  it('rejects a connection for a different provider than the request', async () => {
    const redis = makeRedis();
    const { deps } = makeDeps(redis);

    const result = await completeConnectionRequest(deps, { ...completeInput, provider: 'bybit' });

    expect(result).toMatchObject({ ok: false, error: { code: 'connection.request_provider_mismatch' } });
    expect(grantConnectionToRunningAgent).not.toHaveBeenCalled();
  });

  it('does not complete a request owned by another user', async () => {
    const redis = makeRedis();
    const { deps } = makeDeps(redis);

    const result = await completeConnectionRequest(deps, { ...completeInput, userId: 'user-2' });

    expect(result).toMatchObject({ ok: false, error: { code: 'connection.request_not_found' } });
    expect(grantConnectionToRunningAgent).not.toHaveBeenCalled();
  });

  it('does not complete a request that is no longer pending', async () => {
    const redis = makeRedis({ ...pendingRecord, status: 'declined' });
    const { deps } = makeDeps(redis);

    const result = await completeConnectionRequest(deps, completeInput);

    expect(result).toMatchObject({ ok: false, error: { code: 'connection.request_not_pending' } });
  });
});

describe('connection request redeem helpers', () => {
  it('finds a pending request by its bearer token and ignores unknown tokens', async () => {
    const store = new Map<string, string>([['connection-request:req-1', JSON.stringify(pendingRecord)]]);
    const redis = {
      zrange: vi.fn(async () => ['req-1']),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    };

    expect((await readConnectionRequestByToken(redis as never, 'tok-1'))?.requestId).toBe('req-1');
    expect(await readConnectionRequestByToken(redis as never, 'wrong-token')).toBeNull();
  });

  it('reports a link as redeemed only after it is marked', async () => {
    const marks = new Map<string, string>();
    const redis = {
      ttl: vi.fn(async () => 1200),
      set: vi.fn(async (key: string, value: string) => { marks.set(key, value); return 'OK'; }),
      exists: vi.fn(async (key: string) => (marks.has(key) ? 1 : 0)),
    };

    expect(await isConnectionRequestRedeemed(redis as never, 'req-1')).toBe(false);
    await markConnectionRequestRedeemed(redis as never, 'req-1');
    expect(await isConnectionRequestRedeemed(redis as never, 'req-1')).toBe(true);
  });
});

describe('declineConnectionRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the request declined and wakes the agent with reason declined, without granting', async () => {
    const redis = makeRedis();
    const { deps, wakePublisher } = makeDeps(redis);

    const result = await declineConnectionRequest(deps, { requestId: 'req-1', userId: 'user-1' });

    expect(result.ok).toBe(true);
    expect(grantConnectionToRunningAgent).not.toHaveBeenCalled();
    expect(wakePublisher.emitAgentWake).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      context: { requestId: 'req-1', provider: 'gmail', reason: 'declined' },
    }));
    expect(JSON.parse(redis.store.get('connection-request:req-1')!).status).toBe('declined');
  });
});
