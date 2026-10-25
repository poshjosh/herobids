import type { Redis } from 'ioredis';
import { ok, err, type Result } from '@herobids/domain';

// Atomic token bucket. Capacity and refill are per minute. The refill clock is the Redis server's
// TIME, so API instances with skewed clocks share one bucket.
const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2]) / 60000
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updatedAt = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  updatedAt = now
end
tokens = math.min(capacity, tokens + math.max(0, now - updatedAt) * refillPerMs)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updatedAt', tostring(now))
if refillPerMs > 0 then
  redis.call('PEXPIRE', KEYS[1], math.ceil((capacity - tokens) / refillPerMs) + 60000)
end
return allowed
`;

export interface TokenBucketSpec {
  key: string;
  capacity: number;
  refillPerMinute: number;
}

/** Takes only the `eval` the bucket uses, so tests can pass a fake without a Redis connection. */
export async function consumeTokenBucketToken(redis: Pick<Redis, 'eval'>, spec: TokenBucketSpec): Promise<Result<boolean, string>> {
  try {
    const allowed = await redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      spec.key,
      String(spec.capacity),
      String(spec.refillPerMinute),
    );
    return ok(allowed === 1);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}
