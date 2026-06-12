# Tick Error Handling

## Status

`draft`

## Purpose

Fix the runtime error-handling model around ticks so non-fatal infrastructure failures do not kill healthy agents, and so failures are classified, counted, and surfaced according to where they happened and what risk they create.

This plan addresses the concerns captured in [000-q-and-a.md](./000-q-and-a.md):

1. `shouldSkipTick` should not be able to fail a tick for non-critical market-data lookups.
2. Tick failures are currently misclassified as `tool.failed` by a catch-all in `runTick`.
3. The failure backoff / shutdown path is too blunt and conflates transient infrastructure degradation with genuinely unsafe runtime failure.

This plan is intentionally broader than the companion non-trading guard plan in [../non-trading-agent-tick-guard/plan.md](../non-trading-agent-tick-guard/plan.md). That companion plan removes trading-only work from non-trading agents. This plan fixes the error semantics even for trading agents.

## Desired Outcomes

After this work:

- Non-critical tick-gate degradation does not terminate the agent.
- Tick errors are classified by subsystem (`tick-gate`, `market-data`, `redis`, `llm`, `tool`, etc.), not by a broad fallback guess.
- Shutdown only happens for explicitly fatal errors, or for repeated failures in categories that truly make the runtime unsafe to continue.
- Transient market-data failures degrade tick quality and observability, but do not poison the same failure counter used for core runtime integrity.
- Logs and heartbeats make it clear whether the runtime is degraded, why, and whether it is still safe to continue.

## Current Problems

### 1. Tick-gate failures can throw out of `shouldSkipTick`

`apps/worker/src/tick-gates.ts` currently awaits `fetchVolatilityCandles()` directly in the adaptive-interval path. If the provider times out, the exception escapes the decision function.

That is the wrong failure boundary. `shouldSkipTick` is infrastructure that decides whether to run the LLM. Failure in a non-essential optimization path should degrade the decision, not abort it.

### 2. `runTick` has a coarse catch-all classifier

`apps/worker/src/agent.ts` catches any thrown error near the end of `runTick` and maps everything non-Redis to source `tool`.

That means:

- tick-gate failures become `tool.failed`
- market-data refresh failures can become `tool.failed`
- future runtime composition or context-build failures could also become `tool.failed`

This destroys the distinction between agent tool misuse and platform/runtime degradation.

### 3. Failure counting is global and undifferentiated

`FailureBackoffController` currently tracks one consecutive-failure counter for the whole tick loop. A sequence of market-data timeouts is treated the same as repeated LLM failures or repeated tool execution failures.

This is too coarse. Some classes of error should:

- only mark the runtime degraded and continue
- back off without counting toward shutdown
- count toward shutdown only within their own subsystem
- immediately terminate if truly fatal

## Scope

### In Scope

- `apps/worker/src/tick-gates.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/runtime-errors.ts`
- `apps/worker/src/runtime-degradation.ts`
- `apps/worker/src/runtime-resilience.ts`
- worker tests covering tick gating and runtime failure handling

### Out of Scope

- Docker event stream false-crash reconciliation
- Broad venue/provider reliability changes
- Reworking all runtime telemetry
- Changing the public API surface

## Plan

### Workstream 1. Make `shouldSkipTick` non-throwing for non-critical paths

#### Goal

Ensure the tick-gate function returns a decision even when adaptive interval or regime helpers degrade.

#### Changes

1. Wrap `fetchVolatilityCandles()` inside `shouldSkipTick` and fall back to the current/base interval if it fails.
2. Decide whether `evaluateRegime()` should also be guarded locally.
   - Recommended: yes, but with different semantics.
   - If regime evaluation fails, treat regime as unavailable and continue into the context-hash path instead of throwing.
3. Keep the return type as `TickSkipDecision`, but consider adding optional degradation metadata if that helps observability:
   - `degraded?: boolean`
   - `degradationReason?: 'adaptive_interval_unavailable' | 'regime_unavailable'`

#### Rationale

`shouldSkipTick` is a decision boundary, not a data-ingestion boundary. The safest default is to continue with a conservative decision when its helper dependencies are unavailable.

### Workstream 2. Split tick phases and classify failures at the phase boundary

#### Goal

Stop relying on one outer catch that guesses the source from the error message.

#### Changes

Refactor `runTick` into explicit guarded phases, each with local classification:

1. **Tick-gate phase**
   - `shouldSkipTick(...)`
   - failures classified as `tick-gate` or `market-data` depending on the exact dependency path
2. **Market-intelligence phase**
   - `refreshVenueIntelligence()`
   - failures classified as `market-data`
3. **LLM scout phase**
   - existing `llm`
4. **LLM judge phase**
   - existing `llm`
5. **Tool execution / context / transport phase**
   - retain `tool`, `redis`, or more specific sources where possible

Instead of a single broad `try/catch`, keep a smaller try/catch around each phase and call `handleRuntimeFailure` with an explicit source.

#### Rationale

The runtime already knows what it is doing at each point. It should not wait until the final catch to infer meaning from an exception string.

### Workstream 3. Introduce a first-class runtime failure source for tick gating

#### Goal

Represent tick-gate degradation explicitly instead of smuggling it through `tool` or `market-data`.

#### Changes

1. Extend `RuntimeFailureSource` in `apps/worker/src/runtime-errors.ts` with:
   - `tick-gate`
2. Add explicit classification rules:
   - `tick-gate` timeout / unavailable dependency -> `mode: 'degraded'`, `reasonCode: 'tick_gate.degraded'`
   - `tick-gate` invariant / programmer error -> possibly `fatal`, but only if we can identify it clearly
3. Update `processRuntimeFailure` and any callers to handle the new source.

#### Rationale

Tick gating is infrastructure with different semantics from market-data provider availability and from user-facing tool execution. Giving it its own source makes logs, metrics, and policy decisions clearer.

### Workstream 4. Replace the single global failure counter with policy-aware counting

#### Goal

Prevent transient degradation in one subsystem from consuming the same shutdown budget as core runtime failures.

#### Changes

Refactor `FailureBackoffController` from a single counter into one of these patterns:

#### Option A — per-source counters

Track consecutive failures by source:

- `llm`
- `redis`
- `market-data`
- `tick-gate`
- `tool`

Then define source-specific shutdown policy:

- `redis`: may warrant shutdown after threshold
- `llm`: may warrant shutdown after threshold depending on retry mode
- `tool`: probably no shutdown by default unless the tool is essential to progress
- `market-data`: backoff + degraded mode, no shutdown by default
- `tick-gate`: never shutdown by default

#### Option B — failure severity buckets

Track counters by semantic bucket:

- `fatal`
- `core-runtime-degraded`
- `advisory-degraded`

Recommended mapping:

- `tick-gate` -> advisory-degraded
- `market-data` -> advisory-degraded
- `tool` -> advisory-degraded or core-runtime-degraded depending on tool role
- `redis` -> core-runtime-degraded
- `llm` -> core-runtime-degraded

#### Recommendation

Prefer **Option A**. The code already classifies by source; source-keyed counters will be easier to reason about and test.

### Workstream 5. Define explicit shutdown policy by source

#### Goal

Make the runtime shutdown decision intentional, not an incidental side effect of a shared counter.

#### Proposed Policy

- `sandbox`: immediate shutdown
- `startup`: immediate shutdown
- `redis`: shutdown after threshold if transport is unusable
- `llm`: shutdown after threshold only if the agent cannot make progress without LLM availability
- `tool`: usually degrade and continue; only shutdown for explicitly essential tool failures if configured
- `market-data`: degrade, back off, continue
- `tick-gate`: degrade, continue, never shutdown by default
- `database`: degrade, continue unless the current agent mode requires DB availability for safety

#### Implementation Shape

Move shutdown eligibility out of `FailureBackoffController` and into policy logic in `processRuntimeFailure`, where both classification and source are already available.

Example shape:

```ts
const failureState = failureBackoff.recordFailure(classification.source);
const shouldShutdown = shouldShutdownForFailure({
  classification,
  failureState,
  runtimeContext,
});
```

### Workstream 6. Improve degraded-mode observability

#### Goal

When the runtime continues after degradation, make that state visible.

#### Changes

1. Ensure `sendHeartbeat('degraded', reasonCode)` is emitted for advisory degradation without implying imminent shutdown.
2. Add structured logs for degraded tick continuation:
   - source
   - reasonCode
   - whether tick continued, skipped, or used fallback
3. If `TickSkipDecision` carries degradation metadata, log it when fallback paths are taken.
4. Consider adding a lightweight runtime metric for fallback activation counts in tick gating.

## Relationship To Non-Trading Guard

The companion plan in [../non-trading-agent-tick-guard/plan.md](../non-trading-agent-tick-guard/plan.md) should land alongside or before this work.

Why:

- It removes unnecessary trading-only market-data work from non-trading agents entirely.
- It reduces the number of cases in which tick-gate market-data degradation can occur.
- It does not replace the need for this plan, because trading agents still need robust fallback semantics.

Recommended sequencing:

1. Land `hasTradingCapability` guard in `agent.ts`
2. Make `shouldSkipTick` locally resilient
3. Refactor failure classification and shutdown policy

## Tests

### `tick-gates.ts`

1. `fetchVolatilityCandles` throws -> no throw; returns current/base interval fallback
2. `evaluateRegime` throws -> no throw; returns fallback decision according to chosen policy
3. non-trading path with no dependencies -> no helper calls, deterministic return

### `runtime-errors.ts` / `runtime-degradation.ts`

1. `tick-gate` source maps to `tick_gate.degraded`
2. `market-data` source remains degraded and non-fatal
3. `tool` source does not absorb unrelated tick-gate failures

### `runtime-resilience.ts`

1. per-source or per-bucket counters behave independently
2. repeated `tick-gate` failures back off but do not shutdown
3. repeated `redis` or configured fatal categories still shutdown as expected

### `agent.ts`

1. trading agent with repeated Binance timeout in tick gate:
   - runtime stays alive
   - heartbeat becomes degraded
   - effective interval backs off if configured
2. non-trading agent with same provider timeout:
   - no candle fetch is attempted once the non-trading guard is in place
3. repeated LLM failures still follow the configured shutdown/backoff path

## Files Likely Affected

| File | Expected change |
|---|---|
| `apps/worker/src/tick-gates.ts` | make helper failures non-throwing; possibly add degradation metadata |
| `apps/worker/src/agent.ts` | phase-specific catches; explicit failure source routing; remove broad `tool` fallback for tick-gate paths |
| `apps/worker/src/runtime-errors.ts` | add `tick-gate` source and classification |
| `apps/worker/src/runtime-degradation.ts` | move shutdown decision toward policy-aware logic |
| `apps/worker/src/runtime-resilience.ts` | support per-source or per-bucket counters |
| `apps/worker/src/*.test.ts` | add coverage for fallback, classification, and shutdown policy |

## Risks

1. If shutdown policy is loosened too much, truly broken runtimes may limp indefinitely.
2. If degradation metadata is added carelessly, the API surface between helpers can become noisy.
3. Refactoring `runTick` phase boundaries may touch several tests and logging assertions.

## Open Decisions

1. Should `evaluateRegime()` fallback to `regime: null`, or should a failed regime evaluation still force a full LLM tick?
2. Should repeated `tool` failures ever shutdown the runtime, or should tool circuits remain the only protection there?
3. Do we want `tick-gate` as a first-class failure source, or do we prefer to keep it under `market-data` with better call-site attribution?

## Recommendation

Implement the minimum safe sequence first:

1. Add `hasTradingCapability` guard at the `agent.ts` call site.
2. Make `shouldSkipTick` resilient to helper failure.
3. Replace broad `tool` fallback classification in `runTick` with phase-local handling.
4. Introduce source-aware failure counters and shutdown policy only after the first two fixes are merged and covered by tests.

That sequence fixes the immediate bug quickly, while leaving room for a clean second pass on the failure model instead of patching it incrementally in the wrong abstraction layer.
