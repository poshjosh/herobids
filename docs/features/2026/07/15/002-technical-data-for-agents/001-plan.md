# Plan: Wire Technical Scanner Data Inputs into AgentTradingActor

**Goal:** Hybrid/scanner_gated agents receive pre-scored signals and begin trading.

**Files touched:** index.ts only (integration wiring). No new files. No schema changes.

### Step 1: Implement `discoverCandidates`

Wrap `providerRegistry.hyperliquid.assetContexts()` which returns cached `HyperliquidAssetContext[]` (symbol, volume24hUsd, priceChange24hPct, openInterest):

```typescript
const discoverCandidates = async (filters: FilterConfig) => {
  if (!sharedMarketDataRegistry) return [];
  
  const contexts = await sharedMarketDataRegistry.hyperliquid.assetContexts();
  
  let results = contexts.map((ctx) => ({
    symbol: ctx.asset,
    instrumentId: `${ctx.asset}-PERP`,
    volume24hUsd: ctx.volume24hUsd ?? undefined,
    priceChange24hPct: ctx.priceChange24hPct ?? undefined,
  }));

  // Apply filters
  if (filters.minVolume24hUsd != null) {
    results = results.filter((r) => (r.volume24hUsd ?? 0) >= filters.minVolume24hUsd!);
  }
  if (filters.symbols?.length) {
    results = results.filter((r) => filters.symbols!.includes(r.symbol));
  }
  if (filters.excludeSymbols?.length) {
    results = results.filter((r) => !filters.excludeSymbols!.includes(r.symbol));
  }
  
  return results;
};
```

**Existing infra reused:** `sharedMarketDataRegistry.hyperliquid.assetContexts()` — already fetched and cached by the market-data coordinator every 30s. Zero additional API calls.

### Step 2: Implement `fetchCandles`

Wrap `VenueCandleFetcher` (already instantiated for bots):

```typescript
const agentCandleFetcher = sharedMarketDataRegistry
  ? new VenueCandleFetcher(
      sharedMarketDataRegistry.configs.binance,
      null, // swap not needed for Hyperliquid orderbook agents
      'orderbook',
    )
  : undefined;

const fetchCandles = agentCandleFetcher
  ? async (symbol: string, interval: string, limit: number) => {
      return agentCandleFetcher.fetch(symbol, { interval, limit });
    }
  : undefined;
```

**Existing infra reused:** `VenueCandleFetcher` uses Binance REST API — same as bots. Hyperliquid perp prices track spot closely enough for indicator computation.

### Step 3: Extract `technicalConfig` and wire all three

In the `AgentTradingActor` constructor call (~line 777), add:

```typescript
const technicalConfig = (agent?.unifiedConfig?.technical as TechnicalConfig | undefined) ?? undefined;

actor = new AgentTradingActor({
  // ... existing 40+ deps unchanged ...
  technicalConfig,          // ← NEW
  discoverCandidates,       // ← NEW
  fetchCandles,             // ← NEW
});
```

`TechnicalConfig` is already validated by Zod at the API boundary — the shape in `unified_config.technical` matches exactly what `runTechnicalPhase()` expects.

### Edge Cases

| Case | Handling |
|------|----------|
| `sharedMarketDataRegistry` undefined (no market data configured) | `discoverCandidates` returns `[]`, `fetchCandles` is `undefined` → scanner loop silently skipped (existing behavior) |
| Agent has NULL `technical` config (like tmomentum-d) | `technicalConfig` is `undefined` → scanner loop silently skipped |
| Agent is `intelligence` mode (tsonnet) | `isHybridMode: false` → scan loop runs but wake only emitted if `isHybridMode && signals.length > 0` → no wake for intelligence agents |
| `assetContexts()` fails (Hyperliquid API down) | Exception caught by `runTechnicalScan()` → logged, retried on next interval |
| Binance candle fetch fails for a symbol | Caught by `runTechnicalPhase()` → symbol skipped, logged, batch continues |

### What Does NOT Change

- No schema changes
- No DB migrations
- No new dependencies
- No agent container changes
- No changes to technical-phase.ts, agent-trading-actor.ts, agent.ts, or hybrid-agent-evaluator.ts
- Intelligence-mode agents (tsonnet) completely unaffected

### Verification

| Check | How |
|-------|-----|
| Worker starts without errors | `docker logs herobids-worker-1` — no new errors |
| Scanner loop starts for hybrid agents | Log: "Technical scan loop started" with intervalMs |
| Signals discovered and scored | Log: "Technical phase: advisory mode" with signalCount |
| Scanner wake emitted | Agent log: "Hybrid agent: routing to single-shot evaluator (scanner wake)" |
| LLM makes decisions | Agent log: `submit_decision` tool calls (or hybrid evaluator JSON decisions) |
| Decisions appear in DB | `SELECT COUNT(*) FROM decisions WHERE actor_type = 'agent' AND actor_id != '81d62e72...'` |
| `pnpm lint` passes | No new type errors |
| Existing tests still pass | `pnpm test` — no regressions |