import type Redis from 'ioredis';

/**
 * Thin adapter that wraps an ioredis client with a snapshot method
 * suitable for the evidence assembler's `redis` context field.
 *
 * The snapshot collects a best-effort view of agent-related Redis keys
 * (agent:*, session:*, decision:*) and returns them as a flat record.
 * Keys are limited to 100 to prevent overload.
 */
export interface RedisSnapshotClient {
  snapshot(): Promise<Record<string, unknown>>;
}

export function createRedisSnapshotClient(redis: Redis): RedisSnapshotClient {
  return {
    snapshot: async () => {
      const patterns = ['agent:*', 'session:*', 'decision:*'];
      const allKeys: string[] = [];

      for (const pattern of patterns) {
        try {
          const keys = await redis.keys(pattern);
          allKeys.push(...keys);
        } catch {
          // Pattern may not match any keys — continue
        }
      }

      // Limit to prevent snapshot overload
      const limited = allKeys.slice(0, 100);
      const result: Record<string, unknown> = {};

      for (const key of limited) {
        try {
          const type = await redis.type(key);
          if (type === 'string') {
            result[key] = await redis.get(key);
          } else if (type === 'hash') {
            result[key] = await redis.hgetall(key);
          } else if (type === 'list') {
            const items = await redis.lrange(key, 0, 19);
            result[key] = items;
          } else if (type === 'set') {
            const members = await redis.smembers(key);
            result[key] = members.slice(0, 50);
          } else {
            result[key] = `[${type}]`;
          }
        } catch {
          // Individual key errors are non-fatal
        }
      }

      return result;
    },
  };
}
