# TICK ERROR HANDLING - Q AND A

## Prompt 1

Ticks should not fail for such reasons -> "shouldSkipTick market-data timeout kills agent after 5 failures".

What do you think?

## Response 1

### How it happened — the full chain

**1. `shouldSkipTick` calls `fetchVolatilityCandles()` uncaught**

In tick-gates.ts, the `adaptiveInterval` calculation awaits `fetchVolatilityCandles()` bare — no try/catch:

```ts
const adaptiveInterval = enabledGates.adaptiveInterval && dependencies.fetchVolatilityCandles
  ? resolveAdaptiveIntervalMs({
      candles: await dependencies.fetchVolatilityCandles(),  // <-- throws on timeout
      ...
    })
  : ...
```

When Binance times out, the `AbortError` propagates out of `shouldSkipTick` entirely.

**2. The throw reaches `runTick`'s catch-all**

In agent.ts, the outer `catch` in `runTick` has a naive source-detection heuristic: if the message looks like Redis, use `'redis'`; otherwise, use `'tool'`:

```ts
} catch (err: unknown) {
  const source =
    err instanceof Error && /redis|xreadgroup|.../.test(err.message)
      ? 'redis'
      : 'tool';   // <-- everything else is 'tool'
  await handleRuntimeFailure(source, err);
}
```

An `AbortError: This operation was aborted` is not a Redis error, so it's classified as source `'tool'`.

**3. `classifyRuntimeError('tool', ...)` maps to `reasonCode: 'tool.failed'`**

In runtime-errors.ts, there's no special case for source `'tool'` — it falls through to the catch-all which always produces `mode: 'degraded'`.

**4. `FailureBackoffController` has a single global counter**

After 5 consecutive degraded ticks — all from the same Binance timeout — `shouldShutdown = true`, and `processRuntimeFailure` calls `shutdown('tool.failed')`.

### The core issue

`shouldSkipTick` serves as a **tick gate** — it decides whether to run the LLM. It is not a tool call; it is infrastructure. Yet it implicitly depends on Binance candle availability (for the adaptive-interval calculation), and its failure is routed into the same failure counter that guards against LLM failures, Redis outages, etc.

Three things are wrong:

1. **`shouldSkipTick` should never throw.** It's a decision function. If `fetchVolatilityCandles` fails, it should return `{ nextTickIntervalMs: currentInterval }` (i.e., hold the current interval) rather than propagating the error. A candle timeout should degrade the adaptive interval, not kill the agent.

2. **The catch-all in `runTick` classifies everything as `'tool'`** including errors from infrastructure like the tick gate, market data pre-fetch, etc. A Binance timeout in `shouldSkipTick` is a `'market-data'` failure, not a tool failure — and as you can see, `classifyRuntimeError('market-data', ...)` correctly maps it to `mode: 'degraded'` with `reasonCode: 'market_data.unavailable'`. This is actually irrelevant here because the real fix is #1, but it is still a misclassification.

3. **The `FailureBackoffController` counter is a blunt instrument.** It conflates network flakiness in a skip-gate with genuine LLM/tool failures. Transient Binance unavailability is a reason to degrade tick quality, not to shut down — especially for an agent that is not even trading.