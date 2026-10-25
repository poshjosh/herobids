import { describe, expect, it, vi } from 'vitest';
import { PEER_RATE_WINDOW_MS, RedisPeerRateLimiter } from './peer-rate-limiter.js';

describe('RedisPeerRateLimiter', () => {
  it('passes the per-user key, the one-minute window and the configured limit to the script', async () => {
    const evalScript = vi.fn(async () => 1);

    const allowed = await new RedisPeerRateLimiter({ eval: evalScript } as never, 7).tryConsume('user-1');

    expect(allowed).toBe(true);
    const args = evalScript.mock.calls[0] as unknown as unknown[];
    expect(args.slice(1, 5)).toEqual([1, 'ratelimit:peer-message:user-1', String(PEER_RATE_WINDOW_MS), '7']);
    expect(PEER_RATE_WINDOW_MS).toBe(60_000);
  });

  it('is false when the script refuses', async () => {
    expect(await new RedisPeerRateLimiter({ eval: vi.fn(async () => 0) } as never, 7).tryConsume('user-1')).toBe(false);
  });

  it('lets a Redis failure reach the caller so the send is refused', async () => {
    const limiter = new RedisPeerRateLimiter({ eval: vi.fn(async () => { throw new Error('redis down'); }) } as never, 7);

    await expect(limiter.tryConsume('user-1')).rejects.toThrow('redis down');
  });
});
