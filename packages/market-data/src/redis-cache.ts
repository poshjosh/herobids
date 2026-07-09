import type { ProviderResponseCache, CachePolicy, CacheSnapshot } from './cache.js';

/**
 * Minimal Redis client interface needed for provider-response caching.
 * Compatible with ioredis — only the commands we actually use.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, expiryMode: 'PX' | 'EX', time: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

interface CacheRecord<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
  staleAt: number;
}

/**
 * Redis-backed implementation of ProviderResponseCache.
 *
 * Stores serialized CacheRecord<T> values as JSON strings.
 * Shared across agent runtimes via Redis.
 *
 * Redis failures are treated as cache misses (get) or silent skips (set/delete) — never throws.
 */
export class RedisProviderResponseCache implements ProviderResponseCache {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisCacheClient,
    prefix = 'market-data:cache:',
  ) {
    this.prefix = prefix;
  }

  async get<T>(key: string, now?: number): Promise<CacheSnapshot<T> | undefined> {
    const nowMs = now ?? Date.now();
    try {
      const raw = await this.redis.get(this.prefix + key);
      if (!raw) return undefined;

      const record = JSON.parse(raw) as CacheRecord<T>;

      // Check if fully expired (beyond stale window)
      if (nowMs > record.staleAt) {
        // Best-effort cleanup
        this.redis.del(this.prefix + key).catch(() => {});
        return undefined;
      }

      return {
        value: record.value,
        storedAt: record.storedAt,
        ageMs: Math.max(0, nowMs - record.storedAt),
        ttlMs: Math.max(0, record.expiresAt - record.storedAt),
        expiresAt: record.expiresAt,
        isStale: nowMs > record.expiresAt,
      };
    } catch {
      // Redis unavailable — treat as cache miss
      return undefined;
    }
  }

  async set<T>(key: string, value: T, policy: CachePolicy, now?: number): Promise<void> {
    const nowMs = now ?? Date.now();
    const ttlMs = Math.max(0, policy.ttlMs);
    const staleWhileRevalidateMs = Math.max(0, policy.staleWhileRevalidateMs ?? 0);

    const record: CacheRecord<T> = {
      value,
      storedAt: nowMs,
      expiresAt: nowMs + ttlMs,
      staleAt: nowMs + ttlMs + staleWhileRevalidateMs,
    };

    // Redis TTL = full stale window so Redis auto-evicts when the record is truly dead
    const redisTtlMs = ttlMs + staleWhileRevalidateMs;

    try {
      if (redisTtlMs > 0) {
        await this.redis.set(this.prefix + key, JSON.stringify(record), 'PX', redisTtlMs);
      } else {
        await this.redis.set(this.prefix + key, JSON.stringify(record));
      }
    } catch {
      // Redis unavailable — silently skip cache write
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(this.prefix + key);
    } catch {
      // Redis unavailable — silently skip
    }
  }
}
