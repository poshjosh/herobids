import { describe, it, expect } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limiter.js';

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
