import type { MarketDataProviderName, ProviderRequestClass, ProviderResult } from './types.js';

export interface CachePolicy {
  ttlMs: number;
  staleWhileRevalidateMs?: number;
}

export interface CacheSnapshot<T> {
  value: T;
  storedAt: number;
  ageMs: number;
  ttlMs: number;
  expiresAt: number;
  isStale: boolean;
}

export interface ProviderResponseCache {
  get<T>(key: string, now?: number): CacheSnapshot<T> | undefined | Promise<CacheSnapshot<T> | undefined>;
  set<T>(key: string, value: T, policy: CachePolicy, now?: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

interface CacheRecord<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
  staleAt: number;
}

export class InMemoryProviderResponseCache implements ProviderResponseCache {
  private readonly entries = new Map<string, CacheRecord<unknown>>();

  get<T>(key: string, now = Date.now()): CacheSnapshot<T> | undefined {
    const entry = this.entries.get(key) as CacheRecord<T> | undefined;
    if (!entry) {
      return undefined;
    }

    if (now > entry.staleAt) {
      this.entries.delete(key);
      return undefined;
    }

    return {
      value: entry.value,
      storedAt: entry.storedAt,
      ageMs: Math.max(0, now - entry.storedAt),
      ttlMs: Math.max(0, entry.expiresAt - entry.storedAt),
      expiresAt: entry.expiresAt,
      isStale: now > entry.expiresAt,
    };
  }

  set<T>(key: string, value: T, policy: CachePolicy, now = Date.now()): void {
    const ttlMs = Math.max(0, policy.ttlMs);
    const staleWhileRevalidateMs = Math.max(0, policy.staleWhileRevalidateMs ?? 0);
    this.entries.set(key, {
      value,
      storedAt: now,
      expiresAt: now + ttlMs,
      staleAt: now + ttlMs + staleWhileRevalidateMs,
    });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

function buildProviderResult<T>(params: {
  provider: MarketDataProviderName;
  requestClass: ProviderRequestClass;
  data: T;
  cacheKey?: string;
  fetchedAt: number;
  ageMs: number;
  ttlMs: number;
  source: 'upstream' | 'cache';
  isStale: boolean;
}): ProviderResult<T> {
  return {
    data: params.data,
    meta: {
      provider: params.provider,
      requestClass: params.requestClass,
      cacheKey: params.cacheKey,
      freshness: {
        source: params.source,
        fetchedAt: new Date(params.fetchedAt).toISOString(),
        ageMs: params.ageMs,
        ttlMs: params.ttlMs,
        isStale: params.isStale,
        expiresAt: new Date(params.fetchedAt + params.ttlMs).toISOString(),
      },
    },
  };
}

export async function loadWithCache<T>(params: {
  provider: MarketDataProviderName;
  requestClass: ProviderRequestClass;
  cache: ProviderResponseCache;
  cacheKey: string;
  policy: CachePolicy;
  loader: () => Promise<T>;
  allowStale?: boolean;
  now?: number;
}): Promise<ProviderResult<T>> {
  const now = params.now ?? Date.now();
  const cached = params.policy.ttlMs > 0 ? await params.cache.get<T>(params.cacheKey, now) : undefined;

  // Fresh cache hit — return immediately without calling the loader.
  if (cached && !cached.isStale) {
    return buildProviderResult({
      provider: params.provider,
      requestClass: params.requestClass,
      data: cached.value,
      cacheKey: params.cacheKey,
      fetchedAt: cached.storedAt,
      ageMs: cached.ageMs,
      ttlMs: cached.ttlMs,
      source: 'cache',
      isStale: false,
    });
  }

  // Stale hit within the revalidate window: attempt a refresh and update the cache.
  // Fall back to the stale data only if the upstream call fails.
  if (cached && cached.isStale && params.allowStale) {
    try {
      const data = await params.loader();
      if (params.policy.ttlMs > 0) {
        await params.cache.set(params.cacheKey, data, params.policy, now);
      }
      return buildProviderResult({
        provider: params.provider,
        requestClass: params.requestClass,
        data,
        cacheKey: params.cacheKey,
        fetchedAt: now,
        ageMs: 0,
        ttlMs: params.policy.ttlMs,
        source: 'upstream',
        isStale: false,
      });
    } catch {
      // Upstream unavailable — serve stale data as a degraded fallback.
      return buildProviderResult({
        provider: params.provider,
        requestClass: params.requestClass,
        data: cached.value,
        cacheKey: params.cacheKey,
        fetchedAt: cached.storedAt,
        ageMs: cached.ageMs,
        ttlMs: cached.ttlMs,
        source: 'cache',
        isStale: true,
      });
    }
  }

  // No usable cache entry — must fetch unconditionally.
  const data = await params.loader();
  if (params.policy.ttlMs > 0) {
    await params.cache.set(params.cacheKey, data, params.policy, now);
  }

  return buildProviderResult({
    provider: params.provider,
    requestClass: params.requestClass,
    data,
    cacheKey: params.cacheKey,
    fetchedAt: now,
    ageMs: 0,
    ttlMs: params.policy.ttlMs,
    source: 'upstream',
    isStale: false,
  });
}