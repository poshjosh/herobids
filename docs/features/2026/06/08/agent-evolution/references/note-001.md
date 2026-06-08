### LLM Cost Optimization

#### 1. Pre-LLM Gating (Cost: Highest Impact)

Your LLM cost optimization guide (llm-cost-optimization-guide.md) has the full funnel but it's a checklist of unimplemented items. In the current agent runtime (agent.ts), every tick fires `callLlmProvider` unconditionally. Implement:

- **Session gate** — Clock check before `runTick()` enters the LLM call. Crypto is 24/7 but weekend low-liquidity periods can still be gated.
- **Regime gate** — You already have `evaluateRegime()` and `check_regime` as a tool. Move it *before* the LLM call as a deterministic pre-filter. If regime is unfavorable AND no open positions → skip tick entirely.
- **Context hash gate** — Hash the decision-relevant data (position side, last price bucket, regime state). If unchanged → skip LLM call, repeat last decision or hold.
- **Adaptive tick interval** — In low-volatility periods (ATR below threshold), double `TICK_INTERVAL_MS` dynamically. In high-vol, halve it.

This alone can eliminate 60–80% of LLM calls without sacrificing quality.

#### 2. Thinking-Level Control (Cost: Direct Reduction)

Port the Phase 1 design from aitradingbot's tiered pipeline directly to `@herobids/llm`. The current `callLlmProvider` has no thinking parameter. Add:

```typescript
interface LlmRequest {
  messages: ...;
  maxTokens: number;
  temperature?: number;
  thinking?: 'none' | 'light' | 'deep';  // ← new
}
```

Then classify agent ticks:
- **Routine tick, no positions, regime favorable** → `thinking: 'none'` on a cheap model (Qwen, Kimi)
- **Tick with open positions** → `thinking: 'light'` on mid-tier
- **Major signal (regime change, large drawdown, user message)** → `thinking: 'deep'` on premium model

The README already adjudged the full cascade as overkill for the agent path (multi-turn tool calling ≠ filtering pipeline). But thinking-level control on the *same* model is pure cost savings with zero architectural complexity.

#### 3. Enrich Agent Context with Pre-Computed Data

Currently `buildTickUserContext` gives the agent minimal info: position side, P&L summary, symbol + price. The agent must *waste tool calls* (each costing output tokens + another round-trip) to get basic market data. Instead, pre-compute and inject into the tick context:

- **Funding rates** (Hyperliquid/Bybit provide these via WebSocket — you already have private streams)
- **Regime summary** — Run `evaluateRegime()` before the tick and include the result (ADX value, EMA alignment, structure, choppy flag)
- **Recent price action** — Last N candle summary (via `fetchBinanceCandles` which is already wired)
- **Open interest skew / liquidation levels** (venue-specific — Hyperliquid exposes this)
- **Portfolio summary** — Total exposure, net delta, realized P&L today, drawdown from peak

This trades ~$0.001 of compute per tick for potentially saving 2-5 tool calls per tick ($0.02–0.10 each in output tokens).

#### 4. Scout/Judge Pattern for Direct-Trading Agents

From the cost guide (§4.3): use a cheap model with read-only tools to triage, escalate to the premium model only when action is needed.

In herobids terms:
- **Scout tick** — Cheap model, sees the enriched context, can use `search_tokens` and `check_regime` but NOT `submit_decision`. Returns disposition: `hold | escalate(reason)`.
- **Judge tick** — Only runs when scout escalates. Premium model, full tool access including `submit_decision`.

This means ~80% of ticks cost $0.001–0.005 (cheap model, short response), and only ~20% cost the full premium price. The tool policy engine (`buildCapabilityPolicyEngine`) already supports restricting tool access per invocation — extend it to support scout vs. judge modes.

#### 5. Prompt Structure for Cache Efficiency

The current system prompt is rebuilt from `composeSystemPrompt(runtimeState)` every tick. Restructure to maximize provider prompt caching:

- **Static prefix** (system prompt, skill definitions, tool schemas, playbook rules) → cacheable (90% discount)
- **Dynamic suffix** (current positions, prices, regime, P&L, managed bots) → changes per tick

The system prompt structure in `RUNTIME_CONTEXT_PROVIDERS` already separates `core-platform` from `trading-context`. Enforce ordering: static blocks first, dynamic blocks last. This is free money from Anthropic/OpenAI's prompt cache.

#### 6. Context Diffing (Incremental Prompts)

Instead of sending full market data every tick, send a diff: "BTC moved +1.2% since last tick, position unchanged, funding rate flipped negative." This dramatically reduces input tokens on routine ticks while giving the agent the same signal quality.

---

### Summary: Revised Focus (Ordered by Impact)

| # | Focus | Impact on Cost | Impact on Quality | Complexity |
|---|---|---|---|---|
| 1 | Pre-LLM gating (regime, session, context hash, adaptive interval) | **−60–80% calls** | Neutral (only skips no-op ticks) | Low |
| 2 | Thinking-level control on `@herobids/llm` | **−30–50% per-call cost** | Neutral to positive | Low |
| 3 | Enriched tick context (pre-computed data injection) | **−20–40% tool-call tokens** | **Positive** (better data = better decisions) | Medium |
| 4 | Scout/Judge two-tier agent dispatch | **−50–70% model cost** | Neutral (judge still sees everything) | Medium |
| 5 | Prompt structure for provider cache hits | **−30–50% input tokens** | Neutral | Low |
| 6 | Context diffing (incremental prompts) | **−20–40% input tokens** | Neutral | Medium |

Items 1, 2, and 5 are low-hanging fruit with minimal risk. Item 3 directly improves decision quality AND reduces cost. Items 4 and 6 are the bigger architectural lifts but deliver compounding savings at scale.
