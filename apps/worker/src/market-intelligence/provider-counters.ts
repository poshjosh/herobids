/**
 * Provider-level observability counters stored in a Redis hash.
 *
 * Counters are keyed by `provider:requestClass` (e.g. `binance:regime`,
 * `dexscreener:discovery`) so that each request class is tracked separately.
 *
 * For discovery, the coordinator records freshness for both
 * dexscreener:discovery and geckoterminal:discovery using the aggregated
 * discover() result, since those two providers run as a single unit.
 */

import type { Redis } from 'ioredis';

// Use a versioned hash key so existing deployments with the legacy JSON string
// at market-intel:provider-counters do not hit Redis WRONGTYPE errors.
const COUNTERS_KEY = 'market-intel:provider-counters:v2';

export interface ProviderCounterSnapshot {
  success: number;
  failure: number;
  lastSuccessAt: string | null;
  /** Counts of requests resolved from upstream (fresh) vs cache. */
  freshnessModeFresh: number;
  freshnessModeCached: number;
  /** Rate-limit wait events (waited but eventually acquired). */
  rateLimitWaitCount: number;
  /** Rate-limit throttle events (exceeded maxWaitMs, request dropped). */
  rateLimitThrottleCount: number;
}

function counterKey(providerName: string, requestClass: string): string {
  return `${providerName}:${requestClass}`;
}

function counterField(providerName: string, requestClass: string, metric: keyof ProviderCounterSnapshot): string {
  return `${counterKey(providerName, requestClass)}:${metric}`;
}

async function incrementCounter(
  redis: Redis,
  providerName: string,
  requestClass: string,
  metric: Exclude<keyof ProviderCounterSnapshot, 'lastSuccessAt'>,
): Promise<void> {
  await redis.hincrby(COUNTERS_KEY, counterField(providerName, requestClass, metric), 1);
}

export async function recordProviderSuccess(
  redis: Redis,
  providerName: string,
  requestClass: string,
): Promise<void> {
  await redis
    .multi()
    .hincrby(COUNTERS_KEY, counterField(providerName, requestClass, 'success'), 1)
    .hset(COUNTERS_KEY, counterField(providerName, requestClass, 'lastSuccessAt'), new Date().toISOString())
    .exec();
}

export async function recordProviderFailure(
  redis: Redis,
  providerName: string,
  requestClass: string,
): Promise<void> {
  await incrementCounter(redis, providerName, requestClass, 'failure');
}

export async function recordFreshnessMode(
  redis: Redis,
  providerName: string,
  requestClass: string,
  mode: 'fresh' | 'cached',
): Promise<void> {
  if (mode === 'fresh') {
    await incrementCounter(redis, providerName, requestClass, 'freshnessModeFresh');
    return;
  }

  await incrementCounter(redis, providerName, requestClass, 'freshnessModeCached');
}

export async function recordRateLimitWait(
  redis: Redis,
  providerName: string,
  requestClass: string,
): Promise<void> {
  await incrementCounter(redis, providerName, requestClass, 'rateLimitWaitCount');
}

export async function recordRateLimitThrottle(
  redis: Redis,
  providerName: string,
  requestClass: string,
): Promise<void> {
  await incrementCounter(redis, providerName, requestClass, 'rateLimitThrottleCount');
}

/** Returns true when an error message indicates a rate-limit throttle (exceeded maxWaitMs). */
export function isRateLimitThrottle(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Rate limit exceeded');
}
