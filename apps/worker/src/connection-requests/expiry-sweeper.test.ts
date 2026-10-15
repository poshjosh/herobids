import { describe, expect, it, vi } from 'vitest';
import { sweepExpiredConnectionRequests } from './expiry-sweeper.js';

const NOW = Date.parse('2026-10-13T10:45:00.000Z');

const pendingRecord = {
  requestId: 'req-1',
  token: 'tok-1',
  agentId: 'agent-1',
  userId: 'user-1',
  provider: 'gmail',
  status: 'pending',
  createdAt: '2026-10-13T10:00:00.000Z',
  expiresAt: '2026-10-13T10:30:00.000Z',
};

function makeRedis(records: Record<string, Record<string, unknown>>, dueIds: string[]) {
  const store = new Map<string, string>(
    Object.entries(records).map(([id, rec]) => [`connection-request:${id}`, JSON.stringify(rec)]),
  );
  return {
    store,
    zrangebyscore: vi.fn(async () => dueIds),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    ttl: vi.fn(async () => 600),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    srem: vi.fn(async () => 1),
    zrem: vi.fn(async () => 1),
  };
}

describe('sweepExpiredConnectionRequests', () => {
  it('wakes the agent once with reason expired and releases the pending state', async () => {
    const redis = makeRedis({ 'req-1': pendingRecord }, ['req-1']);
    const publisher = { emitAgentWake: vi.fn(async () => undefined) };

    const expired = await sweepExpiredConnectionRequests(redis as never, publisher as never, NOW);

    expect(expired).toBe(1);
    expect(publisher.emitAgentWake).toHaveBeenCalledTimes(1);
    expect(publisher.emitAgentWake).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      source: 'connection',
      context: { requestId: 'req-1', provider: 'gmail', reason: 'expired' },
    }));
    expect(JSON.parse(redis.store.get('connection-request:req-1')!).status).toBe('expired');
    expect(redis.zrem).toHaveBeenCalledWith('connection-requests:pending', 'req-1');
    expect(redis.del).toHaveBeenCalledWith('connection-request:pending:agent-1:gmail');
  });

  it('does not wake the agent for a request that already completed', async () => {
    const redis = makeRedis({ 'req-1': { ...pendingRecord, status: 'completed' } }, ['req-1']);
    const publisher = { emitAgentWake: vi.fn(async () => undefined) };

    const expired = await sweepExpiredConnectionRequests(redis as never, publisher as never, NOW);

    expect(expired).toBe(0);
    expect(publisher.emitAgentWake).not.toHaveBeenCalled();
    expect(redis.zrem).toHaveBeenCalledWith('connection-requests:pending', 'req-1');
  });

  it('leaves the request pending when the wake cannot be published, so the next sweep retries', async () => {
    const redis = makeRedis({ 'req-1': pendingRecord }, ['req-1']);
    const publisher = { emitAgentWake: vi.fn(async () => { throw new Error('redis down'); }) };

    const expired = await sweepExpiredConnectionRequests(redis as never, publisher as never, NOW);

    expect(expired).toBe(0);
    expect(JSON.parse(redis.store.get('connection-request:req-1')!).status).toBe('pending');
    expect(redis.zrem).not.toHaveBeenCalled();
  });
});
