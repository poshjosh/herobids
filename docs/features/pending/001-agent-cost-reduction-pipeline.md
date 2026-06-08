# Agent Cost Reduction Pipeline

Reduce agent LLM costs by 60–90% without sacrificing decision quality. Agents are the primary consumer of LLM tokens; every optimization here directly impacts unit economics.

---

## Background

In the current agent runtime (`apps/worker/src/agent.ts`), every tick fires `callLlmProvider` unconditionally. There is no gating, no model tiering, no context deduplication. The system prompt is rebuilt from scratch every tick with no regard for provider prompt caching.

Reference: `docs/lessons/llm-cost-optimization-guide.md` describes the full funnel architecture. This plan turns that guide into concrete implementation steps.

---

## Scope

### In scope

- Pre-LLM gating (regime, session, context hash, adaptive interval)
- Thinking-level control on `@herobids/llm`
- Scout/Judge two-tier agent dispatch
- Prompt structure optimization for provider cache hits
- Context diffing (incremental prompts)
- Cost presets and daily spend budgets

### Out of scope

- Model cascade for bot strategies (aitradingbot judged this overkill; same applies here)
- Unifying agent executor with a general-purpose LLM abstraction (separate concern)
- UI for cost configuration (can be added later)

---

## 1. Pre-LLM Gating

### Problem

100% of scheduled ticks reach the LLM. Most ticks result in "hold" — no action taken. Each costs $0.01–$0.10 in tokens.

### Solution

Insert deterministic gates before the LLM call in `runTick()`:

```
All Scheduled Ticks (100%)
  → Gate 1: Trading Session Check (skip low-liquidity periods)     → ~30% eliminated
  → Gate 2: Regime Gate (unfavorable market + no positions)        → ~20% eliminated
  → Gate 3: Context Hash (unchanged since last call)               → ~20% eliminated
  → Gate 4: Adaptive Interval (low vol → double tick interval)     → ~30% eliminated
  → LLM CALL (10–30% of original ticks reach here)
```

### Implementation

#### Gate 1: Session Gate
- Clock check against configured trading hours.
- Crypto is 24/7 but weekend low-liquidity periods can still be gated.
- If agent has open positions, never gate (needs exit decisions).

#### Gate 2: Regime Gate
- `evaluateRegime()` already exists in `@herobids/market-data`.
- `check_regime` is already an agent tool.
- Move it before the LLM call as a deterministic pre-filter.
- If regime is unfavorable AND no open positions → skip tick.

#### Gate 3: Context Hash
- Hash decision-relevant data: position side, last price bucket (round to 0.5%), regime state, portfolio P&L bucket.
- If hash matches previous tick → skip LLM call, carry forward last decision.
- Round floating-point values before hashing to avoid noise-busting.

#### Gate 4: Adaptive Tick Interval
- Compute recent ATR (from Binance candles, already available).
- If ATR < threshold (low volatility): double `TICK_INTERVAL_MS` for next cycle.
- If ATR > threshold (high volatility): halve it (floor at minimum).
- Log interval changes for observability.

---

## 2. Thinking-Level Control

### Problem

Every LLM call uses the same model at the same reasoning depth. Routine "nothing has changed" ticks cost the same as "should I commit capital" ticks.

### Solution

Add `thinking` parameter to `@herobids/llm`:

```typescript
interface LlmRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature?: number;
  thinking?: 'none' | 'light' | 'deep';  // NEW
}
```

Provider mapping:
- Anthropic: `none` → omit thinking block; `light` → `budget_tokens: 2048`; `deep` → `budget_tokens: 10240`
- OpenAI (o-series): `none` → omit; `light` → `reasoning_effort: 'low'`; `deep` → `reasoning_effort: 'high'`
- Others: silently ignore (field is additive, not breaking)

When thinking is enabled for Anthropic:
- Temperature must be overridden to 1 (provider requirement).
- `max_tokens` inflated to `budget_tokens + requested_max_tokens`.

### Tick classification

| Tick type | Thinking level |
|---|---|
| Routine, no positions, regime favorable | `none` (cheap model) |
| Has open positions, no significant change | `light` |
| Major signal (regime flip, large drawdown, user message) | `deep` |

---

## 3. Scout/Judge Two-Tier Dispatch

### Problem

Premium model costs apply to every tick, even the ~80% that result in "hold."

### Solution

Two-stage agent dispatch within a single tick:

**Scout (cheap model, read-only tools):**
- Cannot call `submit_decision` or `create_bot` (enforced via tool policy, not prompt).
- Returns structured disposition: `hold | escalate(reason)`.
- Compact prompt (only triage-relevant data).
- Cost: ~$0.001–$0.005 per tick.

**Judge (premium model, full tools):**
- Only invoked when scout says `escalate`.
- Receives scout's handoff summary (why it escalated) plus full context.
- Has full tool access including `submit_decision`.
- Cost: ~$0.05–$0.15 per tick.

The existing `buildCapabilityPolicyEngine` already supports per-invocation tool restriction. Extend it to support scout vs. judge modes.

### Expected savings

~80% of ticks are scout-only → 80% cost reduction on model spend.

---

## 4. Prompt Structure for Cache Hits

### Problem

Provider prompt caching (Anthropic, OpenAI) gives 90% discount on cached input tokens. Currently the system prompt is rebuilt every tick with mixed static/dynamic content, busting the cache.

### Solution

Enforce strict ordering in `composeSystemPrompt(runtimeState)`:

```
[STATIC — system prompt, skill definitions, tool schemas, playbook rules]  ← cacheable (90% discount)
[DYNAMIC — current positions, prices, regime, P&L, managed bots]           ← full price
```

The `RUNTIME_CONTEXT_PROVIDERS` in `runtime-composition.ts` already separate `core-platform` from `trading-context`. Enforce:
1. Static blocks first (deterministic ordering, no timestamps).
2. Dynamic blocks last (changes per tick).
3. No timestamps or tick counts in the static section.

### Expected savings

If system prompt is ~3000 tokens and dynamic is ~1000 tokens:
- Before: 4000 tokens at full price per tick.
- After: 3000 × 0.1 + 1000 = 1300 effective tokens. **67% input token savings**.

---

## 5. Context Diffing (Incremental Prompts)

### Problem

Every tick sends the full market state even when 95% hasn't changed.

### Solution

Instead of sending full data, send a diff from last tick:
- "BTC moved +1.2% since last tick. Position unchanged. Funding rate flipped negative."
- Reduces input tokens on routine ticks by 40–60%.

Implementation:
- Store last tick's context snapshot in memory.
- Compute diff (price % change, position changes, regime changes, new events).
- If diff is small enough, send diff-mode prompt.
- Every Nth tick (e.g., 10), send full context (prevents drift).

---

## 6. Cost Presets and Spend Planning

### Problem

Users have different budgets. There is no way to say "I can spend $5/day on LLM" and have the system auto-configure.

### Solution

Offer presets that map a daily spend target to system settings:

| Preset | Daily spend | Tick interval | Model | Gating | Thinking |
|---|---|---|---|---|---|
| Minimal | $1–$3 | 30 min | Cheap (Qwen/Kimi) | All gates on | none |
| Standard | $5–$10 | 15 min | Mid-tier | Regime + hash gates | light |
| Premium | $15–$30 | 5 min | Claude/GPT-4o | Hash gate only | deep |
| Custom | User-defined | Derived | Derived | Derived | Derived |

For Custom mode, the user sets a daily budget and the system calculates:
- ticks_per_day = budget / estimated_cost_per_tick
- tick_interval = 86400 / ticks_per_day
- model tier = cheapest that fits within per-tick budget

Store as part of agent config. Expose via API.

---

## Dependencies

- `@herobids/market-data` — regime evaluation (already exists)
- `@herobids/llm` — thinking parameter extension
- `apps/worker/src/agent.ts` — tick loop modifications
- `apps/worker/src/runtime-composition.ts` — prompt structure changes

## Implementation Order

1. Pre-LLM gating (highest impact, lowest risk)
2. Prompt structure for cache hits (free money, low effort)
3. Thinking-level control (requires `@herobids/llm` changes)
4. Scout/Judge dispatch (medium effort, high savings at scale)
5. Context diffing (medium effort, compounds with above)
6. Cost presets (product feature, depends on above being stable)
