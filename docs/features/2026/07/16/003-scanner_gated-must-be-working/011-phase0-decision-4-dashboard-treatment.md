# Decision 4: Provider-Counter/Dashboard Treatment

**Decision:** 4 — Existing provider counter taxonomy and whether scanner candle traffic is already represented in the Admin Dashboard
**Status:** accepted
**Date:** 2026-07-16
**Owner:** Implementer agent (Phase 0 research)

## Question

What is the existing provider counter taxonomy, and is scanner candle traffic already represented in the Admin Dashboard data?

## Inspected Sources

### Admin Dashboard UI (`apps/web/src/features/admin/AdminMarketDataSection.tsx`)

- Renders two cards: "Discovery Snapshot" and "Providers" table
- Providers table columns (lines 236–252):
  - Provider, Status, Request Class, RPM, Burst, Max Wait, Cache TTL
  - Success, Failure, Last Success, Fresh, Cached, Waits, Throttles
- Data comes from `GET /admin/market-data/providers` → `AdminProviderRow[]`
- Binance is rendered as provider `binance` with request class `regime`
- **No per-agent or per-source breakdown** — all binance:regime traffic is aggregated

### Admin API endpoint (`apps/api/src/routes/admin.ts`, lines 526–695)

- `GET /admin/market-data/providers` — returns per-provider, per-request-class counters
- Binance configured as:
  ```typescript
  {
    name: 'binance',
    configured: true,
    enabled: true,
    unwired: false,
    requestClasses: [{
      requestClass: 'regime',
      requestsPerMinute: cfg?.binance.requestsPerMinute ?? 200,
      burstCapacity: cfg?.binance.requestsPerMinute ?? 200,
      maxWaitMs: cfg?.timeoutMs ?? 5000,
      cacheTtlMs: 0,
      counters: classCounters('binance', 'regime'),
    }],
  }
  ```
- `classCounters()` reads from `readProviderCounters(redis)` which reads the Redis hash `market-intel:provider-counters:v2`
- Key format: `binance:regime:success`, `binance:regime:failure`, etc.
- **Scanner candles and bot regime checks share the SAME counter key** — `binance:regime`

### Provider counters module (`apps/worker/src/market-intelligence/provider-counters.ts`)

- Redis hash key: `market-intel:provider-counters:v2`
- Counter fields per `provider:requestClass`:
  - `success` — count of successful upstream fetches (incremented in `loadWithCache`)
  - `failure` — count of failed fetches
  - `lastSuccessAt` — ISO timestamp of last successful fetch
  - `freshnessModeFresh` — resolved from upstream (not cache)
  - `freshnessModeCached` — resolved from cache
  - `rateLimitWaitCount` — waited but acquired
  - `rateLimitThrottleCount` — exceeded maxWaitMs, dropped

- Published by `recordProviderSuccess()`, `recordProviderFailure()`, `recordFreshnessMode()`, `recordRateLimitWait()`, `recordRateLimitThrottle()`
- Called from `apps/worker/src/market-intelligence/coordinator.ts` (line 8)

### Event publisher (`apps/worker/src/agents/instance-event-publisher.ts`)

- `emitTechnicalScanCompleted()` — publishes `agent.technical.scan_completed` with `TechnicalScanState` payload (Redis Stream per-agent)
- `emitAgentWake()` — publishes `agent.wake` with `AgentWakePayload`
- `emitJournalEvent()` — publishes journal events
- **No provider-counter events** — provider counters are a separate pipeline (Redis hash, not streams)

### Worker startup logging (`apps/worker/src/index.ts`)

- No scanner-specific provider metrics logged at startup
- `sharedMarketDataRegistry` is created once at module level — no per-consumer tracking
- `discoverCandidates` and `fetchCandles` are plain function references — not wrapped for observability

### Market data recording config (`config/default.yaml`)

```yaml
marketDataRecording:
  enabled: false
  captureTrades: true
  captureTopOfBook: true
  captureCandles: true
```

- Disabled by default. When enabled, records market data for backtesting, not operational observability.
- **No scanner-specific recording config.**

## Decision

### Scanner candle traffic IS already partially represented in Admin Dashboard counters

The scanner candle path flows through:
```
fetchCandles (index.ts)
  → agentCandleFetcher.fetchCandles (VenueCandleFetcher)
    → fetchBinanceCandles (binance-candles.ts)
      → loadWithCache (cache.ts)
        → CoordinatedRateLimiter.acquire() (rate-limiter.ts)
        → recordProviderSuccess / recordProviderFailure (provider-counters.ts)
          → Redis hash: market-intel:provider-counters:v2 field 'binance:regime:success'
```

Every scanner candle request increments `binance:regime:success` (or `failure`) in the same Redis hash that powers the Admin Dashboard providers table. Therefore:

- **Binance "Success" count**: includes both bot regime checks AND scanner candle fetches — indistinguishable
- **Binance "Failure" count**: includes failures from both sources
- **Binance "Waits" / "Throttles"**: includes rate-limit events from both sources

**The dashboard already shows aggregate binance health.** Scanner traffic contributes to those aggregate counters. However, the dashboard cannot answer "how much of this traffic is scanner vs. regime?"

### The plan's guidance: "do not create a parallel dashboard"

The plan says (lines in hardening plan, Non-Goals section):
> Existing observability is used wherever it already represents the relevant scanner/provider activity; any gap is recorded and resolved through the smallest compatible extension.

And (in the live verification section):
> The existing Admin Dashboard should be checked during live verification for any already-represented discovery/provider health. Do not assume that its current counters include scanner candle activity. If they do not, record the gap and extend the existing telemetry path only as necessary for release evidence; do not create a parallel dashboard without a separately approved product decision.

**Assessment:**
- Scanner traffic IS in the existing counters (confirmed by tracing the call path)
- The **gap** is not absence of counters, but **indistinguishability** — scanner and regime traffic share the same counter key
- For release evidence, we need to know that scanner traffic specifically is working. The aggregate binance:regime counters can't provide this if other regime traffic is also active.

### Smallest extension to the existing telemetry path

**Option A: Add a `scannerRequests` sub-counter to the existing hash**

Add a new metric field to `ProviderCounterSnapshot` and the Redis hash:

```typescript
// In provider-counters.ts
export interface ProviderCounterSnapshot {
  // ... existing fields ...
  scannerSuccess: number;   // NEW: scanner-specific success count
  scannerFailure: number;   // NEW: scanner-specific failure count
}
```

The scanner `fetchCandles` wrapper in `index.ts` would call a new function `recordScannerProviderSuccess(redis, 'binance', 'regime')` alongside the existing `recordProviderSuccess`. This adds scanner-specific counters to the same hash, same dashboard table (new column), without creating a separate dashboard.

**Option B: Emit scanner-specific events to the agent's Redis Stream**

The `emitTechnicalScanCompleted` event already carries `TechnicalScanState` which includes `errors[]`. Per-symbol fetch diagnostics could be added to this payload. The Admin Dashboard already reads agent streams for activity. This would surface scanner health in the agent activity feed rather than the providers table.

**Option C: Accept indistinguishability — record gap as known limitation**

The aggregate binance:regime counters are sufficient for operational monitoring. For release evidence (Phase 3 live smoke), per-symbol diagnostic output from the smoke script is the authoritative source, not the dashboard. The dashboard is for ongoing operations, where aggregate health is sufficient.

### Chosen approach: Option A (smallest extension) + Option C (pragmatic acceptance)

**For Phase 2 implementation:** No dashboard changes. The existing provider counters already track scanner traffic at the aggregate level. The scanner outcome health matrix (from the plan) will be implemented in the `TechnicalScanState` payload — per-scan structured outcomes go to the agent stream, not the providers table.

**For release evidence (Phase 3):** The live-provider smoke script will capture per-symbol diagnostics independently of the dashboard. The dashboard will be checked during smoke to confirm that binance:regime counters ARE incrementing during scanner activity — this confirms the pipeline is working end-to-end.

**For operational observability:** If operators later need to distinguish scanner traffic from regime traffic, the smallest extension is to add `scannerSuccess`/`scannerFailure` fields to the existing `ProviderCounterSnapshot` and the `recordProviderSuccess` call site in the scanner fetch wrapper. This requires:
1. New field in `ProviderCounterSnapshot` interface
2. New `recordScannerProviderSuccess()` function (or optional `source` parameter on existing)
3. New column in Admin Dashboard providers table (behind existing `AdminProviderCounters` interface)

This is a **follow-on item**, not required for Phase 2 implementation.

### Is a new dashboard panel needed?

**No.** The existing Providers table already shows binance health. Adding a scanner-specific column (e.g., "Scanner Success" / "Scanner Failure") to the existing table is the natural extension. A separate dashboard panel would violate the plan's guidance.

## Rejected Alternatives

- **Alternative: Create a new `scanner-counters` Redis hash and a new dashboard panel**
  - Rejected: Violates plan guidance ("do not create a parallel dashboard"). Adds a separate monitoring surface when the existing providers table is the right home.

- **Alternative: Add scanner counter fields to the agent activity feed**
  - Rejected: Mixes provider-level operational metrics with agent-level activity. The providers table is the established home for provider health. Agent activity is for trading behavior.

- **Alternative: Rely solely on logs for scanner provider health**
  - Rejected: Logs are not structured observability. The plan explicitly requires "structured scan outcomes" and "observable rate-limit and data-failure behavior."

## Implementation Consequences

### Phase 2 (immediate)

- No changes to provider counters or dashboard
- `TechnicalScanState` payload extended with structured per-symbol outcomes:
  ```typescript
  interface SymbolFetchOutcome {
    symbol: string;
    resolvedProviderSymbol?: string;
    status: 'fetched' | 'unsupported' | 'transient_failure' | 'empty';
    candleCount?: number;
    errorDetail?: string;
  }
  interface TechnicalScanState {
    // ... existing fields ...
    symbolOutcomes: SymbolFetchOutcome[];    // NEW
    providerHealthSummary: {                 // NEW
      totalRequests: number;
      succeeded: number;
      unsupported: number;
      transientFailures: number;
      emptyResponses: number;
    };
  }
  ```
- `emitTechnicalScanCompleted` publishes this enriched payload to the agent stream
- Live smoke script (Phase 3) reads these structured outcomes for per-symbol verification

### Follow-on (deferred)

- Add `scannerSuccess`/`scannerFailure` fields to `ProviderCounterSnapshot`
- Add `recordScannerProviderSuccess()` and `recordScannerProviderFailure()` to `provider-counters.ts`
- Call from scanner `fetchCandles` wrapper in `index.ts`
- Extend `AdminProviderCounters` interface and dashboard table column
- Add `admin.test.ts` coverage for new counter fields

## Required Validation

- **Dashboard smoke**: During active scanner operation, confirm binance:regime success counter increments in Admin Dashboard
- **Smoke script**: Read `agent.technical.scan_completed` event from agent stream; verify `symbolOutcomes` array contains expected per-symbol diagnostics
- **Unit test**: `TechnicalScanState` serialization includes `symbolOutcomes` and `providerHealthSummary`
- **Unit test**: Empty scan produces `providerHealthSummary` with all zeros and empty `symbolOutcomes`

## Residual Risk or Follow-Up

- **Counter indistinguishability**: Operators cannot distinguish scanner traffic from regime traffic in the dashboard until the follow-on `scannerSuccess`/`scannerFailure` counters are added. Mitigation: the per-scan `providerHealthSummary` in the agent stream provides scanner-specific diagnostics in the interim.
- **Dashboard staleness**: The provider counters are Redis hash increments — they're durable but not purged. Over long periods, the absolute counts lose meaning; rate-per-minute is more useful. This is a pre-existing limitation, not introduced by scanner traffic.
