import type { DiscoveredToken } from './types.js';

export interface DiscoverySeenClient {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
}

export interface DiscoverySeenTracker {
  applyAntiStaleness(tokens: DiscoveredToken[], cooldownMs: number): Promise<DiscoveredToken[]>;
  markSeen(tokens: DiscoveredToken[]): Promise<void>;
}

export class NoopDiscoverySeenTracker implements DiscoverySeenTracker {
  async applyAntiStaleness(tokens: DiscoveredToken[]): Promise<DiscoveredToken[]> {
    return tokens;
  }
  async markSeen(): Promise<void> {}
}

export class RedisDiscoverySeenTracker implements DiscoverySeenTracker {
  constructor(
    private readonly redis: DiscoverySeenClient,
    private readonly ttlMs: number,
  ) {}

  async applyAntiStaleness(tokens: DiscoveredToken[], cooldownMs: number): Promise<DiscoveredToken[]> {
    try {
      // Group tokens by network
      const networkGroups = new Map<string, DiscoveredToken[]>();
      for (const token of tokens) {
        const group = networkGroups.get(token.network) ?? [];
        group.push(token);
        networkGroups.set(token.network, group);
      }

      // For each network, fetch recently-seen addresses
      const staleKeys = new Set<string>();
      const now = Date.now();
      await Promise.all(
        Array.from(networkGroups.keys()).map(async (network) => {
          const key = `market-data:discovery:seen:${network}`;
          const seen = await this.redis.zrangebyscore(key, now - cooldownMs, now);
          for (const address of seen) {
            staleKeys.add(`${network}:${address}`);
          }
        }),
      );

      // Partition into fresh and stale
      const fresh = tokens.filter((t) => !staleKeys.has(`${t.network}:${t.address}`));
      const stale = tokens.filter((t) => staleKeys.has(`${t.network}:${t.address}`));
      return [...fresh, ...stale];
    } catch (err) {
      // Fail-soft: Redis unavailable → return original list unchanged
      console.warn('[DiscoverySeenTracker] applyAntiStaleness failed, skipping:', err);
      return tokens;
    }
  }

  async markSeen(tokens: DiscoveredToken[]): Promise<void> {
    try {
      const now = Date.now();
      const networkGroups = new Map<string, DiscoveredToken[]>();
      for (const token of tokens) {
        const group = networkGroups.get(token.network) ?? [];
        group.push(token);
        networkGroups.set(token.network, group);
      }

      await Promise.all(
        Array.from(networkGroups.entries()).map(async ([network, networkTokens]) => {
          const key = `market-data:discovery:seen:${network}`;
          await Promise.all(networkTokens.map((t) => this.redis.zadd(key, now, t.address)));
          // Prune entries older than TTL
          await this.redis.zremrangebyscore(key, '-inf', now - this.ttlMs);
        }),
      );
    } catch (err) {
      // Fail-soft: Redis unavailable → skip marking
      console.warn('[DiscoverySeenTracker] markSeen failed, skipping:', err);
    }
  }
}
