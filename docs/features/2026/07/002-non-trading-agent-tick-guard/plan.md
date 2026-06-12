# Non-Trading Agent Tick Guard

## Status

`draft`

## Problem

Trading-specific work runs on every tick for every agent, regardless of whether the agent has any trading capability. This caused the `pa-2` agent to crash: it has only `task-management` and `web-access` skills, yet on every tick it fetched Binance candles (for the adaptive-interval gate) and evaluated the BTC regime. When Binance became unreachable, five consecutive `AbortError` timeouts triggered the runtime's consecutive-failure shutdown, killing an otherwise healthy non-trading agent.

Root cause: the call site in `agent.ts` passes `fetchVolatilityCandles` and `evaluateRegime` to `shouldSkipTick` whenever `marketDataRegistry != null`, with no check on whether the agent can trade. The same tick also calls `refreshVenueIntelligence`, `recordRegimeEvaluation`, and `recordPerformanceInputs` unconditionally.

## Goal

Ensure that all trading-specific tick work — candle fetches, regime evaluation, venue intelligence, performance recording — is skipped for agents that have no trading capability. The guard must be derived from the agent's resolved skills, not a hardcoded list of skill IDs.

## Guard

Declare once at module init in `apps/worker/src/agent.ts`, after `runtimeState` is built:

```ts
const hasTradingCapability = runtimeState.runtimeDescriptor.resolvedSkills
  .some((skill) => skill.capabilityFamilies.includes('trading'));
```

`capabilityFamilies: ['trading']` is already set in `packages/domain/src/skills.ts` for `bot-management`, `trading`, and `risk-monitoring`. Any future trading skill just needs the same annotation — no change to this guard.

## Changes Required

### 1. `apps/worker/src/agent.ts` — `shouldSkipTick` dependencies

**Location**: the `shouldSkipTick(...)` call inside `runTick` (~line 1255).

Gate both dependencies on `hasTradingCapability`:

```ts
{
  evaluateRegime: hasTradingCapability && marketDataRegistry
    ? async () => {
        const params: RegimeParams = {};
        return evaluateRegime(params, (symbol) =>
          (recordMarketDataAttempt('binance'), marketDataRegistry!.binance.candles(symbol, { interval: '1h', limit: 200 }))
            .then((r) => r.data),
        );
      }
    : undefined,
  fetchVolatilityCandles: hasTradingCapability && marketDataRegistry
    ? async () => {
        recordMarketDataAttempt('binance');
        return marketDataRegistry!.binance.candles('BTC', { interval: '1h', limit: 24 }).then((r) => r.data);
      }
    : undefined,
}
```

**Effect**: for non-trading agents `shouldSkipTick` receives `undefined` for both dependencies. The `adaptiveInterval` branch falls through to the static current interval, and the regime gate is skipped entirely — no Binance calls.

### 2. `apps/worker/src/agent.ts` — `recordRegimeEvaluation` call

**Location**: immediately after the `shouldSkipTick` call (~line 1292).

Wrap in the guard so regime state is not written into `runtimeState` for agents that never evaluated it:

```ts
if (hasTradingCapability) {
  recordRegimeEvaluation(
    runtimeState,
    skipDecision.regime ?? null,
    skipDecision.regime
      ? { state: 'fresh', provider: 'binance' }
      : { state: 'unavailable', note: marketDataRegistry ? 'regime not evaluated' : 'market-data registry unavailable' },
  );
}
```

### 3. `apps/worker/src/agent.ts` — `refreshVenueIntelligence` call

**Location**: inside `runTick`, after the skip-gate block (~line 1329).

Gate the call and the dependency-availability side-effect:

```ts
if (hasTradingCapability) {
  await refreshVenueIntelligence()
    .then(() => setDependencyAvailability('market-data', true))
    .catch(async (err) => {
      await handleRuntimeFailure('market-data', err);
      recordVenueSignals(runtimeState, []);
    });
} else {
  recordVenueSignals(runtimeState, []);
}
```

For non-trading agents, venue signals are immediately set to empty (as they are now when `marketDataRegistry` is absent) and no external call is made.

### 4. `apps/worker/src/agent.ts` — `recordPerformanceInputs` call

**Location**: immediately after `refreshVenueIntelligence` (~line 1333).

Wrap in the guard — P&L drawdown tracking is meaningless without positions:

```ts
if (hasTradingCapability) {
  recordPerformanceInputs(runtimeState, {
    drawdownPct: sessionMetrics.portfolio.drawdownPct,
    netPnlUsd: (sessionMetrics.portfolio.realizedPnlUsd ?? 0) + (sessionMetrics.portfolio.unrealizedPnlUsd ?? 0),
  });
}
```

### 5. `apps/worker/src/tick-gates.ts` — defensive error handling in `shouldSkipTick`

**Location**: the `adaptiveInterval` assignment at the top of `shouldSkipTick` (~line 165).

Independent of the call-site guard, make `fetchVolatilityCandles` failures non-fatal. A candle timeout is on a non-critical path; the correct fallback is to keep the current interval:

```ts
const adaptiveInterval =
  enabledGates.adaptiveInterval && dependencies.fetchVolatilityCandles
    ? await (async () => {
        try {
          return resolveAdaptiveIntervalMs({
            candles: await dependencies.fetchVolatilityCandles!(),
            baseTickIntervalMs: state.baseTickIntervalMs,
            currentTickIntervalMs: state.currentTickIntervalMs,
          });
        } catch {
          return {
            nextTickIntervalMs:
              state.currentTickIntervalMs ??
              state.baseTickIntervalMs ??
              DEFAULT_BASE_INTERVAL_MS,
          };
        }
      })()
    : { nextTickIntervalMs: state.currentTickIntervalMs ?? state.baseTickIntervalMs ?? DEFAULT_BASE_INTERVAL_MS };
```

This is defence-in-depth: even if `hasTradingCapability` were incorrectly `true`, a Binance timeout would no longer propagate into the tick's failure counter.

## Test Plan

### Unit — `tick-gates.ts`

- `fetchVolatilityCandles` throws → `shouldSkipTick` returns with `nextTickIntervalMs` equal to the current interval (no throw)
- `fetchVolatilityCandles` is `undefined` (non-trading) → same result, no call made

### Unit — `agent.ts` (via `runTick` test helper if available, otherwise integration)

- Agent with only `task-management` skill (`hasTradingCapability = false`):
  - `fetchVolatilityCandles` is never called
  - `evaluateRegime` is never called
  - `refreshVenueIntelligence` is never called (Binance, Hyperliquid, DexScreener)
  - `recordRegimeEvaluation` is never called
  - `recordPerformanceInputs` is never called
- Agent with `bot-management` skill (`hasTradingCapability = true`):
  - All of the above are called as before (existing behaviour unchanged)

## Files Affected

| File | Change |
|---|---|
| `apps/worker/src/agent.ts` | Add `hasTradingCapability` constant; guard items 1–4 |
| `apps/worker/src/tick-gates.ts` | Wrap `fetchVolatilityCandles` call in try/catch (item 5) |
| `apps/worker/src/agent.test.ts` (or new test file) | Unit tests per test plan |
| `apps/worker/src/tick-gates.test.ts` | Unit tests per test plan |

No schema changes. No API changes. No config changes.
