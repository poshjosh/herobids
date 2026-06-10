import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLeaderElection } from './leader-election.js';

function makeRedisMock() {
  const store = new Map<string, string>();

  return {
    _store: store,
    set: vi.fn(async (key: string, _value: string, ..._args: unknown[]) => {
      // SET NX: only set if absent
      const args = _args as string[];
      const nxIdx = args.indexOf('NX');
      if (nxIdx !== -1 && store.has(key)) return null;
      store.set(key, _value as string);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (_script: string, _keys: number, ...args: string[]) => {
      // eval(script, numKeys, key, workerId, [ttlSeconds])
      // args[0] = KEYS[1] (the Redis key), args[1] = ARGV[1] (workerId)
      const script = _script as string;
      const key = args[0]!;           // KEYS[1]
      const workerId = args[1]!;      // ARGV[1]

      if (script.includes('expire')) {
        // renew script
        const val = store.get(key);
        if (!val) return 0;
        const data = JSON.parse(val) as { workerId: string };
        return data.workerId === workerId ? 1 : 0;
      } else if (script.includes('del')) {
        // release script
        const val = store.get(key);
        if (!val) return 0;
        const data = JSON.parse(val) as { workerId: string };
        if (data.workerId === workerId) { store.delete(key); return 1; }
        return 0;
      }
      return 0;
    }),
  } as any;
}

describe('createLeaderElection — acquire', () => {
  it('acquires leadership when key is absent and returns true', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });

    const result = await election.acquire();

    expect(result).toBe(true);
    expect(election.isLeader()).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      'market-intel:leader',
      expect.stringContaining('"workerId":"worker-A"'),
      'EX',
      5,
      'NX',
    );
  });

  it('returns false when another leader already holds the key', async () => {
    const redis = makeRedisMock();
    // Pre-occupy the key
    redis._store.set('market-intel:leader', JSON.stringify({ workerId: 'worker-B' }));

    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    const result = await election.acquire();

    expect(result).toBe(false);
    expect(election.isLeader()).toBe(false);
  });

  it('stores workerId in leader key value', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-X', ttlSeconds: 10 });

    await election.acquire();

    const stored = redis._store.get('market-intel:leader')!;
    const parsed = JSON.parse(stored) as { workerId: string; startedAt: string };
    expect(parsed.workerId).toBe('worker-X');
    expect(parsed.startedAt).toBeDefined();
  });
});

describe('createLeaderElection — renew', () => {
  it('returns true and stays leader when worker owns the key', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    // Must acquire first — renew preserves the leader state set by acquire
    await election.acquire();

    const result = await election.renew();

    expect(result).toBe(true);
    expect(election.isLeader()).toBe(true);
  });

  it('returns false and clears leadership when worker no longer owns the key', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    await election.acquire();
    // Simulate another worker taking the lease
    redis._store.set('market-intel:leader', JSON.stringify({ workerId: 'worker-B' }));

    const result = await election.renew();

    expect(result).toBe(false);
    expect(election.isLeader()).toBe(false);
  });

  it('returns false when key has expired (no value in store)', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    await election.acquire();
    // Simulate TTL expiry — delete the key
    redis._store.delete('market-intel:leader');

    const result = await election.renew();

    expect(result).toBe(false);
    expect(election.isLeader()).toBe(false);
  });
});

describe('createLeaderElection — release', () => {
  it('deletes the key when worker owns it', async () => {
    const redis = makeRedisMock();
    redis._store.set('market-intel:leader', JSON.stringify({ workerId: 'worker-A' }));

    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    await election.release();

    expect(redis._store.has('market-intel:leader')).toBe(false);
    expect(election.isLeader()).toBe(false);
  });

  it('does not delete key when worker does not own it', async () => {
    const redis = makeRedisMock();
    redis._store.set('market-intel:leader', JSON.stringify({ workerId: 'worker-B' }));

    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    await election.release();

    expect(redis._store.has('market-intel:leader')).toBe(true);
  });
});

describe('createLeaderElection — stop', () => {
  it('releases leadership on stop when worker is leader', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    await election.acquire();

    await election.stop();

    expect(election.isLeader()).toBe(false);
    expect(redis._store.has('market-intel:leader')).toBe(false);
  });

  it('does not error on stop when worker is not leader', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });

    await expect(election.stop()).resolves.not.toThrow();
  });
});

describe('createLeaderElection — start callbacks', () => {
  it('calls onAcquired when acquisition succeeds', async () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });

    const onAcquired = vi.fn();
    const onLost = vi.fn();

    election.start(onAcquired, onLost);

    // Let the async acquire complete
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(onAcquired).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();

    await election.stop();
  });

  it('does NOT call onAcquired when key is held by another worker', async () => {
    const redis = makeRedisMock();
    redis._store.set('market-intel:leader', JSON.stringify({ workerId: 'worker-B' }));

    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 5 });
    const onAcquired = vi.fn();
    const onLost = vi.fn();

    election.start(onAcquired, onLost);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(onAcquired).not.toHaveBeenCalled();

    await election.stop();
  });
});

describe('createLeaderElection — isLeader default', () => {
  it('returns false before any acquisition attempt', () => {
    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A' });
    expect(election.isLeader()).toBe(false);
  });
});

describe('createLeaderElection — re-acquisition', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onAcquired again after leadership is lost and later re-acquired', async () => {
    vi.useFakeTimers();

    const redis = makeRedisMock();
    const election = createLeaderElection(redis, { workerId: 'worker-A', ttlSeconds: 1 });
    const onAcquired = vi.fn();
    const onLost = vi.fn();

    election.start(onAcquired, onLost);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAcquired).toHaveBeenCalledTimes(1);

    redis._store.set('market-intel:leader', JSON.stringify({ workerId: 'worker-B' }));
    await vi.advanceTimersByTimeAsync(450);
    expect(onLost).toHaveBeenCalledTimes(1);

    redis._store.delete('market-intel:leader');
    await vi.advanceTimersByTimeAsync(1050);

    expect(onAcquired).toHaveBeenCalledTimes(2);

    await election.stop();
  });
});
