# Macro-Economic Context Block

**Created:** 2026-07-08
**Status:** pending
**Depends on:** none

## Problem

Trading agents have no awareness of upcoming high-impact economic events (FOMC, NFP, CPI, etc.). These "red-folder" events cause sharp volatility in crypto markets. Agents trading through them blindly are exposed to unnecessary risk.

Today, an agent could theoretically use `search_web` or `browse_url` to check an economic calendar, but this costs an extra LLM round-trip per check and produces inconsistent, hard-to-parse results.

## Goal

Inject a compact, structured summary of upcoming high-impact economic events into trading agents' context — zero tool calls, zero extra LLM round-trips, delivered via the existing incremental context diff pipeline. The data appears as a context block that trading agents can reason about when making decisions.

## Non-Goals

- A `macro-awareness` skill definition (follow-up, out of scope)
- A `get_economic_calendar` tool (follow-up, out of scope)
- Inter-agent broadcast or newsletter publishing (follow-up, out of scope)
- Sentiment analysis of economic events (separate feature)

## Design

### Data Volume

A 48-hour window of high-impact events is ~500–2,000 characters (~125–500 tokens). Filtered to high-impact only, the block is compact enough for every-tick injection without meaningful cost. The incremental diff system ensures the block is only transmitted when it changes (~every 6 hours), not on every tick.

### Architecture

```
┌──────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ OHLC.dev API │────▶│ EconomicCalendarProvider│────▶│ Worker tick loop    │
│ (JSON fetch) │     │ (port + adapter)      │     │ (populate metrics)  │
└──────────────┘     └──────────────────────┘     └──────────┬──────────┘
                                                              │
                                                              ▼
┌──────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ LLM prompt       │◀────│ buildTickUserContext  │◀────│ RuntimeSessionMetrics│
│ (macroContext    │     │ (RUNTIME_CONTEXT_     │     │ .macroEvents        │
│  block injected) │     │  PROVIDERS filter)    │     │                     │
└──────────────────┘     └──────────────────────┘     └─────────────────────┘
```

### Port Interface

```typescript
// packages/domain/src/ports/economic-calendar.ts

export interface EconomicEvent {
  /** ISO-8601 datetime string (UTC) */
  time: string;
  /** Currency code (USD, EUR, GBP, etc.) */
  currency: string;
  /** Event name (e.g. "FOMC Statement", "Non-Farm Employment Change") */
  event: string;
  /** Impact level */
  impact: 'high' | 'medium' | 'low';
  /** Forecast value (null if none) */
  forecast: string | null;
  /** Previous value (null if none) */
  previous: string | null;
}

export interface EconomicCalendarResult {
  events: EconomicEvent[];
  /** ISO-8601 datetime of when this data was fetched */
  fetchedAt: string;
  /** Data source identifier for traceability */
  source: string;
}

export interface EconomicCalendarError extends DomainError {
  code: string;
}

export interface EconomicCalendarProvider {
  /**
   * Fetch upcoming economic events.
   * @param options.daysForward — number of days to look ahead (default: 2)
   * @param options.currencies — filter to specific currencies (default: all major)
   * @param options.minImpact — minimum impact level (default: 'medium')
   */
  getUpcomingEvents(options?: {
    daysForward?: number;
    currencies?: string[];
    minImpact?: 'high' | 'medium' | 'low';
  }): Promise<Result<EconomicCalendarResult, EconomicCalendarError>>;
}
```

### Config Schema

```typescript
// Added to AppConfigSchema in packages/domain/src/config/schema.ts

economicCalendar: z.object({
  enabled: z.boolean().default(false),
  /** Provider to use for economic calendar data */
  provider: z.enum(['ohlc-dev', 'forex-factory']).default('ohlc-dev'),
  /** Base URL for the calendar source */
  baseUrl: z.string().url().default('https://api.ohlc.dev'),
  /** How many days forward to fetch */
  daysForward: z.number().int().min(1).max(14).default(2),
  /** Minimum impact level to include in context */
  minImpact: z.enum(['high', 'medium', 'low']).default('medium'),
  /** Currencies to include (empty = all major) */
  currencies: z.array(z.string()).default([]),
  /** Redis cache TTL in milliseconds */
  cacheTtlMs: z.number().int().min(0).default(3_600_000),  // 1 hour
  /** Max events to include in context block */
  maxEventsInContext: z.number().int().min(1).max(50).default(20),
  /** HTTP request timeout in milliseconds */
  requestTimeoutMs: z.number().int().min(1_000).default(10_000),
  /** Rate limit: max requests per minute to the calendar source */
  requestsPerMinute: z.number().int().min(1).default(2),
}).default({}),
```

### Context Block Format

The block renders as a compact markdown table:

```markdown
## Upcoming Economic Events
Events impacting USD over next 48h. Filter: impact >= medium.
Source: OHLC.dev | Fetched: 2026-07-08T14:00:00Z

| Time (UTC) | Currency | Event | Impact | Forecast | Previous |
|------------|----------|-------|--------|----------|----------|
| 2026-07-09 14:00 | USD | FOMC Statement | high | — | 5.50% |
| 2026-07-09 14:30 | USD | FOMC Press Conference | high | — | — |
| 2026-07-10 12:30 | USD | CPI m/m | high | 0.2% | 0.1% |
| 2026-07-10 12:30 | USD | Core CPI m/m | high | 0.3% | 0.2% |
| 2026-07-10 14:30 | USD | Crude Oil Inventories | medium | -1.5M | -2.3M |
```

### RuntimeContextProvider

```typescript
// In RUNTIME_CONTEXT_PROVIDERS[] (runtime-composition.ts)

{
  id: 'macro-economic',
  costTier: 'cheap',
  section: 'dynamic',
  requiredFamilies: ['trading'],
  trimOrder: 6,
  build: (state) => {
    if (!state.metrics.macroEvents || state.metrics.macroEvents.length === 0) {
      return null;
    }
    // Render table from state.metrics.macroEvents
    // Return RuntimeContextBlock with id: 'macroEconomic'
  },
}
```

Place `trimOrder: 6` so it trims before heavier blocks (`managed-bots` at 6, `venue-intelligence` at 5, `technical-scan` at 4) — macro data is compact and valuable.

### RuntimeSessionMetrics Addition

```typescript
export interface RuntimeSessionMetrics {
  // ... existing fields ...

  /** Upcoming economic events for context injection. Null when calendar is disabled. */
  macroEvents: EconomicEvent[] | null;
}
```

## Data Source Strategy

### Primary: OHLC.dev Economic Calendar API

OHLC.dev provides a developer-focused economic calendar with a clean JSON API, generous free tier, and type-safe payloads — ideal for LLM agent context injection. It covers all major economies and red-folder events (FOMC, NFP, CPI, PMI, etc.).

**Why OHLC.dev over alternatives:**

| Alternative | Issue |
|-------------|-------|
| FXMacroData | Enterprise paid tiers — overkill for a simple event list |
| FRED API | Historical time-series only — no forward-looking calendar |
| Fed RSS/Web | Fed-only coverage (no CPI, NFP, PMI); unstructured raw text |
| Forex Factory | No official API — requires fragile HTML scraping |

The adapter will:

1. **Fetch** `https://api.ohlc.dev/economic-calendar` with query params (`daysForward`, `impact`, `currencies`)
2. **Deserialize** the JSON response into `EconomicEvent[]` — no HTML parsing needed
3. **Filter** by impact level and currency (server-side via query params where supported, client-side fallback)
4. **Return** structured `EconomicCalendarResult`

**Free tier characteristics:**
- Sufficient for dev/staging with reasonable rate limits
- If rate limits become an issue in production, the 1-hour Redis cache makes request volume negligible (~24 requests/day regardless of agent count)

### Fallback: Forex Factory (HTML scraping)

If OHLC.dev becomes unavailable or its free tier is insufficient, Forex Factory remains as a fallback. The adapter:

1. **Fetch** `https://www.forexfactory.com/calendar` with appropriate headers
2. **Parse** the HTML table — calendar rows have consistent CSS classes and data attributes
3. **Filter** by impact level and currency
4. **Return** structured `EconomicEvent[]`

**Risks and mitigations:**

| Risk | Mitigation |
|------|------------|
| HTML structure changes | Port abstraction allows swapping adapter without touching context code |
| Rate limiting / blocking | Cache aggressively (1h+ TTL), low request rate (2/min max) |
| No official API | OHLC.dev is the primary; Forex Factory is the fallback |

### Future Enrichment Sources (Phase 2+, out of scope)

- **FRED API** — Historical economic data series for trend context ("CPI has been trending up for 3 months"). Not a calendar — would be a separate context block or tool.
- **Financial Modeling Prep** — `https://financialmodelingprep.com/api/v3/economic_calendar` (paid, reliable JSON, viable alternative to OHLC.dev)

The port is designed so that swapping sources requires only a new adapter implementation — no changes to config shape, context building, or metrics.

## Implementation Steps

### Step 1: Define port interface

**File:** `packages/domain/src/ports/economic-calendar.ts` (new)

- Define `EconomicEvent`, `EconomicCalendarResult`, `EconomicCalendarError`
- Define `EconomicCalendarProvider` interface
- Export from `packages/domain/src/ports/index.ts`

### Step 2: Add config schema

**File:** `packages/domain/src/config/schema.ts`

- Add `EconomicCalendarConfigSchema` following the `MarketDataConfigSchema` pattern
- Add `economicCalendar` to `AppConfigSchema`
- Export the inferred type

### Step 3: Implement OHLC.dev adapter

**File:** `packages/market-data/src/economic-calendar.ts` (new)

- Implement `OhlcDevCalendarAdapter` class implementing `EconomicCalendarProvider`
- Fetch from `https://api.ohlc.dev/economic-calendar` with query parameters
- Deserialize JSON response — no HTML parsing required
- Apply impact/currency filtering (server-side via query params where supported, client-side fallback)
- Return `Result<EconomicCalendarResult, EconomicCalendarError>`
- Optionally implement `ForexFactoryCalendarAdapter` as a fallback using the same interface

**File:** `packages/market-data/src/index.ts`

- Export the adapter and types

### Step 4: Add caching layer

**File:** `packages/market-data/src/economic-calendar.ts`

- Wrap adapter with Redis-based caching using the existing `loadWithCache` or similar pattern
- Cache key: `economic-calendar:{daysForward}:{minImpact}:{currencies}`
- TTL from config: `economicCalendar.cacheTtlMs`

### Step 5: Add RuntimeSessionMetrics field

**File:** `apps/worker/src/runtime-composition.ts`

- Add `macroEvents: EconomicEvent[] | null` to `RuntimeSessionMetrics`
- Initialize as `null` in the metrics factory

### Step 6: Add RuntimeContextProvider

**File:** `apps/worker/src/runtime-composition.ts`

- Add `macro-economic` provider to `RUNTIME_CONTEXT_PROVIDERS[]`
- `requiredFamilies: ['trading']`, `section: 'dynamic'`, `costTier: 'cheap'`
- Build function renders the event table from `state.metrics.macroEvents`
- Returns `null` when `macroEvents` is null or empty

### Step 7: Wire into worker tick loop

**File:** `apps/worker/src/agent.ts`

- After the existing metrics population (portfolio, positions, etc.) and **before** `buildTickUserContext()`:
  - Check `config.economicCalendar.enabled`
  - If enabled, call `economicCalendarProvider.getUpcomingEvents()`
  - Populate `runtimeState.metrics.macroEvents` with the result
- Wrap in try/catch — failure to fetch calendar data is a warn-and-continue, not a fatal error
- Log fetch latency and event count at info level

### Step 8: Add config loading

**File:** `apps/worker/src/config.ts` (or wherever worker config is assembled)

- Ensure `economicCalendar` config section is loaded and passed to the worker
- Pass to the adapter factory

### Step 9: Add tests

**File:** `packages/market-data/src/economic-calendar.test.ts` (new)

- Test Forex Factory HTML parsing with a snapshot of real calendar HTML
- Test impact/currency filtering logic
- Test empty result handling
- Test error handling (network failure, malformed HTML)

**File:** `apps/worker/src/runtime-composition.test.ts` (if it exists, or new)

- Test that `macro-economic` provider returns `null` when `macroEvents` is null
- Test that it renders correctly with sample events
- Test that it respects `maxEventsInContext` config

### Step 10: Integration smoke test

- Enable `economicCalendar.enabled: true` in development config
- Start worker, launch a trading agent
- Verify `macroContext` block appears in agent context (check agent debug output or logs)
- Verify events are reasonable and correctly formatted
- Verify no errors on subsequent ticks (cache hit)
- Verify cache expiry triggers a fresh fetch

## Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/ports/economic-calendar.ts` | New — port interface |
| `packages/domain/src/ports/index.ts` | Re-export new port |
| `packages/domain/src/config/schema.ts` | Add `economicCalendar` config section |
| `packages/market-data/src/economic-calendar.ts` | New — OHLC.dev adapter (+ Forex Factory fallback) + caching |
| `packages/market-data/src/index.ts` | Export new module |
| `apps/worker/src/runtime-composition.ts` | Add `macroEvents` to metrics + `macro-economic` provider |
| `apps/worker/src/agent.ts` | Fetch calendar data in tick loop before context build |
| `packages/market-data/src/economic-calendar.test.ts` | New — adapter tests |
| `config/default.yaml` | Document `economicCalendar` section with defaults (disabled) |

## Verification

- [ ] `pnpm lint` passes (no type errors)
- [ ] `pnpm test` passes (all existing tests still pass)
- [ ] New adapter tests pass (JSON deserialization, filtering, error handling)
- [ ] Context block renders correctly with sample event data
- [ ] `economicCalendar.enabled: false` → no block injected, no fetches made (zero-cost disable)
- [ ] `economicCalendar.enabled: true` → block appears for trading agents, absent for non-trading agents
- [ ] Cache hit: second tick within TTL uses cached data (no HTTP request)
- [ ] Cache miss: after TTL expiry, fresh fetch occurs
- [ ] Network failure: agent continues trading, error logged at warn level, no block injected
- [ ] Incremental diff: block text unchanged between ticks → no tokens transmitted

## Rollout Order

1. **Domain + config** (Steps 1–2) — no runtime impact, just type definitions
2. **Adapter + tests** (Steps 3–4, 9) — can be developed and tested in isolation
3. **Context block + worker wiring** (Steps 5–8) — the runtime integration
4. **Smoke test** (Step 10) — end-to-end validation

Feature is disabled by default (`economicCalendar.enabled: false`). Enable in staging first, observe for 24h, then enable in production.

## Warning

Don't limit yourself to the information contained in this plan. The code may have changed or this plan may have missed something, so properly check the code base before starting.
