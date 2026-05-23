import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to capacity', () => {
    const rl = new TokenBucketRateLimiter({ capacity: 3, refillRate: 1 });
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('refills tokens over time', () => {
    const rl = new TokenBucketRateLimiter({ capacity: 2, refillRate: 1 });
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);

    // Advance 1 second — should refill 1 token
    vi.advanceTimersByTime(1000);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('never exceeds capacity', () => {
    const rl = new TokenBucketRateLimiter({ capacity: 2, refillRate: 10 });
    // Wait a long time — tokens should cap at capacity
    vi.advanceTimersByTime(10000);
    expect(rl.available).toBeLessThanOrEqual(2);
  });

  it('waitForToken resolves immediately when tokens available', async () => {
    const rl = new TokenBucketRateLimiter({ capacity: 5, refillRate: 1 });
    const waited = await rl.waitForToken();
    expect(waited).toBe(0);
  });

  it('waitForToken waits when no tokens available', async () => {
    const rl = new TokenBucketRateLimiter({ capacity: 1, refillRate: 1 });
    rl.tryConsume(); // exhaust the single token

    const promise = rl.waitForToken();
    // Advance time to allow refill (use async variant to flush microtasks)
    await vi.advanceTimersByTimeAsync(1001);
    const waited = await promise;
    expect(waited).toBeGreaterThan(0);
  });

  it('serializes concurrent waiters — no oversubscription', async () => {
    // capacity=1, refillRate=1 → only 1 token per second
    const rl = new TokenBucketRateLimiter({ capacity: 1, refillRate: 1 });
    rl.tryConsume(); // exhaust

    // 3 concurrent waiters enqueue
    const results: number[] = [];
    const p1 = rl.waitForToken().then((w) => { results.push(1); return w; });
    const p2 = rl.waitForToken().then((w) => { results.push(2); return w; });
    const p3 = rl.waitForToken().then((w) => { results.push(3); return w; });

    // After 1s, only 1 token refilled → only first waiter served
    await vi.advanceTimersByTimeAsync(1001);
    expect(results).toEqual([1]);

    // After another 1s → second waiter served
    await vi.advanceTimersByTimeAsync(1001);
    expect(results).toEqual([1, 2]);

    // After another 1s → third waiter served
    await vi.advanceTimersByTimeAsync(1001);
    expect(results).toEqual([1, 2, 3]);

    await Promise.all([p1, p2, p3]);
  });

  it('waitForToken skips queue when tokens available and queue is empty', async () => {
    const rl = new TokenBucketRateLimiter({ capacity: 5, refillRate: 1 });
    // Should resolve immediately without queueing
    const w1 = await rl.waitForToken();
    const w2 = await rl.waitForToken();
    expect(w1).toBe(0);
    expect(w2).toBe(0);
    expect(rl.available).toBe(3);
  });
});
