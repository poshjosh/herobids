import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PeerRateLimiter } from '@herobids/domain';

/** The window the limit is counted over: "per minute" (DEC-42). */
export const PEER_RATE_WINDOW_MS = 60_000;

// Sliding window over a sorted set, one entry per allowed message. The clock is the Redis server's TIME, so worker
// instances with skewed clocks share one window. A refused attempt adds nothing, so a flood cannot extend its own block.
const PEER_RATE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowMs = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], windowMs)
return 1
`;

/**
 * Per-user peer message limit (DEC-42): at most `limitPerMinute` allowed messages in any rolling minute, across all of
 * the user's agents. `limitPerMinute` is `agentRuntime.peer.rateLimitPerMinute`; the window is a minute except in tests. Rejects when Redis fails, so the send is refused.
 */
export class RedisPeerRateLimiter implements PeerRateLimiter {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly limitPerMinute: number,
    private readonly windowMs: number = PEER_RATE_WINDOW_MS,
  ) {}

  async tryConsume(userId: string): Promise<boolean> {
    const allowed = await this.redis.eval(
      PEER_RATE_SCRIPT,
      1,
      `ratelimit:peer-message:${userId}`,
      String(this.windowMs),
      String(this.limitPerMinute),
      randomUUID(),
    );
    return allowed === 1;
  }
}
