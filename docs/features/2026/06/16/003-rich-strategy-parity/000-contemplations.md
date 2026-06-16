## Contemplation: Rich Strategy-Stack Parity

### Architectural Gap Summary

| Capability | Old Repo | HeroBids Status |
|---|---|---|
| EMA, ADX, VWAP, Market Structure | indicators.ts | ✅ Already in indicators.ts |
| Regime evaluation | regime.ts | ✅ Already in regime.ts |
| RSI | indicators.ts | ❌ Missing |
| MACD (line/signal/histogram) | indicators.ts | ❌ Missing |
| Support/Resistance + breakout | indicators.ts | ❌ Missing |
| Volume trend ratio | indicators.ts | ❌ Missing |
| Swing detection + CHOCH | indicators.ts | ❌ Missing |
| Sentiment (Twitter + circuit breaker) | sentiment.ts | ❌ Missing |
| Mechanical Engine | mechanical-engine.ts | ❌ Missing (current `MomentumStrategy` is trivial lookback-only) |
| Hybrid Engine | hybrid-engine.ts | ❌ Missing |
| Playbook Validator | playbook-validator.ts | ⚠️ Partially covered by existing `RiskConfigSchema` |
| Confidence aggregation + weighted factors | momentum-analyzer.ts | ❌ Missing |
| Signal bias (trend-following / mean-reverting) | Config param | ❌ Missing |
| Strategy dispatcher/factory | dispatcher.ts | ✅ Exists as `createStrategy()` in worker — just needs new cases |

---

### Decision 1: Strategy Port — Do We Need to Change It?

**Old repo:** `StrategyEngine.analyze(context: StrategyContext)` takes a full context with **multiple candidates** and returns **multiple decisions**.

**HeroBids:** `Strategy.evaluate(snapshot: MarketSnapshot, config)` takes a single snapshot for ONE symbol, returns ONE decision.

**Resolution:** Keep the existing port unchanged. In HeroBids, multi-candidate scanning is the **agent's** job (it uses tools to discover tokens, then creates bots or submits decisions). A bot is already scoped to one instrument. The mechanical/hybrid strategies evaluate ONE instrument deeply — they don't need to scan across candidates.

This simplifies the design significantly vs the old repo.

---

### Decision 2: How Does the Mechanical Strategy Get Candle Data?

The current `MarketSnapshot` only carries `{ symbol, price, data?, timestamp }`. A full technical analysis needs candle history.

**Options explored:**
- A) Stuff candles into `snapshot.data` → weak typing, messy
- B) Strategy fetches its own candles via injected port → matches existing patterns (`evaluateRegime` does this)
- C) Enrich `MarketSnapshot` to include `candles?: PriceCandle[]` → breaks interface for simpler strategies

**Recommendation:** Option B — inject a `CandleFetcher: (symbol: string, interval: string, limit: number) => Promise<PriceCandle[]>` at construction time. The `LlmStrategy` already does I/O (calls LLM), so impure strategies are an established pattern. The TradingActor already has access to candle sources and passes dependencies via constructor injection.

---

### Decision 3: Signal Bias — Where Does It Live?

The old repo has `signalBias: 'trend-following' | 'mean-reverting'` that flips how RSI and CHOCH are interpreted.

**Resolution:** This is a strategy config parameter in `MechanicalParamsSchema`. It goes into the instance config stored in Postgres JSONB.

---

### Decision 4: Sentiment — Include or Defer?

The old repo used Twitter API with a circuit breaker (auto-disable after 3× 429s or 402).

**Resolution:** Include as an optional, pluggable port. Define `SentimentProvider` interface that can be null. If not configured, sentiment checks are skipped (no hard rejection, no confidence boost). This avoids requiring Twitter API credentials for the strategy to function.

The sentiment port:
```typescript
interface SentimentProvider {
  getScore(symbol: string, tokenName?: string): Promise<SentimentResult | null>;
}
```

Inject at construction alongside the candle fetcher.

---

### Decision 5: Playbook Validator — Separate Layer or Fold Into Risk Gate?

Old repo's playbook validates: min liquidity, max positions/day, avoid parabolic entries.

**Resolution:** These are safety/risk rules, not strategy logic. HeroBids already has:
- `minSwapTokenLiquidityUsd` in `RiskConfigSchema` → ✅ covers min liquidity
- `maxOpenPositions` → ✅ partially covers position limits

**Recommend extending RiskConfigSchema** with `maxNewPositionsPerDay` and `avoidParabolicMovePct` rather than building a separate validator. No new abstraction needed.

---

### Decision 6: Regime Gate for Bots

HeroBids already evaluates regime for agents (runtime-composition.ts provides regime data in agent context). But bots currently skip regime checks.

**Resolution:** Defer. The regime gate is already available infrastructure. Adding it to the bot trading cycle is a one-line check in `TradingActor.tick()` — can be done later as a follow-up. Not part of core strategy parity.

---

### Decision 7: Hybrid Strategy — How Does Composition Work?

Old repo: `HybridEngine` runs momentum pre-filter on candidates, then passes survivors to `LlmEngine`.

In HeroBids (single-instrument context): the hybrid strategy would:
1. Run technical checks (RSI, MACD, volume, etc.) on the single instrument
2. If technicals PASS → invoke LLM for final conviction + reasoning
3. If technicals FAIL → return null (hold) — no LLM cost

This is simpler than the old repo's multi-candidate filter but achieves the same cost-saving goal: avoid expensive LLM calls when technical conditions aren't met.

**Resolution:** `HybridStrategy` composes `MechanicalStrategy` (as pre-check) + `LlmStrategy` (as final judgment). The mechanical pass/fail gates the LLM call.

---

### Decision 8: Config Schema Design

New `StrategyConfigSchema` members needed:

```typescript
// MechanicalParamsSchema — full indicator suite
z.object({
  type: z.literal('mechanical'),
  params: MechanicalParamsSchema  // candleInterval, RSI, MACD, volume, VWAP, 
                                   // S/R, CHOCH, priceAction, confidence weights,
                                   // signalBias, sentiment enabled
})

// HybridParamsSchema — mechanical + LLM combined
z.object({
  type: z.literal('hybrid'),
  params: HybridParamsSchema  // mechanical config + llm config
})
```

---

### Decision 9: Statefulness

**Question:** Should the mechanical strategy maintain internal state across evaluations?

**Resolution:** Stateless. Fetch candles each tick and recompute everything. This is what the old repo does (no inter-tick indicator state). Benefits: simpler, no state corruption on restart, fully testable with deterministic candle inputs.

---

### Decision 10: Package Placement

| Component | Package |
|---|---|
| RSI, MACD, S/R, volume trend, CHOCH | indicators.ts |
| SentimentProvider port | `packages/domain/src/ports/sentiment.ts` |
| MechanicalStrategy, HybridStrategy | src |
| Config schemas | schema.ts |
| Factory update | index.ts |

---

### Implementation Phases

**Phase 1: Indicators** — Add RSI, MACD, support/resistance, volume trend, swing detection, CHOCH to indicators.ts. Pure functions, easy to unit test.

**Phase 2: Sentiment Port** — Define `SentimentProvider` port in domain, implement Twitter adapter (optional), with circuit breaker.

**Phase 3: MechanicalStrategy** — Single-instrument deep analyzer using all indicators. Needs `CandleFetcher` and optional `SentimentProvider`. Config: `MechanicalParamsSchema`.

**Phase 4: HybridStrategy** — Composes mechanical pre-check + LLM judgment. If technicals fail → hold without LLM cost.

**Phase 5: Schema & Factory** — Add 'mechanical'/'hybrid' to `StrategyConfigSchema`, update `createStrategy()`.

---

### Open Questions (Need Resolution Before Implementation)

1. **Candle source for bots** — The TradingActor currently has `fetchPrice()` for snapshots. Does it also have a candle-fetching capability? If not, we need to wire one in. *(Likely answer: the market-data package has `fetchBinanceCandles`, `fetchGeckoTerminalCandles` — we need to expose a unified candle fetcher and inject it into TradingActor.)*

2. **Instrument vs Token** — The old repo operated on token addresses (DeFi swaps). HeroBids has both orderbook instruments (ETH-PERP on Hyperliquid) and swap tokens. How do mechanical indicators apply to perps vs swaps? *(Likely answer: identically — candles are candles regardless of venue. The candle source differs but the indicator math is the same.)*

3. **Position size for mechanical strategy** — The old repo didn't determine position size (it returned conviction and the risk layer sized it). HeroBids' Decision requires `targetSize`. *(Likely answer: mechanical strategy config includes `positionSize` like the existing momentum strategy, or we add percentage-of-portfolio sizing later.)*

4. **Sentiment data source** — Is Twitter/X API still viable, or should we consider alternative sentiment sources (LunarCrush, Santiment, on-chain social)? *(Likely answer: make it pluggable via the port. Start with a simple implementation or even a no-op. The old repo's Twitter integration is a reference implementation.)*

---

### Risk Assessment

- **Low risk:** Indicators are pure math, well-understood, easy to test
- **Medium risk:** CandleFetcher wiring — need to confirm candle data availability in bot context
- **Low risk:** Config schema changes — additive, backward compatible
- **Low risk:** Hybrid composition — two existing strategies composed, straightforward

---

### What This Does NOT Include (Out of Scope)

- Multi-candidate scanning at strategy level (agent's job)
- Bot regime gate enforcement (defer — infrastructure exists)
- New risk gate rules for playbook (defer — risk layer already works)
- Backtesting support for new strategies (follows naturally from the factory pattern)