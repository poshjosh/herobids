import { describe, expect, it, vi } from 'vitest';
import { NoopDiscoverySeenTracker, RedisDiscoverySeenTracker } from './discovery-seen-tracker.js';
import type { DiscoveredToken } from './types.js';

function makeToken(overrides: Partial<DiscoveredToken> & { address: string; network: string }): DiscoveredToken {
  return {
    symbol: 'TOK',
    name: 'Token',
    priceUsd: 1.0,
    volume24hUsd: 1000,
    liquidityUsd: 5000,
    source: 'dexscreener',
    discoveryVectors: ['trending_pools'],
    ...overrides,
  };
}

function makeRedis(overrides: {
  zadd?: ReturnType<typeof vi.fn>;
  zrangebyscore?: ReturnType<typeof vi.fn>;
  zremrangebyscore?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    zadd: overrides.zadd ?? vi.fn().mockResolvedValue(1),
    zrangebyscore: overrides.zrangebyscore ?? vi.fn().mockResolvedValue([]),
    zremrangebyscore: overrides.zremrangebyscore ?? vi.fn().mockResolvedValue(1),
  };
}

describe('NoopDiscoverySeenTracker', () => {
  it('applyAntiStaleness returns tokens unchanged', async () => {
    const tracker = new NoopDiscoverySeenTracker();
    const tokens = [
      makeToken({ address: 'addr-1', network: 'solana' }),
      makeToken({ address: 'addr-2', network: 'solana' }),
    ];
    const result = await tracker.applyAntiStaleness(tokens, 10_000);
    expect(result).toBe(tokens);
  });

  it('markSeen is a no-op and does not throw', async () => {
    const tracker = new NoopDiscoverySeenTracker();
    await expect(
      tracker.markSeen([makeToken({ address: 'addr-1', network: 'solana' })]),
    ).resolves.toBeUndefined();
  });
});

describe('RedisDiscoverySeenTracker.applyAntiStaleness', () => {
  it('fresh tokens appear before stale tokens', async () => {
    const staleAddr = 'stale-token';
    const freshAddr = 'fresh-token';

    const redis = makeRedis({
      zrangebyscore: vi.fn().mockResolvedValue([staleAddr]),
    });
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    const tokens = [
      makeToken({ address: staleAddr, network: 'solana' }),
      makeToken({ address: freshAddr, network: 'solana' }),
    ];

    const result = await tracker.applyAntiStaleness(tokens, 3_600_000);

    expect(result[0]?.address).toBe(freshAddr);
    expect(result[1]?.address).toBe(staleAddr);
  });

  it('returns all tokens even if all are stale (graceful degradation)', async () => {
    const addresses = ['stale-1', 'stale-2'];
    const redis = makeRedis({
      zrangebyscore: vi.fn().mockResolvedValue(addresses),
    });
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    const tokens = addresses.map((address) => makeToken({ address, network: 'solana' }));
    const result = await tracker.applyAntiStaleness(tokens, 3_600_000);

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.address)).toEqual(expect.arrayContaining(addresses));
  });

  it('uses the correct Redis key per network', async () => {
    const redis = makeRedis();
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    const tokens = [
      makeToken({ address: 'addr-sol', network: 'solana' }),
      makeToken({ address: 'addr-base', network: 'base' }),
    ];

    await tracker.applyAntiStaleness(tokens, 3_600_000);

    const calledKeys = (redis.zrangebyscore as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(calledKeys).toContain('market-data:discovery:seen:solana');
    expect(calledKeys).toContain('market-data:discovery:seen:base');
  });

  it('calls zrangebyscore with range (now - cooldownMs, now)', async () => {
    const redis = makeRedis();
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);
    const cooldownMs = 3_600_000;

    const before = Date.now();
    await tracker.applyAntiStaleness(
      [makeToken({ address: 'addr-1', network: 'solana' })],
      cooldownMs,
    );
    const after = Date.now();

    const call = (redis.zrangebyscore as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      number,
      number,
    ];
    const [, min, max] = call;
    expect(max).toBeGreaterThanOrEqual(before);
    expect(max).toBeLessThanOrEqual(after);
    expect(min).toBeCloseTo(max - cooldownMs, -2);
  });

  it('does not mark token stale when same address exists on a different network', async () => {
    const sharedAddress = '0xABCD';
    // Only ethereum:0xABCD is in the seen set
    const redis = makeRedis({
      zrangebyscore: vi.fn().mockImplementation((_key: string) => {
        if (_key === 'market-data:discovery:seen:ethereum') {
          return Promise.resolve([sharedAddress]);
        }
        return Promise.resolve([]);
      }),
    });
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    const tokens = [
      makeToken({ address: sharedAddress, network: 'ethereum' }),
      makeToken({ address: sharedAddress, network: 'base' }),
    ];

    const result = await tracker.applyAntiStaleness(tokens, 3_600_000);

    // base token (fresh) should come first, ethereum token (stale) second
    expect(result[0]?.network).toBe('base');
    expect(result[1]?.network).toBe('ethereum');
  });

  it('returns original list unchanged when Redis throws', async () => {
    const redis = makeRedis({
      zrangebyscore: vi.fn().mockRejectedValue(new Error('Redis down')),
    });
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);
    const tokens = [makeToken({ address: 'addr-1', network: 'solana' })];

    const result = await tracker.applyAntiStaleness(tokens, 3_600_000);

    expect(result).toBe(tokens);
  });
});

describe('RedisDiscoverySeenTracker.markSeen', () => {
  it('calls zadd for each token with correct key and score', async () => {
    const redis = makeRedis();
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    const before = Date.now();
    await tracker.markSeen([
      makeToken({ address: 'addr-1', network: 'solana' }),
      makeToken({ address: 'addr-2', network: 'solana' }),
    ]);
    const after = Date.now();

    const zaddMock = redis.zadd as ReturnType<typeof vi.fn>;
    expect(zaddMock).toHaveBeenCalledTimes(2);

    for (const call of zaddMock.mock.calls as [string, number, string][]) {
      const [key, score] = call;
      expect(key).toBe('market-data:discovery:seen:solana');
      expect(score).toBeGreaterThanOrEqual(before);
      expect(score).toBeLessThanOrEqual(after);
    }
  });

  it('calls zremrangebyscore with -inf to (now - ttlMs)', async () => {
    const ttlMs = 86_400_000;
    const redis = makeRedis();
    const tracker = new RedisDiscoverySeenTracker(redis, ttlMs);

    const before = Date.now();
    await tracker.markSeen([makeToken({ address: 'addr-1', network: 'solana' })]);
    const after = Date.now();

    const pruneMock = redis.zremrangebyscore as ReturnType<typeof vi.fn>;
    expect(pruneMock).toHaveBeenCalledTimes(1);

    const call = pruneMock.mock.calls[0] as [string, string, number];
    const [, min, max] = call;
    expect(min).toBe('-inf');
    expect(max).toBeGreaterThanOrEqual(before - ttlMs);
    expect(max).toBeLessThanOrEqual(after - ttlMs);
  });

  it('uses separate keys per network', async () => {
    const redis = makeRedis();
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    await tracker.markSeen([
      makeToken({ address: 'addr-sol', network: 'solana' }),
      makeToken({ address: 'addr-base', network: 'base' }),
    ]);

    const zaddMock = redis.zadd as ReturnType<typeof vi.fn>;
    const calledKeys = zaddMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(calledKeys).toContain('market-data:discovery:seen:solana');
    expect(calledKeys).toContain('market-data:discovery:seen:base');
  });

  it('does not propagate error when Redis throws', async () => {
    const redis = makeRedis({
      zadd: vi.fn().mockRejectedValue(new Error('Redis down')),
    });
    const tracker = new RedisDiscoverySeenTracker(redis, 86_400_000);

    await expect(
      tracker.markSeen([makeToken({ address: 'addr-1', network: 'solana' })]),
    ).resolves.toBeUndefined();
  });
});
