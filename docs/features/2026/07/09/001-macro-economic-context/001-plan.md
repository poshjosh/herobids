# Macro-Economic Context Block

**Created:** 2026-07-08
**Status:** Done
**Depends on:** none

## Problem

Trading agents have no awareness of upcoming high-impact economic events (FOMC, NFP, CPI, etc.). These red-folder events cause sharp volatility in crypto markets. Agents trading through them blindly are exposed to unnecessary risk.

Today, an agent could theoretically use `search_web` or `browse_url` to check an economic calendar, but this costs an extra LLM round-trip per check and produces inconsistent, hard-to-parse results.

## Goal

Inject a compact, structured summary of upcoming high-impact economic events into trading agents' context with zero tool calls and zero extra LLM round-trips, delivered through the existing incremental context diff pipeline.

Phase 1 must ship with both:

- a Forex Factory adapter
- an OHLC.dev adapter

Forex Factory is not optional in this phase. We do not need backward compatibility with the earlier single-provider shape.

## Non-Goals

- A `macro-awareness` skill definition
- A `get_economic_calendar` tool
- Inter-agent broadcast or newsletter publishing
- Sentiment analysis of economic events
- Historical macro trend context (FRED, time-series overlays, etc.)

## Design

### Data Volume

A 48-hour window of medium/high-impact events is typically ~500-2,000 characters (~125-500 tokens). That is small enough for per-tick inclusion when the block is stable.

To preserve context-diff efficiency, the rendered prompt block must exclude volatile metadata such as `fetchedAt`. Otherwise the diff text changes on every refresh even when the event set is unchanged.

### Architecture

```text
┌────────────────────┐    ┌───────────────────────────────┐
│ Forex Factory HTML │───▶│ ForexFactoryCalendarAdapter   │
└────────────────────┘    └──────────────┬────────────────┘
                                         │
┌────────────────────┐    ┌──────────────▼────────────────┐
│ OHLC.dev JSON API  │───▶│ OhlcDevCalendarAdapter        │
└────────────────────┘    └──────────────┬────────────────┘
                                         │
                                         ▼
                           ┌───────────────────────────────┐
                           │ CompositeEconomicCalendar     │
                           │ - fetch both sources          │
                           │ - normalize                   │
                           │ - merge/dedupe                │
                           │ - prefer FF on conflicts      │
                           └──────────────┬────────────────┘
                                          │
                                          ▼
                           ┌───────────────────────────────┐
                           │ RedisProviderResponseCache    │
                           │ shared across agent runtimes  │
                           └──────────────┬────────────────┘
                                          │
                                          ▼
                           ┌───────────────────────────────┐
                           │ Agent runtime tick loop       │
                           │ apps/worker/src/agent.ts      │
                           │ populate metrics.macroEvents  │
                           └──────────────┬────────────────┘
                                          │
                                          ▼
                           ┌───────────────────────────────┐
                           │ buildTickUserContext()        │
                           │ runtime-composition.ts        │
                           └──────────────┬────────────────┘
                                          │
                                          ▼
                           ┌───────────────────────────────┐
                           │ LLM prompt dynamic block      │
                           │ "Upcoming Economic Events"   │
                           └───────────────────────────────┘
```

### Port Interface

```typescript
// packages/domain/src/ports/economic-calendar.ts

export interface EconomicEvent {
  /** ISO-8601 datetime string (UTC) */
  time: string;
  /** Currency code (USD, EUR, GBP, etc.) */
  currency: string;
  /** Event name */
  event: string;
  /** Impact level */
  impact: 'high' | 'medium' | 'low';
  /** Forecast value (null if none) */
  forecast: string | null;
  /** Previous value (null if none) */
  previous: string | null;
  /** Source ids that contributed to this normalized event */
  sources: string[];
}

export interface EconomicCalendarResult {
  events: EconomicEvent[];
  /** ISO-8601 datetime when the merged result was produced */
  fetchedAt: string;
  /** Source identifiers used to produce this merged result */
  sources: string[];
}

export interface EconomicCalendarError extends DomainError {
  code: string;
}

export interface EconomicCalendarProvider {
  getUpcomingEvents(options?: {
    daysForward?: number;
    currencies?: string[];
    minImpact?: 'high' | 'medium' | 'low';
    maxEvents?: number;
  }): Promise<Result<EconomicCalendarResult, EconomicCalendarError>>;
}
```

### Config Schema

Do not add a new top-level `economicCalendar` root config. The agent runtime already receives `MARKET_DATA_CONFIG_JSON`, so this feature should live under `marketData` and reuse that payload path.

```typescript
// Added under MarketDataConfigSchema in packages/domain/src/config/schema.ts

economicCalendar: z.object({
  enabled: z.boolean().default(false),
  daysForward: z.number().int().min(1).max(14).default(2),
  minImpact: z.enum(['high', 'medium', 'low']).default('medium'),
  currencies: z.array(z.string()).default([]),
  cacheTtlMs: z.number().int().min(0).default(3_600_000),
  maxEventsInContext: z.number().int().min(1).max(50).default(20),
  dedupeWindowMinutes: z.number().int().min(0).max(180).default(30),
  sourceOrder: z.array(z.enum(['forex-factory', 'ohlc-dev']))
    .min(2)
    .default(['forex-factory', 'ohlc-dev']),
  forexFactory: z.object({
    baseUrl: z.string().url().default('https://www.forexfactory.com'),
    requestTimeoutMs: z.number().int().min(1_000).default(10_000),
    requestsPerMinute: z.number().int().min(1).default(2),
    userAgent: z.string().min(1).default('Mozilla/5.0 OpenAIdom/1.0'),
  }).default({}),
  ohlcDev: z.object({
    baseUrl: z.string().url().default('https://api.ohlc.dev'),
    requestTimeoutMs: z.number().int().min(1_000).default(10_000),
    requestsPerMinute: z.number().int().min(1).default(2),
  }).default({}),
}).default({}),
```

This is a deliberate breaking design change from the earlier single-provider proposal.

### Context Block Format

The block renders as a compact markdown table with stable text. Do not include `fetchedAt` in the prompt block.

```markdown
## Upcoming Economic Events
Events impacting USD over next 48h. Filter: impact >= medium.
Sources: Forex Factory, OHLC.dev

| Time (UTC) | Currency | Event | Impact | Forecast | Previous |
|------------|----------|-------|--------|----------|----------|
| 2026-07-09 14:00 | USD | FOMC Statement | high | — | 5.50% |
| 2026-07-09 14:30 | USD | FOMC Press Conference | high | — | — |
| 2026-07-10 12:30 | USD | CPI m/m | high | 0.2% | 0.1% |
| 2026-07-10 12:30 | USD | Core CPI m/m | high | 0.3% | 0.2% |
| 2026-07-10 14:30 | USD | Crude Oil Inventories | medium | -1.5M | -2.3M |
```

### Runtime Context Rendering

Add a `macro-economic` provider to `RUNTIME_CONTEXT_PROVIDERS[]` that:

- only renders for trading-capable agents
- returns `null` when `macroEvents` is empty
- truncates to `marketData.economicCalendar.maxEventsInContext` before rendering
- uses a deterministic event order: ascending time, then currency, then event name

Because current dynamic trimming is block-id based, phase 1 should also refactor `trimDynamicBlocks()` to use provider metadata instead of hardcoded block ids. Since backward compatibility is not required, replace the ad hoc trimming with provider-priority trimming that actually honors `trimOrder`.

### RuntimeSessionMetrics Addition

```typescript
export interface RuntimeSessionMetrics {
  // ... existing fields ...

  /** Upcoming economic events for context injection. Null when calendar is disabled or unavailable. */
  macroEvents: EconomicEvent[] | null;
}
```

## Data Source Strategy

### Dual-Source, Mandatory in Phase 1

Phase 1 implements both sources. Forex Factory is mandatory, not a future or optional fallback.

#### Forex Factory

Forex Factory provides the canonical event coverage target for this feature and must be implemented in phase 1.

Adapter responsibilities:

1. Fetch `https://www.forexfactory.com/calendar` with stable browser-like headers.
2. Parse the calendar table from HTML.
3. Normalize event rows into `EconomicEvent` records.
4. Filter by impact, currencies, and lookahead window.
5. Return structured results.

#### OHLC.dev

OHLC.dev remains valuable as a structured JSON source.

Adapter responsibilities:

1. Fetch `https://api.ohlc.dev/economic-calendar`.
2. Deserialize JSON into normalized `EconomicEvent` records.
3. Filter by impact, currencies, and lookahead window.
4. Return structured results.

#### Merge and Conflict Rules

The composite provider fetches both sources, then:

1. Normalizes titles, timestamps, and impact labels.
2. Dedupes events within the configured time window.
3. Prefers Forex Factory title/impact labeling on conflicts.
4. Preserves all contributing source ids in `EconomicEvent.sources`.
5. Returns a single merged event list.

If one source fails:

- log at warn level
- continue with the surviving source

If both fail:

- return an error result
- leave the context block absent for that tick
- do not fail the agent session

### Caching Strategy

The existing provider-response cache is in-memory only. That is insufficient here because each agent runtime runs in its own process/container.

Phase 1 must introduce a Redis-backed `ProviderResponseCache` implementation and use it for economic-calendar fetches. Without this, every agent container will refetch the same calendar independently and the request-volume assumptions are wrong.

Cache characteristics:

- cache key: `economic-calendar:{daysForward}:{minImpact}:{currencies}:{sourceOrder}`
- TTL: `marketData.economicCalendar.cacheTtlMs`
- stale-while-revalidate allowed
- value: merged, normalized `EconomicCalendarResult`

## Implementation Steps

### Step 1: Define the domain port — **DONE**

**Files:**

- `packages/domain/src/ports/economic-calendar.ts` (new)
- `packages/domain/src/ports/index.ts`

Add `EconomicEvent`, `EconomicCalendarResult`, `EconomicCalendarError`, and `EconomicCalendarProvider`.

### Step 2: Move config into marketData — **DONE**

**Files:**

- `packages/domain/src/config/schema.ts`
- `packages/market-data/src/types.ts`
- `config/default.yaml`

Add `marketData.economicCalendar` under `MarketDataConfigSchema` and update the `MarketDataConfig` TypeScript interface accordingly.

Do not preserve the old top-level `economicCalendar` proposal.

### Step 3: Implement both adapters and the composite provider — **DONE**

**Files:**

- `packages/market-data/src/economic-calendar.ts` (new)
- `packages/market-data/src/index.ts`

Implement:

- `ForexFactoryCalendarAdapter`
- `OhlcDevCalendarAdapter`
- `CompositeEconomicCalendarProvider`

The composite provider is the public entry point used by the agent runtime.

### Step 4: Introduce Redis-backed provider caching — **DONE**

**Files:**

- `packages/market-data/src/cache.ts`
- or `packages/market-data/src/redis-cache.ts` (new)

Add a Redis-backed `ProviderResponseCache` implementation and thread it through the economic-calendar provider factory.

If the existing market-data registry can reuse this cache abstraction cleanly, do that rather than creating a second caching abstraction.

### Step 5: Add runtime metrics state — **DONE**

**File:** `apps/worker/src/runtime-composition.ts`

- add `macroEvents: EconomicEvent[] | null` to `RuntimeSessionMetrics`
- initialize it to `null` in `createRuntimeCompositionState()`

### Step 6: Refactor dynamic trimming and add the context provider — **DONE**

**File:** `apps/worker/src/runtime-composition.ts`

- add `macro-economic` to `RUNTIME_CONTEXT_PROVIDERS[]`
- render from `state.metrics.macroEvents`
- cap output to `maxEventsInContext`
- replace block-id-specific trimming with provider-driven trimming that honors `trimOrder`

### Step 7: Instantiate and call the provider in the agent runtime — **DONE**

**File:** `apps/worker/src/agent.ts`

At runtime startup:

- read `marketData.economicCalendar` from `MARKET_DATA_CONFIG_JSON`
- build the composite provider once, using Redis-backed cache and the runtime Redis client

On each trading tick, before `buildTickUserContext()`:

- if `marketData.economicCalendar.enabled` is false, set `runtimeState.metrics.macroEvents = null`
- otherwise call `economicCalendarProvider.getUpcomingEvents()`
- write the merged events into `runtimeState.metrics.macroEvents`

Failure behavior:

- warn-and-continue
- never terminate the session because the macro calendar is unavailable

Logging:

- log source availability
- log event count
- log latency

### Step 8: Reuse existing runtime payload wiring — **DONE** (verified, no changes needed)

**Files:**

- `apps/worker/src/index.ts`
- `apps/worker/src/agents/runtime-lifecycle.ts`
- `apps/worker/src/agents/docker-agent-manager.ts`

No new top-level runtime payload is needed if the config lives under `marketData`.

Verify that the existing `MARKET_DATA_CONFIG_JSON` forwarding path carries the new `economicCalendar` subtree unchanged.

### Step 9: Add tests — **DONE**

**Files:**

- `packages/market-data/src/economic-calendar.test.ts` (new)
- `apps/worker/src/runtime-composition.test.ts`
- `apps/worker/src/agent.ts` tests or a targeted runtime integration test

Required coverage:

- Forex Factory HTML parsing from realistic fixture HTML
- OHLC.dev JSON normalization
- merge/dedupe behavior across both sources
- conflict preference for Forex Factory labels
- one-source failure with degraded success
- two-source failure with error result
- Redis cache hit/miss/stale behavior
- provider returns `null` block when `macroEvents` is empty
- rendered block excludes volatile `fetchedAt`
- `maxEventsInContext` truncation
- provider-driven trimming behavior

### Step 10: Integration smoke test — **MANUAL** (deployment step)

- enable `marketData.economicCalendar.enabled: true` in development config
- start the worker and launch a trading agent
- verify the prompt contains the macro block
- verify repeated ticks do not churn the diff when events are unchanged
- verify cache hits avoid repeated upstream requests
- verify one-source outage still yields usable context

## Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/ports/economic-calendar.ts` | New port and types |
| `packages/domain/src/ports/index.ts` | Re-export economic-calendar port |
| `packages/domain/src/config/schema.ts` | Add `marketData.economicCalendar` schema |
| `packages/market-data/src/types.ts` | Extend `MarketDataConfig` with `economicCalendar` |
| `packages/market-data/src/economic-calendar.ts` | New dual-source provider implementation |
| `packages/market-data/src/cache.ts` or `redis-cache.ts` | Add Redis-backed provider-response cache |
| `packages/market-data/src/index.ts` | Export economic-calendar provider |
| `apps/worker/src/runtime-composition.ts` | Add `macroEvents`, macro provider, generic trimming |
| `apps/worker/src/agent.ts` | Instantiate provider and fetch events during ticks |
| `packages/market-data/src/economic-calendar.test.ts` | Adapter/composite/cache tests |
| `config/default.yaml` | Document `marketData.economicCalendar` defaults |

## Verification

- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Forex Factory parser passes against realistic fixture HTML
- [ ] OHLC.dev normalization passes against representative JSON payload
- [ ] Merged output dedupes equivalent events from both sources
- [ ] Forex Factory labels win on title/impact conflicts
- [ ] `marketData.economicCalendar.enabled: false` disables fetches and block rendering
- [ ] `marketData.economicCalendar.enabled: true` injects the block only for trading agents
- [ ] Redis cache hit avoids upstream fetch on subsequent ticks within TTL
- [ ] Stale cache can serve degraded data if an upstream source is down
- [ ] One-source outage still yields a block from the surviving source
- [ ] Two-source outage logs a warning and omits the block without killing the session
- [ ] Rendered block is stable when the event set is unchanged
- [ ] Incremental diff does not churn on refresh timestamps

## Rollout Order

1. Domain types and market-data config
2. Dual adapters and composite provider
3. Redis-backed cache
4. Runtime metrics and context rendering
5. Agent-runtime integration
6. Smoke test in development, then staging

Feature remains disabled by default. Enable in staging first, observe source stability and cache behavior, then enable in production.

## Warning

Do not limit yourself to this plan. Re-check the current code before implementation, especially runtime payload wiring, cache abstractions, and prompt-trimming behavior.
