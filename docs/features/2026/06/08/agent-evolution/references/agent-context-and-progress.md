# Agent Context Prioritization and Progress

Ensure agents receive the best possible data in their prompt context for making trading decisions, and always know how well they are performing relative to their objective.

---

## Background

Currently `buildTickUserContext` in `runtime-composition.ts` gives the agent minimal info: position side, P&L summary, symbol + price. The agent must waste tool calls (each costing output tokens + another round-trip) to get basic market data that should already be in context.

Additionally, agents have no built-in sense of "how am I doing?" relative to their goal. Without a progress signal, agents cannot self-correct or know when to be more conservative.

---

## Scope

### In scope

- What data must be in the agent's tick context (pre-computed, not tool-fetched)
- Ordering rules for context blocks (static first, dynamic last, progress last)
- Trimming policy under constrained context windows
- Progress score / objective tracking injected at end of prompt
- Venue-aware context assembly (different data for perps vs. DEX)

### Out of scope

- How data is fetched (covered by market-data-provider-strategy.md)
- Tool definitions and schemas (covered by skill authoring)
- Cost optimization of the prompt itself (covered by agent-cost-reduction-pipeline.md)

---

## 1. Required Context Blocks

Every agent tick prompt should contain these blocks in order:

### Static section (cacheable)

1. **System identity** — Agent ID, goal, execution mode
2. **Skill definitions** — Available tools with schemas
3. **Constraints** — Guardrails, daily loss limit, max bots, slippage caps
4. **Playbook / strategy rules** — If any are configured

### Dynamic section (changes per tick)

5. **Capability readiness** — Which trading bindings are active and ready
6. **Portfolio summary** — Total exposure, net delta, unrealized P&L, realized P&L today, drawdown from peak, available capital
7. **Open positions** — Per-position: symbol, side, size, entry price, unrealized P&L, hold duration
8. **Market regime** — ADX, EMA alignment, structure, VWAP status, choppy flag (pre-computed via `evaluateRegime()`)
9. **Venue-specific intelligence** — See section 3 below
10. **Recent events** — Platform messages, decision outcomes, execution results (last N)
11. **Managed bots summary** — Bot status, recent performance

### Terminal section (always last)

12. **Progress score** — See section 4 below

---

## 2. Ordering and Trimming Policy

### Ordering rules

- Static content FIRST (maximizes provider prompt cache hit rate).
- Within dynamic, order by decision relevance: portfolio → regime → positions → venue data → events.
- Progress score ALWAYS last (it is the final thing the agent reads before responding).

### Trimming under constrained context

When total context approaches the model's context window limit, trim in this order (least valuable first):

1. Older conversation history messages (keep most recent 10)
2. Tool result content (truncate to `maxToolResultChars`)
3. Managed bots detail (collapse to count + aggregate P&L)
4. Recent events (keep only last 3)
5. Venue-specific intelligence (keep only for instruments with open positions)

Never trim:
- System identity and goal
- Active position data
- Progress score
- Regime summary (one line)

---

## 3. Venue-Aware Context Assembly

Different asset classes need different data. The context assembler should detect which venues/instruments the agent is trading and include the relevant subset.

### Perps context (Hyperliquid / Bybit)

| Data point | Source | Why it matters |
|---|---|---|
| Funding rate | Venue REST (free) | Short-vs-long signal |
| Open interest | Venue REST (free) | Crowding / sentiment |
| Mark vs index price | Venue WS / REST | Basis trade signal |
| Recent liquidations | Bybit REST | Where leverage is breaking |
| Orderbook imbalance | Public WS | Short-term directional pressure |
| 24h volume | WS ticker | Activity level |

### DEX context (Jupiter / 1inch)

| Data point | Source | Why it matters |
|---|---|---|
| Token liquidity | DexScreener / GeckoTerminal | Position sizing constraint |
| Pool age | Discovery response | Rug risk indicator |
| 24h volume | DexScreener | Activity / interest |
| Price change 24h | DexScreener | Momentum signal |
| Holder count (if available) | Birdeye / CMC enrichment | Distribution risk |
| Risk level (if available) | CMC enrichment | Scam detection |

### Assembly logic

```
if agent has perps bindings:
  include perps context block

if agent has DEX/swap bindings:
  include DEX context block

if agent has both:
  include both, perps first (higher capital exposure)
```

---

## 4. Progress Score

### Problem

Agents do not know how well they are performing relative to their objective. Without this signal, they cannot self-correct, become more conservative when losing, or recognize success.

### Solution

Inject a progress block at the END of every tick prompt:

```
## Performance Summary
- Net P&L (after estimated costs): +$47.20
- LLM cost this session: $3.15
- Estimated server cost: $0.80
- Net profit after all costs: +$43.25
- Win rate: 6/9 (67%)
- Session duration: 4h 23m
- Performance score: 7/10
```

### Score calculation

The score (1–10) is computed from:
- Net P&L relative to starting capital (weight: 40%)
- Win rate (weight: 20%)
- Risk-adjusted return (Sharpe-like, weight: 20%)
- Drawdown from peak (weight: 20%)

Thresholds:
- 1–3: Significant loss or high drawdown
- 4–5: Flat or slightly negative
- 6–7: Positive, moderate performance
- 8–9: Strong performance
- 10: Exceptional (reserved for >5% return with <2% drawdown)

### Cost attribution

To show "net profit after costs," track:
- `tokensUsed` from each LLM call (already tracked in `callLlmProvider` response)
- Multiply by model pricing (maintain a simple lookup table)
- Accumulate per session in `RuntimeSessionMetrics`
- Server cost is a configurable constant (e.g., $0.02/hour per agent container)

---

## 5. Data Freshness Requirements

| Data point | Max staleness | Action if stale |
|---|---|---|
| Position data | 0 (real-time via WS) | Flag degraded in context |
| Ticker price | 5s | Use last known, note staleness |
| Funding rate | 5 min | Acceptable (funding updates hourly) |
| Open interest | 5 min | Acceptable |
| Regime indicators | 1 min | Re-compute from cached candles |
| Discovery tokens | 10 min | Acceptable for context; fresh via tool call |
| Progress score | Per-tick (computed) | Always fresh |

---

## Dependencies

- `@herobids/market-data` — regime evaluation, candle fetching
- Venue adapters — funding rate, OI endpoints (from market-data-provider-strategy.md Layer 2)
- `apps/worker/src/runtime-composition.ts` — context block assembly
- `apps/worker/src/agent.ts` — session metrics, cost tracking
