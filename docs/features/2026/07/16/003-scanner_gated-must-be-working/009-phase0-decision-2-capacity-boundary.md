# Decision 2: Capacity-Control Boundary

**Decision:** 2 — Appropriate capacity-control boundary for scanner work
**Status:** accepted
**Date:** 2026-07-16
**Owner:** Implementer agent (Phase 0 research)

## Question

What is the appropriate capacity-control boundary for scanner work — existing provider limiter, worker scheduler, technical config, operator config, or a combination?

## Inspected Sources

### Rate limiter infrastructure (`packages/market-data/src/rate-limiter.ts`)

- `SharedRateBudgetCoordinator` interface — a token-bucket coordinator with priority-class reservations:
  - Priority order: `execution-critical` > `price-support` > `regime` > `discovery` > `enrichment`
  - `classReservations` protect higher-priority classes from lower-priority exhaustion
  - Two implementations: `InMemoryRateBudgetCoordinator` (per-process, default) and `RedisRateBudgetCoordinator` (cross-worker)
- `TokenBucketRateLimiter` — simple per-process token bucket, no class awareness
- `CoordinatedRateLimiter` — wraps `SharedBudgetAcquireRequest` (provider + requestClass + budget) into the coordinator

### Provider registry (`packages/market-data/src/provider-registry.ts`)

- `createProviderRegistry()` wires each provider with its request class:
  - **dexScreener**: `price-support` + `discovery` (shared 60 RPM budget, with price-support reserve)
  - **GeckoTerminal**: `regime` + `discovery` (shared 25 RPM budget, with regime reserve)
  - **Binance**: `regime` (flat 200 RPM, **no class reservations**)
  - **Hyperliquid**: `price-support` (120 RPM)
  - **Bybit**: `price-support` (120 RPM)
- Binance budget is read from `config.binance`:
  ```typescript
  const binanceBudget: SharedBudgetConfig = {
    requestsPerMinute: config.binance.requestsPerMinute,  // 200
    burstCapacity: config.binance.requestsPerMinute,      // 200
    maxWaitMs: config.binance.maxWaitMs,                  // 30000
    // NO classReservations — all 200 RPM available to 'regime'
  };
  ```
- Binance `CoordinatedRateLimiter` is created with `requestClass: 'regime'` — the same class used by both:
  - Bot regime checks (existing, periodic, low volume)
  - Agent scanner technical-phase candle fetches (new, potentially high volume)

### Binance operator config (`config/default.yaml`)

```yaml
marketData:
  binance:
    baseUrl: "https://api.binance.com"
    requestsPerMinute: 200
    maxWaitMs: 30000
```

- No `classReservations` defined for binance — the entire 200 RPM is shared as a flat pool
- No scanner-specific budget carve-out exists
- `maxWaitMs: 30000` is generous (meant for agent technical-phase batching, per inline comment)

### Worker scan loop (`apps/worker/src/agent-trading-actor.ts`)

- Lines 1436–1452: `startTechnicalScanLoop()` creates a per-agent `setInterval`
- Lines 1438–1443: Guard checks `technicalConfig`, `discoverCandidates`, `fetchCandles` — returns early if absent
- **No global concurrency control**: each scanner-gated agent runs its own scan timer independently
- **No per-worker limit** on how many active scanner agents or concurrent candle fetches
- Candle fetch batching (lines in `technical-phase.ts` 140–155) sends `scanBatchSize` requests concurrently per batch — all share the same binance `regime` bucket
- `fetchCandles` injected from `apps/worker/src/index.ts` line 293: wraps `VenueCandleFetcher` → `fetchBinanceCandles` → `config.rateLimiter.acquire()` → `SharedRateBudgetCoordinator`

### Operator config schema (`packages/domain/src/config/schema.ts`)

- `MarketDataConfigSchema` defines `binance: z.object({ baseUrl, requestsPerMinute, maxWaitMs })`
- No scanner-specific fields exist in the schema
- `agentRiskDefaults` section exists but covers risk limits, not capacity

### Configuration best practices (`docs/best-practices/configuration.md`)

- Rule: Operator config owns provider budgets, global limits, platform ceilings
- Rule: Persisted agent config owns user/strategy scope (symbols, filters, preferences)
- Rule: Never mix the two layers — don't hide platform protection in per-agent JSONB, don't put user trading policy in operator YAML

## Decision

### Global scanner capacity limit lives in operator YAML

The binance provider budget (200 RPM) is an **operator concern** — it's a shared infrastructure resource. Scanner traffic must not consume more than a reserved fraction of it. The operator must be able to adjust this reservation without touching agent configs.

**New operator config fields** in `config/default.yaml` under `marketData.binance`:

```yaml
marketData:
  binance:
    requestsPerMinute: 200
    maxWaitMs: 30000
    # NEW: scanner-specific capacity controls
    scanner:
      maxRequestsPerMinute: 50     # reserved ceiling for scanner candle traffic
      maxConcurrentScans: 4        # max scanner agents scanning concurrently (across all workers)
```

Since binance currently has no `classReservations`, we add a class reservation to protect non-scanner (regime) traffic. Alternatively, introduce a new request class for scanner traffic. The simpler approach: add `classReservations` on the existing binance budget:

```yaml
marketData:
  binance:
    requestsPerMinute: 200
    maxWaitMs: 30000
    classReservations:
      regime: 150           # reserve 150 RPM for non-scanner regime use
    scanner:
      maxRequestsPerMinute: 50    # implicit: 200 - 150 = 50 for scanner
      maxConcurrentScans: 4
```

Implementation approach: The scanner candle fetcher registers with the coordinator under a new request class (e.g., `'discovery'` since scanner is discovery-like, or a new `'scanner'` class). The `classReservations.regime = 150` reserves 150 RPM for existing regime use; the remaining 50 RPM is available to scanner.

Alternatively, **keep it simpler**: add a separate `TokenBucketRateLimiter` specifically for scanner candle traffic at the worker level (per-worker in-process), gated by an operator config value `scanner.maxRequestsPerMinute`. This avoids changing the provider registry's class taxonomy and is simpler to reason about. The existing `SharedRateBudgetCoordinator` already gates individual binance requests — the scanner-specific limiter would be an additional pre-filter at the `fetchCandles` wrapper level.

**Chosen approach**: A dedicated scanner rate limiter at the `fetchCandles` wrapper in `apps/worker/src/index.ts` (lines 291–296). This is the simplest, smallest-change approach:

1. Operator config field `marketData.binance.scanner.maxRequestsPerMinute` (default: 50)
2. Create a `TokenBucketRateLimiter` from this config value at worker startup
3. In the `fetchCandles` wrapper, call `scannerLimiter.acquire()` before delegating to `agentCandleFetcher.fetchCandles()`
4. Since `agentCandleFetcher.fetchCandles()` already calls `config.rateLimiter.acquire()` (the shared `binance:regime` limiter), the scanner limiter is an additional throttle — both must pass

**Why this approach wins:**
- Zero changes to the provider registry or `CoordinatedRateLimiter` class taxonomy
- The scanner limiter is colocated with the scanner path — easy to test, easy to remove
- The shared `binance:regime` limiter still protects all binance traffic (including scanner)
- The scanner-specific limiter provides the reservation (prevents scanner from starving regime checks)
- Config lives in operator YAML (correct layer per configuration rules)

### Per-agent candidate scope lives in persisted agent config

- `technical.filters.symbols` — explicit symbol list (narrows the Hyperliquid discovery)
- `technical.filters.excludeSymbols` — exclusion list
- `technical.filters.minVolume24hUsd` — volume filter
- `technical.scanBatchSize` — max concurrent candle requests per batch
- `technical.scanIntervalMs` — scan cadence per agent

These are trading-scope decisions (what to scan, how often) — they belong in persisted agent config, not operator YAML. This is already the case.

### Runtime derivation of effective per-scan cap

The runtime derives the effective cap as:

```
perScanMaxRequests = min(
  scannerConfig.maxBatchSize,           // from persisted agent config (scanBatchSize)
  availableScannerBudget / activeScanners // from operator config + runtime count
)
```

Where:
- `availableScannerBudget` = operator `scanner.maxRequestsPerMinute` (default 50)
- `activeScanners` = count of scanner-gated agents with active sessions at scan time
- The actual per-agent limit is computed by dividing the global budget among active scanners

Alternatively, if `maxConcurrentScans` is the gate (simpler):
- A global semaphore (Redis-backed for multi-worker) limits concurrent scans to `maxConcurrentScans`
- Each scan consumes one permit; the permit is released when the scan completes
- A scan that cannot acquire a permit within a short timeout is skipped (recorded as `overlap_skipped` or `capacity_unavailable`)

**Chosen primary mechanism**: global `maxConcurrentScans` semaphore, with the per-worker scanner rate limiter as a backstop.

### What existing infrastructure can be reused

| Infrastructure | Reuse? | How |
|---|---|---|
| `SharedRateBudgetCoordinator` (binance:regime) | ✅ Reused as-is | Already gates ALL binance requests. Scanner traffic goes through it. |
| `CoordinatedRateLimiter` (binance) | ✅ Reused as-is | No changes needed. |
| `TokenBucketRateLimiter` | ✅ Reused (new instance) | Create a scanner-specific instance from operator config. |
| `provider-counters.ts` (Redis counter hash) | ✅ Reused | Scanner candle traffic already increments `binance:regime` success/failure counters. |
| `InstanceEventPublisher` | ✅ Reused | `emitTechnicalScanCompleted` already publishes scan outcomes. Capacity-skip outcomes can be added to this payload. |
| Actor lifecycle (`onSessionActive`) | ✅ Reused | Scanner capacity gate runs before scan loop starts. Config already validated in Phase 1. |
| Redis (for cross-worker semaphore) | ⚠️ New use | A Redis-based semaphore for `maxConcurrentScans` across workers. Could use `SETNX` with TTL or a simple counter. |

### What needs to be added

1. **Operator config schema extension** (`packages/domain/src/config/schema.ts`):
   - `MarketDataConfigSchema.shape.binance` gets optional `scanner` sub-object with `maxRequestsPerMinute` and `maxConcurrentScans`

2. **Scanner rate limiter** at worker startup (`apps/worker/src/index.ts`):
   - `TokenBucketRateLimiter` from operator config `binance.scanner.maxRequestsPerMinute`

3. **Global scan concurrency semaphore** (new or reuse existing):
   - Simplest: an in-memory counter per worker (since staging has a single worker). Multi-worker Redis semaphore deferred.

4. **Per-actor single-flight** (already needed per plan Phase 2):
   - A flag `scanInProgress` on the actor prevents overlapping scans for the same agent

## Rejected Alternatives

- **Alternative: Put capacity limit in persisted agent config (`technical.maxRequestsPerMinute`)**
  - Rejected: Violates config-layer ownership. Per-agent JSONB is for trading scope, not platform capacity. A malicious or buggy agent could set this to 200 and starve all other agents.

- **Alternative: Add a new `ProviderRequestClass` ('scanner') to the shared coordinator**
  - Rejected: Adds complexity to the provider registry taxonomy. Would require changing the binance budget to include class reservations, affecting all binance consumers. The scanner-specific limiter at the fetch wrapper is simpler and more contained.

- **Alternative: Use the worker's BullMQ scheduler for scan scheduling**
  - Rejected: Adds a queue dependency for what is currently a simple setInterval. Over-engineered for Phase 2. The semaphore + rate limiter approach is sufficient.

- **Alternative: No capacity control — rely on `scanBatchSize` + `scanIntervalMs` alone**
  - Rejected: Per-agent config cannot enforce global limits. 10 scanner-gated agents each with `scanBatchSize=5` and `scanIntervalMs=60000` = 50 RPM, which is within 200 RPM. But nothing prevents a configuration of `scanBatchSize=50, scanIntervalMs=5000` = 600 RPM per agent. A global platform ceiling is required.

## Implementation Consequences

- New operator config schema fields: `marketData.binance.scanner.maxRequestsPerMinute` (default 50), `marketData.binance.scanner.maxConcurrentScans` (default 4)
- New `TokenBucketRateLimiter` instance in worker startup, gated on `sharedMarketDataRegistry` presence
- `fetchCandles` wrapper in `index.ts` acquires the scanner limiter before delegating
- `AgentTradingActor.startTechnicalScanLoop()` tracks `scanInProgress` flag for single-flight
- Capacity-related scan outcomes added to `TechnicalScanState` (`capacityBlocked: true`, `capacityWaitMs`)

## Required Validation

- Schema test: `binance.scanner.maxRequestsPerMinute` defaults when absent, rejects negative values
- Worker test: scanner rate limiter throttles when RPM exceeds cap
- Worker test: scan with `scanInProgress=true` skips and records overlap outcome
- Integration test: capacity calculation proves worst-case RPM ≤ reserved budget
- Admin dashboard smoke: verify binance:regime counters include scanner traffic

## Residual Risk or Follow-Up

- **Multi-worker**: The `maxConcurrentScans` semaphore is per-worker with the in-memory counter. If multiple worker instances run (e.g., Nomad cluster), a Redis-backed semaphore will be needed. Deferred to follow-on.
- **Scan starvation**: If `maxConcurrentScans` is too low and many agents are active, some agents may never scan. A fairness mechanism (round-robin, aging priority) is deferred.
- **scanner vs regime counter indistinguishability**: Scanner candle traffic increments the same `binance:regime` Redis counters as bot regime checks. See Decision 4 for the dashboard treatment of this.

---

# Capacity Calculation

**Capacity policy name:** Scanner-Gated Binance Candle Budget
**Date:** 2026-07-16

**Provider and request class:** binance / regime (shared by bot regime checks + scanner candles)
**Provider budget rpm:** 200
**Reserved scanner budget rpm:** 50 (via dedicated `TokenBucketRateLimiter` from operator config `binance.scanner.maxRequestsPerMinute`)
**Provider max wait ms:** 30,000 (shared binance limiter)

**Active scanner-agent count assumed:** 4 (based on operator config `maxConcurrentScans` default)
**Scan interval ms:** 60,000 (default from `StrictTechnicalConfigSchema` after Phase 1 validation → `TechnicalConfigSchema.parse()` applies this default after strict gate passes)
**Max selected entry candidates per scan:** 5 (default `scanBatchSize`)
**Max open-position exit symbols per scan:** 4 (assumed upper bound — most agents hold ≤ 4 concurrent positions)
**Max candle requests per agent scan:** 9 (5 entry candidates + 4 open-position exits)
**Worst-case scanner candle requests per minute:** 36

**Formula:**
```
<active scanners> * <requests per agent scan> * (60000 / <scan interval ms>) = <rpm>
4 * 9 * (60000 / 60000) = 36 rpm
```

**Pass/fail:** **PASS** — 36 rpm ≤ 50 rpm reserved scanner budget

**Sensitivity analysis:**
- If `scanIntervalMs = 30,000` (faster scan): 4 × 9 × 2 = 72 rpm → **FAIL** (exceeds 50 rpm reservation)
- If `maxConcurrentScans = 8`: 8 × 9 × 1 = 72 rpm → **FAIL**
- If `scanBatchSize = 10` with no open positions: 4 × 10 × 1 = 40 rpm → PASS
- If `scanBatchSize = 20` with no open positions: 4 × 20 × 1 = 80 rpm → **FAIL**

The operator defaults (maxConcurrentScans=4, scanner.maxRequestsPerMinute=50) are chosen to keep worst-case at 36 rpm, leaving 14 rpm headroom within the reservation and 150 rpm reserved for regime checks. The scanner rate limiter provides a hard ceiling — even if agents configure faster scans or larger batches, the limiter enforces the operator-set RPM cap.

**Backpressure and overlap behavior:**
- **Global capacity enforcement**: `TokenBucketRateLimiter` at the `fetchCandles` wrapper gates all scanner candle requests. If the bucket is empty, `acquire()` waits up to `maxWaitMs` (configurable, defaults to 30s). If wait exceeds max, an error is thrown — the scan records a `capacity_exhausted` outcome for that batch.
- **Per-actor single-flight**: `scanInProgress` boolean flag on the actor. If a timer tick fires while a scan is in progress, the tick is skipped and recorded as `overlap_skipped`.
- **Global concurrency enforcement**: `maxConcurrentScans` in-memory counter. Before starting a scan, the actor attempts to acquire a slot. If no slot is available, the scan is skipped with `capacity_unavailable` outcome.

**Validation evidence:**
- `StrictTechnicalConfigSchema` tests: confirm `scanIntervalMs` and `scanBatchSize` are required (already done in Phase 1)
- `TokenBucketRateLimiter` unit tests in `packages/market-data` (existing)
- Scanner rate limiter test: create 4 agents, configure scanBatchSize=5, verify total RPM ≤ 50
- Single-flight test: setInterval fires during active scan → overlap_skipped recorded
- Admin dashboard smoke: binance:regime counter increments during scanner activity
