# Decision 5: Smallest Deterministic Integration Harness

**Decision:** 5 — Smallest existing test harness that can deterministically exercise scanner event publication, wake routing, and decision intake
**Status:** accepted
**Date:** 2026-07-16
**Owner:** Implementer agent (Phase 0 research)

## Question

What is the smallest test harness that deterministically exercises the full scanner-gated chain — scanner event publication, wake routing, runtime ingestion, evaluator selection, and decision intake — without relying on live market conditions?

## Inspected Sources

### Existing unit tests (each link in the chain tested in isolation)

- `apps/worker/src/technical-phase.test.ts` — Tests `runTechnicalPhase()` with synthetic candles, mocked deps. Proves the scan engine produces correct `TechnicalPhaseResult` given fixture inputs. 15 tests covering: signal generation, regime gating, exit logic, advisory mode, error handling, maxPositions budget, symbol dedup.

- `apps/worker/src/runtime-composition-technical.test.ts` — Tests `buildTechnicalContextBlock()`, `createRuntimeCompositionState()`, `applyRuntimeMessage()`, `recordTechnicalScan()`. Proves `TechnicalScanState` → markdown context rendering, freshness/staleness checks, signal truncation, and state ingestion from Redis Stream messages.

- `apps/worker/src/hybrid-agent-evaluator.test.ts` — Tests `runHybridEvaluator()` and `canRouteToHybridEvaluator()`. Proves LLM call, structured response parsing, decision submission, stale scan guard, single-shot invariant, scanner_gated vs mixed routing rules. Mocks `callLlmProvider` from `@herobids/llm`.

- `apps/worker/src/scanner-gated-config-validation.test.ts` — Tests `StrictTechnicalConfigSchema` validation. Doesn't cover event/routing.

### Scan completion and event/wake wiring

- `apps/worker/src/agent-trading-actor.ts` lines 1471–1640 (`runTechnicalScan()`) — The single method that orchestrates:
  1. Concurrency gate check (capacity skip)
  2. Single-flight guard (overlap skip)
  3. `runTechnicalPhase(deps)` — scan engine
  4. Builds `TechnicalScanState` from `TechnicalPhaseResult`
  5. Calls `this.deps.onTechnicalScanComplete(agentId, scan)` — event publication callback
  6. If signals exist AND `isHybridMode`: calls `this.deps.emitAgentWake(agentId, payload)` — wake routing callback
  7. Stores `this.lastTechnicalScan = scan`

- `apps/worker/src/agent-trading-actor.ts` lines 153–155 (deps interface):
  ```typescript
  onTechnicalScanComplete?: (agentId: string, scan: TechnicalScanState) => void | Promise<void>;
  emitAgentWake?: (agentId: string, payload: AgentWakePayload) => Promise<void>;
  ```
  Both are **injected callbacks** — designed for testability.

- `apps/worker/src/index.ts` lines 943–948 (wiring):
  ```typescript
  onTechnicalScanComplete: (scanAgentId, scan) => {
    eventPublisher.emitTechnicalScanCompleted(scanAgentId, scan).catch(...)
  },
  emitAgentWake: (wakeAgentId, payload) => eventPublisher.emitAgentWake(wakeAgentId, payload),
  ```

### Event publisher (Redis layer — downstream of the actor)

- `apps/worker/src/agents/instance-event-publisher.ts` lines 81–87:
  - `emitAgentWake()` → `this.publish(agentId, MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE, payload)` → Redis Stream `XADD`
  - `emitTechnicalScanCompleted()` → `this.publish(agentId, 'agent.technical.scan_completed', payload)` → Redis Stream `XADD`

- The `InstanceEventPublisher` is **not** injected into `AgentTradingActor`. It is wired in `index.ts` as the concrete implementation behind the callback interfaces. The actor never touches Redis directly for scan events.

### Runtime ingestion of events

- `apps/worker/src/runtime-composition.ts` lines 1935–1943 (`applyRuntimeMessage()`):
  ```typescript
  const scan = payload as unknown as TechnicalScanState;
  recordTechnicalScan(state, scan);
  ```
- `apps/worker/src/runtime-composition.ts` lines 1662–1668 (`recordTechnicalScan()`):
  ```typescript
  state.metrics.lastTechnicalScan = scan;
  ```

### Evaluator routing

- `apps/worker/src/hybrid-agent-evaluator.ts` lines 23–47 (`canRouteToHybridEvaluator()`):
  - `scanner_gated` + scanner wake → routes to hybrid evaluator
  - `scanner_gated` + non-scanner wake → falls through to scout/judge
  - `mixed` + scanner wake + fresh scan → routes to hybrid evaluator

### Redis mock patterns in the codebase

- `apps/worker/src/market-intelligence/wake-scheduler.test.ts` — `makeRedisMock()`: full in-memory Redis with `Map`-backed storage, `scan()`, `zadd()`, `zscore()`, `hset()`, `hgetall()`. Used for testing Redis-dependent components directly.

- `apps/worker/src/actor-health-publisher.test.ts` — `makeRedis()`: simpler `vi.fn()` mock with `set`, `del`, `get`. Used when only basic Redis operations are tested.

### AgentTradingActor constructor cost

- `apps/worker/src/agent-trading-actor.ts` lines 250–330 — `AgentTradingActorDeps` interface. The actor requires: executor, venuePort, logger, fillRepo, planRepo, orderRepo, decisionRepo, balanceSnapshotRepo, backtestingRepo, reconciliationRepo, agentId, sessionId, venueType, executionMode. Plus optional deps including the scan-related ones.

- Constructing a real `AgentTradingActor` for testing requires satisfying ~15 required deps, most of which are venue/repo infrastructure. This is disproportionate overhead for testing the scan→event→wake chain.

### runTechnicalPhase dependency injection pattern

- `apps/worker/src/technical-phase.ts` lines 1–96 — `TechnicalPhaseDeps` interface and `runTechnicalPhase()` function. The entire scan engine is a standalone function with all deps injected as an interface. This pattern was chosen for testability and works well — `technical-phase.test.ts` has full coverage without any actor, venue, or Redis infrastructure.

## Decision

### Two-layer harness, no Redis, no live market

The smallest deterministic integration harness has two layers. Both use vitest with mocked dependencies — no Redis, no live venue, no real LLM.

---

### Layer A: Scan-completion-to-callback chain (new test file)

**Extract the scan-completion logic** from `AgentTradingActor.runTechnicalScan()` into a standalone function following the existing `runTechnicalPhase()` pattern. The function takes the phase result plus callback deps and produces the `TechnicalScanState` + invokes callbacks.

```typescript
// Proposed signature (in new file or exported from agent-trading-actor.ts)
export function completeTechnicalScan(params: {
  phaseResult: TechnicalPhaseResult;
  technicalConfig: TechnicalConfig;
  agentId: string;
  isHybridMode: boolean;
  onTechnicalScanComplete?: (agentId: string, scan: TechnicalScanState) => void | Promise<void>;
  emitAgentWake?: (agentId: string, payload: AgentWakePayload) => Promise<void>;
  onJournalEvent?: (event: { type: string; payload?: Record<string, unknown> }) => void;
}): TechnicalScanState
```

**What this function does** (currently inline in `runTechnicalScan()` lines 1556–1635):
1. Builds `TechnicalScanState` from `TechnicalPhaseResult` (maps fields, computes `eligibleCount`/`fetchedCount`)
2. Journals `scanner.data_unhealthy` when `fetchedCount === 0 && eligibleCount > 0`
3. Calls `onTechnicalScanComplete(agentId, scan)` to publish the scan event
4. If signals or exit advisories exist AND `isHybridMode`: calls `emitAgentWake(agentId, payload)` with structured `AgentWakePayload`
5. Returns the `TechnicalScanState`

**Tests for Layer A** (vitest, no Redis, no venue):

| Test case | Setup | Assertions |
|---|---|---|
| Actionable signals → scan_completed + wake emitted | Fixture candles (uptrend), hybrid mode, no open positions | `onTechnicalScanComplete` called with `TechnicalScanState` containing `signalsGenerated > 0`, `symbolOutcomes` populated. `emitAgentWake` called with `source: 'scanner'`, `context.signalCount > 0`, `priority: 'normal'` |
| Exit advisories only + hybrid → wake emitted with high priority | Overbought candles, open position, advisory mode, autonomousExit disabled | `emitAgentWake` called with `priority: 'high'`, `context.signalCount: 0`, exit advisory symbols in `reason` |
| No signals, no exit advisories → scan_completed but NO wake | Flat candles (no trend), no open positions, hybrid mode | `onTechnicalScanComplete` called. `emitAgentWake` NOT called |
| Not hybrid mode → scan_completed but NO wake | Same as actionable signals test, but `isHybridMode: false` | `onTechnicalScanComplete` called. `emitAgentWake` NOT called |
| Data unhealthy → journal event emitted | All candle fetches return unsupported, no eligible data | `onJournalEvent` called with `type: 'scanner.data_unhealthy'`. `onTechnicalScanComplete` called. No wake |
| Overlap skip → scan_completed with overlapSkipped | Simulate overlap state (not testing the guard itself, testing the callback behavior) | `onTechnicalScanComplete` called with `overlapSkipped: true`, zero provider data. No wake |
| Capacity skip → same as overlap skip | Simulate capacity exhaustion state | `onTechnicalScanComplete` called with `overlapSkipped: true`. No wake |

**What is real vs mocked in Layer A:**

| Component | Real/Mocked | Why |
|---|---|---|
| `runTechnicalPhase()` | Real (already tested) | Deterministic with fixture inputs |
| `scanCandidates()` / `scoreCandidate()` | Real | Pure functions from `@herobids/strategy`, no I/O |
| `discoverCandidates` | Mocked → fixture `DiscoveredInstrument[]` | No live venue discovery |
| `fetchCandles` | Mocked → fixture `PriceCandle[]` | Uptrend candles produce known signals; flat/overbought produce known outcomes |
| `evaluateRegime` | Mocked → fixture `RegimeResult` | Control pass/block deterministically |
| `submitDecision` | Mocked (`vi.fn()`) | Verify call count, not actual venue submission |
| `getOpenPositions` | Mocked → `[]` or fixture positions | Control exit-advisory scenarios |
| `onTechnicalScanComplete` | Mocked (`vi.fn()`) | Verify called with correct shaped `TechnicalScanState` |
| `emitAgentWake` | Mocked (`vi.fn()`) | Verify called/not-called with correct payload |
| `onJournalEvent` | Mocked (`vi.fn()`) | Verify data-unhealthy journaling |
| `generateDecisionId` | Real counter | Pure, no I/O |
| `logger` | Mocked (`vi.fn()`) | No log output needed |

**Redis is NOT needed** in Layer A because `onTechnicalScanComplete` and `emitAgentWake` are injected callbacks. The test verifies the callbacks are invoked with correct payloads — actual Redis Stream `XADD` is the concern of `InstanceEventPublisher` (tested separately or in integration/e2e).

---

### Layer B: Runtime ingestion + evaluator routing (extend existing tests)

**Extend `runtime-composition-technical.test.ts`** with tests that verify:

1. `recordTechnicalScan(state, scan)` → `state.metrics.lastTechnicalScan` is set correctly
2. A fresh `TechnicalScanState` in the runtime state enables `canRouteToHybridEvaluator()` → `true` (for scanner_gated + scanner wake)
3. A stale scan disables routing → `false`

**Extend `hybrid-agent-evaluator.test.ts`** with one additional test:
4. Full chain from `recordTechnicalScan` → `canRouteToHybridEvaluator` → `runHybridEvaluator` → `submitDecision` called with correct instrumentId, using mocked `callLlmProvider`

These tests already exist in some form — the extension is to verify the handoff between `recordTechnicalScan` (ingestion) and `canRouteToHybridEvaluator` (routing decision).

**What is real vs mocked in Layer B:**

| Component | Real/Mocked | Why |
|---|---|---|
| `recordTechnicalScan()` | Real | Pure function, already tested |
| `canRouteToHybridEvaluator()` | Real | Pure function, already tested |
| `runHybridEvaluator()` | Real | Already tested with mocked LLM |
| `callLlmProvider` | Mocked | Already done in `hybrid-agent-evaluator.test.ts` |
| `submitDecision` | Mocked (`vi.fn()`) | Already done in `hybrid-agent-evaluator.test.ts` |
| `RuntimeCompositionState` | Real | Created via `createRuntimeCompositionState()` |
| `TechnicalScanState` | Fixture | Built via `makeScan()` helper |

---

### What this harness does NOT cover (deferred to integration/e2e)

| Concern | Why out of scope |
|---|---|
| Redis Stream `XADD` (actual Redis I/O) | Tested at callback level. Redis transport is `InstanceEventPublisher` concern, not scanner chain concern |
| Real LLM provider call | LLM is non-deterministic. Mocked in unit tests; live LLM smoke is a separate release gate (Decision 6) |
| Real venue candle fetch | Requires live market + API keys. Covered by live-provider smoke (Decision 6) |
| Tick loop scheduling (setInterval → scan → wake → tick) | Requires worker process + Redis + session manager. E2E concern |

### Why not test through AgentTradingActor directly

`AgentTradingActor` has ~15 required constructor dependencies (executor, 7 repos, venue port, etc.). Constructing a real actor just to test the scan→callback chain introduces disproportionate mock setup without adding fidelity — the scan logic is already isolated behind injected callbacks. Extracting the scan-completion function follows the established `runTechnicalPhase()` pattern and keeps tests focused.

## Rejected Alternatives

- **Full AgentTradingActor construction with mocked venue/repos**: Prohibitively complex. The actor's `start()` method initializes venue connections, reconcilers, equity trackers, and position recovery — all irrelevant to scan event testing. Risk of brittle tests that break on unrelated actor changes.

- **Redis-dependent test with `makeRedisMock()`**: The `InstanceEventPublisher` is not injected into the actor. Testing at the Redis Stream level would require wiring up the full `index.ts` composition root or a substantial subset of it. The callback injection pattern already exists specifically to avoid this.

- **End-to-end test with real worker process**: Requires a running Redis, PostgreSQL, and worker binary. Too heavy for deterministic CI. Appropriate for staging smoke (Decision 6), not for the deterministic harness.

- **Test only at `runTechnicalPhase()` level (no callback verification)**: Already exists in `technical-phase.test.ts`. Does not verify that the scan→event→wake handoff happens — that's the specific gap this harness addresses.

## Implementation Consequences

1. **New standalone function**: Extract `completeTechnicalScan()` (or similar) from `AgentTradingActor.runTechnicalScan()` lines 1556–1635 into a pure function in a new or existing module. The function signature exposes the minimal deps needed for the scan→callback chain.

2. **`AgentTradingActor.runTechnicalScan()` refactored**: Replace the extracted inline logic with a call to the new function. No behavioral change.

3. **New test file**: `apps/worker/src/scan-completion.test.ts` (or similar) with ~7 test cases covering the scan outcome matrix (see Layer A table above).

4. **Extended existing tests**: Add 1–2 tests to `runtime-composition-technical.test.ts` for `recordTechnicalScan` → routing handoff. Add 1 test to `hybrid-agent-evaluator.test.ts` for ingestion→routing→evaluator chain.

5. **No new dependencies**: vitest, `vi.fn()`, fixture helpers already exist. No Redis mock needed for Layer A.

## Required Validation

```bash
pnpm --filter @herobids/worker test
pnpm lint
```

Plus specific test assertions:
- `onTechnicalScanComplete` called with `TechnicalScanState` where `signalsGenerated > 0`, `symbolOutcomes.length > 0`, `discovered > 0`
- `emitAgentWake` called with `source: 'scanner'`, `context.signalCount > 0`
- `emitAgentWake` NOT called when `signalsGenerated === 0` and no exit advisories
- `emitAgentWake` NOT called when `isHybridMode === false`
- `emitAgentWake` called with `priority: 'high'` when exit advisories present
- `onJournalEvent` called with `type: 'scanner.data_unhealthy'` when `fetchedCount === 0 && eligibleCount > 0`

## Residual Risk or Follow-up

- **Extraction may surface subtle coupling**: The scan-completion logic currently references `this.deps`, `this.logger`, and instance fields (`this.lastTechnicalScan`). Extraction must preserve the exact same behavior — the extracted function receives all state as parameters. The refactor should be mechanical, not semantic.

- **`onJournalEvent` callback shape**: Currently typed as `(event: { type: string; payload?: Record<string, unknown> }) => void` in `AgentTradingActorDeps` but `emitJournalEvent` takes `{ journalType: string; timestamp?: string; detail?: string }`. The existing code at line 1585 already bridges this mismatch. Extraction should preserve the existing bridge behavior.

- **The `completeTechnicalScan` function should live in a module that doesn't import venue/repo infrastructure** to avoid pulling heavyweight deps into the test. Placing it in `technical-phase.ts` or a new `scan-completion.ts` alongside `runTechnicalPhase()` is preferred.
