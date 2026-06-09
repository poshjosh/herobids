import { describe, it, expect, vi } from 'vitest';
import {
  CoordinatedRateLimiter,
  InMemoryRateBudgetCoordinator,
  RedisRateBudgetCoordinator,
  TokenBucketRateLimiter,
  createSharedRateBudgetCoordinator,
  type RateBudgetClock,
  type RedisEvalClient,
} from './rate-limiter.js';

function createManualClock(): RateBudgetClock & { advance(ms: number): void } {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TokenBucketRateLimiter', () => {
  it('allows requests within capacity', async () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 60, burstCapacity: 5 });
    // Should allow 5 immediate requests
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
  });

  it('throws when maxWaitMs would be exceeded', async () => {
    const limiter = new TokenBucketRateLimiter({
      requestsPerMinute: 1, // 1 per minute
      burstCapacity: 1,
      maxWaitMs: 100, // only willing to wait 100ms
    });

    // First request consumes the only token
    await limiter.acquire();

    // Second request would need to wait ~60s, which exceeds maxWaitMs
    await expect(limiter.acquire()).rejects.toThrow('Rate limit exceeded');
  });

  it('refills tokens over time', async () => {
    const limiter = new TokenBucketRateLimiter({
      requestsPerMinute: 6000, // 100/sec
      burstCapacity: 2,
    });

    // Consume burst
    await limiter.acquire();
    await limiter.acquire();

    // Wait 25ms — should refill ~2.5 tokens at 100/sec
    await new Promise((r) => setTimeout(r, 25));

    // Should succeed (refilled)
    await limiter.acquire();
  });

  it('defaults burstCapacity to requestsPerMinute', () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerMinute: 30 });
    // Should be able to burst 30 requests immediately
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      promises.push(limiter.acquire());
    }
    return Promise.all(promises);
  });
});

describe('InMemoryRateBudgetCoordinator', () => {
  it('shares quota across multiple coordinated limiters', async () => {
    const clock = createManualClock();
    const coordinator = new InMemoryRateBudgetCoordinator(clock);
    const budget = { requestsPerMinute: 10, burstCapacity: 2, maxWaitMs: 0 };
    const limiterA = new CoordinatedRateLimiter(coordinator, {
      provider: 'shared-provider',
      requestClass: 'discovery',
      budget,
    });
    const limiterB = new CoordinatedRateLimiter(coordinator, {
      provider: 'shared-provider',
      requestClass: 'discovery',
      budget,
    });

    await limiterA.acquire();
    await limiterB.acquire();

    await expect(limiterA.acquire()).rejects.toThrow('Rate limit exceeded');
  });

  it('prevents discovery from consuming reserved higher-priority capacity', async () => {
    const clock = createManualClock();
    const coordinator = new InMemoryRateBudgetCoordinator(clock);
    const budget = {
      requestsPerMinute: 60,
      burstCapacity: 4,
      maxWaitMs: 0,
      classReservations: { 'price-support': 2 } as const,
    };
    const discoveryLimiter = new CoordinatedRateLimiter(coordinator, {
      provider: 'dexscreener',
      requestClass: 'discovery',
      budget,
    });
    const priceSupportLimiter = new CoordinatedRateLimiter(coordinator, {
      provider: 'dexscreener',
      requestClass: 'price-support',
      budget,
    });

    await discoveryLimiter.acquire();
    await discoveryLimiter.acquire();
    await expect(discoveryLimiter.acquire()).rejects.toThrow('Rate limit exceeded');

    await expect(priceSupportLimiter.acquire()).resolves.toBeUndefined();
  });

  it('waits and retries when budget refills within maxWaitMs', async () => {
    const clock = createManualClock();
    const coordinator = new InMemoryRateBudgetCoordinator(clock);
    // 60 rpm = 1/sec = 1ms to refill 1/1000th of a token; use high rpm so wait is short
    const budget = { requestsPerMinute: 60_000, burstCapacity: 1, maxWaitMs: 5 };
    const limiter = new CoordinatedRateLimiter(coordinator, {
      provider: 'fast-provider',
      requestClass: 'discovery',
      budget,
    });

    await limiter.acquire(); // consumes the 1 burst token

    // This should wait 1ms (60,000 rpm = 1000/sec = 1ms per token) and then succeed
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('execution-critical class has no protected tokens so always gets through on full bucket', async () => {
    const clock = createManualClock();
    const coordinator = new InMemoryRateBudgetCoordinator(clock);
    const budget = {
      requestsPerMinute: 60,
      burstCapacity: 5,
      maxWaitMs: 0,
      classReservations: { 'price-support': 2, regime: 1 } as const,
    };
    const criticalLimiter = new CoordinatedRateLimiter(coordinator, {
      provider: 'hyperliquid',
      requestClass: 'execution-critical',
      budget,
    });

    // execution-critical has no higher-priority classes protecting tokens above it,
    // so 5 burst tokens → 5 successful requests (1 token each, no protection overhead)
    for (let i = 0; i < 5; i++) {
      await expect(criticalLimiter.acquire()).resolves.toBeUndefined();
    }
  });

  it('enrichment class is blocked when reserved tokens exceed available capacity', async () => {
    const clock = createManualClock();
    const coordinator = new InMemoryRateBudgetCoordinator(clock);
    // burstCapacity=3, but price-support=2 + regime=2 = 4 protected tokens for enrichment
    const budget = {
      requestsPerMinute: 60,
      burstCapacity: 3,
      maxWaitMs: 0,
      classReservations: { 'price-support': 2, regime: 2 } as const,
    };
    const enrichmentLimiter = new CoordinatedRateLimiter(coordinator, {
      provider: 'geckoterminal',
      requestClass: 'enrichment',
      budget,
    });

    // enrichment needs 1 + 4 protected = 5 tokens, but capacity is only 3 → impossible
    await expect(enrichmentLimiter.acquire()).rejects.toThrow('Rate limit exceeded');
  });
});

describe('RedisRateBudgetCoordinator', () => {
  function makeRedisClient(results: unknown[]): RedisEvalClient {
    let callIndex = 0;
    return {
      eval: vi.fn().mockImplementation(() => {
        const result = results[callIndex++] ?? [0, 60_000, 0];
        return Promise.resolve(result);
      }),
    };
  }

  it('acquires successfully when Redis script returns acquired=1', async () => {
    const clock = createManualClock();
    const redis = makeRedisClient([[1, 0, 9]]); // acquired, waitMs=0, remaining=9
    const coordinator = new RedisRateBudgetCoordinator(redis, clock);

    const lease = await coordinator.acquire({
      provider: 'dexscreener',
      requestClass: 'discovery',
      budget: { requestsPerMinute: 60, burstCapacity: 10 },
    });

    expect(lease.remainingTokens).toBe(9);
    expect(lease.waitMs).toBe(0);
  });

  it('retries after waiting when Redis script returns acquired=0 then 1', async () => {
    const clock = createManualClock();
    // First call: not acquired, waitMs=100; second call: acquired
    const redis = makeRedisClient([[0, 100, 5], [1, 0, 4]]);
    const coordinator = new RedisRateBudgetCoordinator(redis, clock);

    const lease = await coordinator.acquire({
      provider: 'dexscreener',
      requestClass: 'discovery',
      budget: { requestsPerMinute: 60, burstCapacity: 10, maxWaitMs: 1_000 },
    });

    expect(lease.remainingTokens).toBe(4);
  });

  it('throws when Redis signals wait would exceed maxWaitMs', async () => {
    const clock = createManualClock();
    const redis = makeRedisClient([[0, 60_000, 0]]); // wait 60s > maxWaitMs
    const coordinator = new RedisRateBudgetCoordinator(redis, clock);

    await expect(
      coordinator.acquire({
        provider: 'dexscreener',
        requestClass: 'discovery',
        budget: { requestsPerMinute: 1, burstCapacity: 1, maxWaitMs: 5_000 },
      }),
    ).rejects.toThrow('Rate limit exceeded');
  });

  it('throws immediately when requiredTokens exceed capacity (impossible request)', async () => {
    const clock = createManualClock();
    const redis = makeRedisClient([]); // should not be called
    const coordinator = new RedisRateBudgetCoordinator(redis, clock);

    await expect(
      coordinator.acquire({
        provider: 'geckoterminal',
        requestClass: 'enrichment',
        // burstCapacity=2, but enrichment needs 1 + price-support(2) + regime(1) = 4 protected
        budget: {
          requestsPerMinute: 60,
          burstCapacity: 2,
          classReservations: { 'price-support': 2, regime: 1 } as const,
        },
      }),
    ).rejects.toThrow('Rate limit exceeded');
  });
});

describe('createSharedRateBudgetCoordinator', () => {
  it('returns InMemoryRateBudgetCoordinator when no Redis client is provided', async () => {
    const coordinator = createSharedRateBudgetCoordinator();
    // Should work — InMemory coordinator
    const lease = await coordinator.acquire({
      provider: 'test',
      requestClass: 'discovery',
      budget: { requestsPerMinute: 60, burstCapacity: 5 },
    });
    expect(lease.remainingTokens).toBeGreaterThanOrEqual(0);
  });

  it('returns RedisRateBudgetCoordinator when Redis client is provided', async () => {
    const redis: RedisEvalClient = {
      eval: vi.fn().mockResolvedValue([1, 0, 9]),
    };
    const coordinator = createSharedRateBudgetCoordinator({ redisClient: redis });
    const lease = await coordinator.acquire({
      provider: 'test',
      requestClass: 'discovery',
      budget: { requestsPerMinute: 60, burstCapacity: 10 },
    });
    expect(lease.remainingTokens).toBe(9);
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it('uses provided clock for InMemory coordinator', async () => {
    const clock = createManualClock();
    const coordinator = createSharedRateBudgetCoordinator({ clock });

    // Drain burst
    const budget = { requestsPerMinute: 60, burstCapacity: 1, maxWaitMs: 0 };
    await coordinator.acquire({ provider: 'test', requestClass: 'discovery', budget });

    // Advance clock so token refills
    clock.advance(1_100); // 1.1 sec > 1 token at 60/min

    // Should succeed after refill
    await expect(
      coordinator.acquire({ provider: 'test', requestClass: 'discovery', budget: { ...budget, maxWaitMs: 5 } }),
    ).resolves.toBeDefined();
  });
});
