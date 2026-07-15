# Plan: Background Economic Calendar Refresh (Decouple from Agent Tick Loop)

**Status:** Proposed — not yet implemented
**Date:** 2026-07-15
**Depends on:** `001-plan.md` (Scrapfly proxy for Forex Factory)

---

## Problem

The economic calendar fetch (`getUpcomingEvents()`) is `await`ed directly inside
the agent's tick loop (`apps/worker/src/agent.ts:2680`), blocking the tick for
up to `forexFactory.requestTimeoutMs` (60–120s) on a cache miss. The original
plan acknowledged this:

> *"a slow Scrapfly call delays that tick by however long it takes. This only
> happens for the one tick, across all agents, that finds the shared Redis
> cache stale (cache TTL 3h) — so it's an infrequent, bounded, already
> try/catch-guarded cost."*

But even "infrequent" blocking for 60+ seconds is unacceptable for a trading
agent. A tick that stalls for a minute misses market movements, delays
decision-making, and degrades the agent's real-time responsiveness.

## Solution

Move the fetch **out of the agent tick loop** and into a **background interval
in the worker process**. The worker periodically refreshes the shared Redis
cache. Agent ticks only do a fast (sub-millisecond) cache read — they never
block on a network call for economic calendar data.

```
Before (problematic):
  agent tick → await Scrapfly fetch (up to 120s!) → continue tick

After:
  worker background interval → Scrapfly fetch → write Redis cache
  agent tick → Redis cache read (< 1ms) → continue tick
```

The `CompositeEconomicCalendarProvider` already has cache-first logic — we
extend it with a `cacheOnly` mode that skips the fetch-from-source fallback.

## Design

### Config: `marketData.economicCalendar.refreshIntervalMs`

New field controlling how often the worker background interval re-fetches:

```yaml
# config/default.yaml
economicCalendar:
  refreshIntervalMs: 21600000  # 6 hours (default: half of cacheTtlMs)
```

| Field | Default | Rationale |
|-------|---------|-----------|
| `refreshIntervalMs` | `cacheTtlMs / 2` (6h) | Refresh well before cache expiry. Operator can tighten for faster turnaround on calendar changes. |

Schema (`packages/domain/src/config/schema.ts`):

```typescript
economicCalendar: z.object({
  // ...existing fields...
  refreshIntervalMs: z.number().int().min(60_000).default(21_600_000),
}).default({}),
```

Minimum 1 minute to prevent accidental hammering of Scrapfly.

### `CompositeEconomicCalendarProvider`: add `cacheOnly` option

A single boolean option on the existing `getUpcomingEvents()`:

```typescript
async getUpcomingEvents(options?: {
  // ...existing options...
  cacheOnly?: boolean;   // if true: never fetch from source on cache miss
}): Promise<Result<EconomicCalendarResult, EconomicCalendarError>>
```

When `cacheOnly: true` and cache is empty/stale:
- Return `ok({ events: [], fetchedAt: null, sources: [] })` — graceful empty
- Do NOT call the Scrapfly adapter

When `cacheOnly: false` (default, backward-compatible):
- Existing behavior: check cache → fetch from source on miss → write cache

### Worker background refresh (`apps/worker/src/index.ts`)

New `setInterval` block, following the existing patterns for health refresh
and LLM pricing refresh:

```typescript
// ── Economic calendar background refresh ─────────────────────────────────
const ecConfig = appConfig.marketData?.economicCalendar;
let economicCalendarRefreshInterval: ReturnType<typeof setInterval> | undefined;

if (ecConfig?.enabled && SCRAPFLY_API_KEY) {
  const ecProvider = new CompositeEconomicCalendarProvider({
    daysForward: ecConfig.daysForward,
    minImpact: ecConfig.minImpact,
    currencies: ecConfig.currencies,
    maxEvents: ecConfig.maxEventsInContext,
    forexFactory: {
      baseUrl: ecConfig.forexFactory.baseUrl,
      requestTimeoutMs: ecConfig.forexFactory.requestTimeoutMs,
      requestsPerMinute: ecConfig.forexFactory.requestsPerMinute,
      userAgent: ecConfig.forexFactory.userAgent,
      rateLimiter: new TokenBucketRateLimiter({
        requestsPerMinute: ecConfig.forexFactory.requestsPerMinute,
      }),
      fetchFn: createScrapflyFetch({
        apiKey: SCRAPFLY_API_KEY,
        baseUrl: appConfig.marketData.scrapfly.baseUrl,
        asp: appConfig.marketData.scrapfly.asp,
        requestTimeoutMs: appConfig.marketData.scrapfly.requestTimeoutMs,
      }),
      parseHtmlFn: createLlmCalendarParser(),  // reuse from agent.ts or extract
    },
    cache: new RedisProviderResponseCache(redisClient, 'market-data:cache:'),
    cacheTtlMs: ecConfig.cacheTtlMs,
  });

  // Initial fetch on startup — warm the cache before any agent starts.
  ecProvider.getUpcomingEvents().then((result) => {
    if (result.ok) {
      logger.info({ eventCount: result.data.events.length }, 'Economic calendar initial cache warmed');
    } else {
      logger.warn({ error: result.error }, 'Economic calendar initial fetch failed');
    }
  }).catch((err) => {
    logger.error({ err }, 'Economic calendar initial fetch threw');
  });

  // Periodic refresh.
  economicCalendarRefreshInterval = setInterval(() => {
    ecProvider.getUpcomingEvents().then((result) => {
      if (result.ok) {
        logger.info({ eventCount: result.data.events.length }, 'Economic calendar cache refreshed');
      } else {
        logger.warn({ error: result.error }, 'Economic calendar refresh failed');
      }
    }).catch((err) => {
      logger.error({ err }, 'Economic calendar refresh threw');
    });
  }, ecConfig.refreshIntervalMs);
}
```

On shutdown, clear the interval alongside the other intervals.

### Agent tick loop (`apps/worker/src/agent.ts`): switch to cache-only

Change the single call site:

```typescript
// Before (blocking):
const result = await economicCalendarProvider.getUpcomingEvents();

// After (non-blocking, cache-only):
const result = await economicCalendarProvider.getUpcomingEvents({ cacheOnly: true });
```

Everything else stays the same — the `result.ok` / `result.error` branching,
the `macroEvents` assignment, the logging. The only difference is that a cache
miss returns empty events instead of triggering a network fetch.

**Note:** The agent container still constructs its own `economicCalendarProvider`
instance (with its own rate limiter and fetch function) because the agent runs
in a separate Docker container. The provider is used **only for cache reads** —
the `cacheOnly` flag ensures it never attempts a source fetch. The actual
fetch-and-write is done exclusively by the worker process.

### LLM parser extraction

The `createLlmCalendarParser()` function currently lives in `agent.ts`. It
needs to be available to the worker's `index.ts` for the background refresh.
Options:

| Approach | Pros | Cons |
|----------|------|------|
| **A. Move to `@herobids/market-data`** | Clean separation, reusable | Touches an extra package |
| **B. Extract to shared worker module** | Minimal package changes | `agent.ts` would import from a sibling |
| **C. Duplicate (temporary)** | Zero refactor risk | DRY violation |

**Decision: Option A** — move `createLlmCalendarParser()` to
`packages/market-data/src/economic-calendar.ts` and export it. The agent
container already depends on `@herobids/market-data`, and the worker does
too. This is the right home for a market-data parsing function.

## Implementation Steps

1. **[PENDING] Config schema:** add `refreshIntervalMs` to `economicCalendar` in `packages/domain/src/config/schema.ts`.
2. **[PENDING] Default config:** add `refreshIntervalMs: 21600000` (6h) to `config/default.yaml`.
3. **[PENDING] Extract LLM parser:** move `createLlmCalendarParser()` from `apps/worker/src/agent.ts` to `packages/market-data/src/economic-calendar.ts`; export it; update `agent.ts` import.
4. **[PENDING] `cacheOnly` option:** add `cacheOnly?: boolean` to `CompositeEconomicCalendarProvider.getUpcomingEvents()` options; implement skip-source-on-miss logic; add unit tests.
5. **[PENDING] Worker background refresh:** add `setInterval` block in `apps/worker/src/index.ts` for economic calendar refresh; add initial fetch on startup; add `clearInterval` in shutdown handler.
6. **[PENDING] Agent tick switch:** change `apps/worker/src/agent.ts` to call `getUpcomingEvents({ cacheOnly: true })`.
7. **[PENDING] Agent container cleanup:** remove the rate limiter and fetch function from the agent's `forexFactoryConfig` since they're no longer used (the agent only reads cache). Keep the adapter instantiation minimal.
8. **[PENDING] Tests:** run `pnpm --filter @herobids/market-data run test`, `pnpm --filter @herobids/worker run test`, `pnpm lint`, `pnpm build`.
9. **[PENDING] Local verification:** start an agent via local dev docker compose, confirm "Economic calendar cache warmed" in worker logs and "Economic calendar fetched" in agent logs with sub-second elapsed time.
10. **[PENDING] Changelog:** add entry.

## Non-Goals

- Extracting the entire economic calendar provider setup from `agent.ts` (the agent still needs a lightweight provider instance for cache reads).
- Moving other market-data fetches (DexScreener, Birdeye, etc.) to background refresh — each has different cache semantics.
- Retry logic for background refresh failures — the existing `catch` + log pattern is sufficient; the next interval will retry naturally.

## Testing Plan

- **Unit:** `economic-calendar.test.ts` — new cases for `cacheOnly: true` (empty cache → empty events, stale cache → stale events served, fresh cache → fresh events served).
- **Unit:** `economic-calendar.test.ts` — verify `cacheOnly: false` (default) behavior unchanged.
- **Integration:** Manual — start local dev, check worker logs for initial cache warm, check agent logs for sub-second fetch.
- **Existing tests:** should all continue to pass (no behavioral change for `cacheOnly: false`, which is the default).

## Open Risks

- **LLM parser cost:** The background refresh calls the LLM parser on every interval (default: every 6h). At current rates this is negligible, but if the interval is tightened to minutes, LLM costs could add up. Mitigated by the `min(60_000)` floor on `refreshIntervalMs`.
- **Worker restarts:** On worker restart, the initial fetch runs again immediately. If multiple workers restart in quick succession (e.g., deploy roll), each will make an independent Scrapfly call. The rate limiter (1 req/min) will serialize them. Acceptable for infrequent deploys.
- **Cache staleness window:** If the background refresh fails for a full `cacheTtlMs` period (12h), the agent will serve stale data via `cacheOnly` (existing behavior) until the cache actually expires, at which point it returns empty events. This is a graceful degradation — no worse than the current "block omitted for this tick" behavior.

## Rollback

If the background refresh causes issues:
1. Revert `agent.ts` to call `getUpcomingEvents()` without `cacheOnly` (restore blocking behavior).
2. The worker interval is independent — its failure doesn't affect agents.

No data migration needed — the Redis cache key format is unchanged.
