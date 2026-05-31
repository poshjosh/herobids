# LLM Cost Optimization Guide for Agentic Trading Systems

> **Audience:** AI coding agents building a new repository that implements LLM-driven autonomous trading.  
> **Purpose:** Architectural instructions and constraints to minimize LLM inference costs without sacrificing decision quality.  
> **Scope:** Stack-agnostic principles. Examples use pseudocode unless noted otherwise.

---

## Table of Contents

1. [Cost Model Fundamentals](#1-cost-model-fundamentals)
2. [Architecture: The Decision Funnel](#2-architecture-the-decision-funnel)
3. [Gate Before You Call](#3-gate-before-you-call)
4. [Tiered Model Routing](#4-tiered-model-routing)
5. [Prompt Engineering for Cost](#5-prompt-engineering-for-cost)
6. [Caching Strategies](#6-caching-strategies)
7. [Adaptive Tick Frequency](#7-adaptive-tick-frequency)
8. [Shared Computation Across Agents](#8-shared-computation-across-agents)
9. [Context Diffing (Incremental Prompts)](#9-context-diffing-incremental-prompts)
10. [Structured Output Enforcement](#10-structured-output-enforcement)
11. [Token Budget Guardrails](#11-token-budget-guardrails)
12. [Observability and Cost Attribution](#12-observability-and-cost-attribution)
13. [Anti-Patterns to Avoid](#13-anti-patterns-to-avoid)
14. [Cost Estimation Formulas](#14-cost-estimation-formulas)
15. [Implementation Checklist](#15-implementation-checklist)

---

## 1. Cost Model Fundamentals

LLM cost is driven by three variables:

```
total_cost = Σ (input_tokens × input_price + output_tokens × output_price) × calls_per_day
```

To reduce cost, you must reduce **at least one** of:

| Lever | Strategy |
|-------|----------|
| **Call frequency** | Gate calls, extend intervals, skip unchanged contexts |
| **Input tokens per call** | Truncate context, diff instead of resend, prune irrelevant data |
| **Output tokens per call** | Structured output schemas, constrained decoding, shorter reasoning |
| **Price per token** | Route to cheaper models when quality allows |

### Typical Model Pricing Tiers (2025–2026)

| Tier | Cost Range (input/output per 1M tokens) | Use Case |
|------|----------------------------------------|----------|
| Ultra-cheap | $0.10–$1 / $0.50–$3 | Triage, screening, HOLD confirmations |
| Mid-tier | $1–$5 / $5–$20 | Trade decisions, position management |
| Premium | $5–$15 / $25–$75 | Strategic reviews, ambiguous multi-signal reasoning |

**Prompt caching discounts** (where supported) give 90% off cached input tokens. Always design prompts to maximize cache-hit rate.

---

## 2. Architecture: The Decision Funnel

The most important architectural principle: **structure your system as a funnel that progressively eliminates no-op ticks before reaching the LLM.**

```
┌─────────────────────────────────────────────────────┐
│  All Scheduled Ticks (100%)                         │
├─────────────────────────────────────────────────────┤
│  Gate 1: Trading Session Check (skip nights/weekends)│ → ~30-50% eliminated
├─────────────────────────────────────────────────────┤
│  Gate 2: Regime Gate (skip unfavorable market)      │ → ~20-40% eliminated
├─────────────────────────────────────────────────────┤
│  Gate 3: Deterministic Scout (no candidates?)       │ → ~20-30% eliminated
├─────────────────────────────────────────────────────┤
│  Gate 4: Context Hash (unchanged since last call?)  │ → ~10-30% eliminated
├─────────────────────────────────────────────────────┤
│  Gate 5: Adaptive Interval (low vol → less often)   │ → ~30-60% eliminated
├─────────────────────────────────────────────────────┤
│  ✦ LLM CALL (5–20% of original ticks reach here)   │
└─────────────────────────────────────────────────────┘
```

**Implement gates in order of cheapness.** A Redis read (Gate 4) is cheaper than fetching candle data (Gate 3). A clock check (Gate 1) is cheaper than everything.

---

## 3. Gate Before You Call

### 3.1 Trading Session Gate

Skip ticks entirely when the market is outside configured trading hours. This is a zero-cost clock comparison.

```python
if not is_within_trading_session(now, config.sessions):
    skip_tick("outside_session")
    return
```

### 3.2 Regime Gate

Use deterministic technical indicators (ATR, ADX, EMA alignment) to detect whether the market regime is favorable. If not, skip the LLM call.

```python
regime = evaluate_regime(benchmark_candles)
if not regime.favorable and not has_open_positions:
    skip_tick("regime_gate_failed", regime.reasons)
    return
```

**Key rule:** Only gate when the agent has no open positions. An unfavorable regime with open positions still needs LLM attention for exit decisions.

### 3.3 Deterministic Scout

Before building an expensive prompt, do a cheap check: are there any viable candidates at all?

```python
candidates = discover_tokens(filters={min_liquidity, min_age, min_volume})
if len(candidates) == 0 and not has_open_positions:
    skip_tick("no_candidates")
    return
```

This should use cached/shared discovery data (coordinator pattern) rather than making fresh API calls per agent.

### 3.4 Context Hash Gate

Hash the decision-relevant inputs (candidates, prices, positions, capital). If the hash matches the last call's hash, return the cached decision.

```python
ctx_hash = hash(round_prices(candidates, 2), position_ids, available_capital)
if ctx_hash == last_context_hash:
    return last_decisions  # Cost: $0
```

**Important:** Round floating-point values to 2 significant figures before hashing to avoid hash-busting on trivial price noise.

---

## 4. Tiered Model Routing

### 4.1 The Principle

Not all decisions require the same reasoning depth. Route ticks to model tiers based on decision complexity.

| Decision Complexity | Model Tier | Examples |
|---|---|---|
| No action needed | SKIP (no model) | Empty market, session gate, regime gate |
| Triage / "anything interesting?" | Ultra-cheap | Routine scan, HOLD confirmation |
| Trade execution | Mid-tier | Entry, exit, resize decisions |
| Strategic synthesis | Premium | Regime change review, portfolio rebalancing |

### 4.2 Tick Classification

Classify each tick before choosing a model:

```python
class TickKind(Enum):
    SCHEDULED_FLAT = "scheduled_flat"        # No positions, timer-driven
    SCHEDULED_HOLDING = "scheduled_holding"  # Has positions, timer-driven
    WAKE_FLAT = "wake_flat"                  # Market signal, no positions
    WAKE_HOLDING = "wake_holding"            # Market signal, has positions
    USER_MESSAGE = "user_message"            # Explicit user request

def classify_tick(has_positions, trigger_type) -> TickKind:
    ...
```

### 4.3 Scout/Judge Two-Stage Pattern

The cheapest safe pattern for tool-calling agents:

**Stage 1 — Scout (cheap model, read-only tools):**

- Cannot execute trades (tool restriction enforced)
- Returns a structured disposition: `skip | monitor | escalate`
- Compact prompt (only triage-relevant data)

**Stage 2 — Judge (mid/premium model, full tools):**

- Only invoked when scout says `escalate`
- Receives scout's handoff summary (why it escalated)
- Has full tool access including trade execution

```python
# Scout stage
scout_result = call_llm(
    model=cheap_model,
    prompt=build_scout_prompt(compact_context),
    allowed_tools=READ_ONLY_TOOLS
)

disposition = parse_scout_disposition(scout_result)

if disposition.action == "escalate":
    # Judge stage
    judge_result = call_llm(
        model=premium_model,
        prompt=build_judge_prompt(full_context, disposition.summary),
        allowed_tools=ALL_TOOLS
    )
```

**Critical constraint:** The scout must never have access to trade-execution tools. This is enforced at the tool-registry level, not by prompt instruction alone. LLMs cannot be trusted to obey soft constraints on high-stakes actions.

### 4.4 Confirmation Pattern (Non-Tool-Calling Mode)

For LLM engines that return JSON decisions (not tool calls):

```python
decisions = call_llm(cheap_model, full_context, response_format="json")

if all(d.action == "hold" for d in decisions):
    return decisions  # Cheap model accepted (~80% of ticks)
else:
    # Trade proposed — confirm with premium model
    confirmed = call_llm(premium_model, full_context, response_format="json")
    return confirmed
```

This means premium cost is only incurred on the ~20% of ticks that propose action.

### 4.5 Strategic Review Escalation

Every Nth tick (e.g., 20), regardless of classification, escalate to a premium model for deep synthesis:

- Review accumulated memories and trade history
- Evaluate strategy performance
- Detect regime evolution
- Extract and persist lessons learned

This periodic deep-think prevents the system from getting stuck in local optima when routine ticks all result in HOLD.

---

## 5. Prompt Engineering for Cost

### 5.1 Maximize Prompt Cache Hits

Provider-level prompt caching (Anthropic, OpenAI, OpenRouter) gives 90% discount on cached input tokens. To exploit this:

1. **Put static content first:** System prompt, playbook rules, strategy constraints, tool definitions
2. **Put dynamic content last:** Current prices, candidates, positions
3. **Keep prompt structure deterministic:** Same field ordering every call, no random shuffling

```
[CACHED — static system prompt + playbook + constraints]  ← 90% discount
[DYNAMIC — current market data + positions]               ← full price
```

If your system prompt is 3000 tokens and dynamic context is 1000 tokens, effective input cost = 3000×0.1 + 1000×1.0 = 1300 token-equivalents instead of 4000.

### 5.2 Truncate Aggressively

| Context Section | Truncation Strategy |
|---|---|
| Candle history | Limit to N most recent (e.g., 12 × 1H = 12 hours). More is rarely useful. |
| Candidate table | Top-K by composite score (e.g., 10), not all discovered tokens |
| Agent memories | Show N most recent full entries + K older keys-only |
| Trade history | Summarize into aggregates (win rate, avg return) rather than listing trades |
| Indicator values | Only include if they differ from default/neutral (omit "RSI: 50") |

### 5.3 Omit Irrelevant Fields

Don't serialize fields the LLM doesn't use in decisions:

```python
# BAD: serialize everything
candidate_table = [full_token_metadata for t in candidates]

# GOOD: only decision-relevant fields
candidate_table = [{
    "symbol": t.symbol,
    "price": t.price,
    "change_24h": t.change_24h,
    "liquidity": t.liquidity,
    "volume_24h": t.volume,
    "risk": t.risk_level
} for t in candidates]
# Omit: logo URL, description, creation tx hash, social links, etc.
```

### 5.4 Use Compact Serialization

```python
# BAD: verbose prose
"The token BONK currently trades at $0.00002341 with 24-hour volume of $12,345,678"

# GOOD: tabular format
"BONK | $0.0000234 | vol $12.3M | liq $4.2M | +15% 24h | RSI 67"
```

Tables are denser than prose. One-line-per-token with pipe separators uses ~40% fewer tokens than sentence descriptions.

---

## 6. Caching Strategies

### 6.1 In-Memory Hash Cache (Per-Instance)

Each engine instance maintains a hash of the last context sent. If unchanged, return cached decisions immediately.

```python
class LlmEngine:
    last_hash: str = ""
    last_decisions: List[Decision] = []

    def analyze(self, context):
        h = compute_hash(context, precision=2)
        if h == self.last_hash:
            return self.last_decisions  # $0 cost
        ...
```

### 6.2 Shared Cache (Cross-Instance)

Store LLM decisions in Redis/Memcached keyed by `model:context_hash`. Multiple agents with identical context share one LLM call.

```
Key:   llm:strategy:{model}:{ctx_hash}
Value: JSON decisions
TTL:   scan_interval_ms (e.g., 60 seconds)
```

This is most effective when multiple agents scan the same token universe with the same model.

### 6.3 Provider Prompt Cache

Enable provider-side prompt caching:
- **Anthropic:** `cache_control: { type: "ephemeral" }` on system message blocks
- **OpenAI:** Automatic for prompts >1024 tokens within a 5-minute window
- **OpenRouter:** Pass-through of underlying provider caching

Track cache hit rates in your cost ledger. If cache hits are low, investigate prompt instability (non-deterministic ordering, unnecessary timestamp injection, etc.).

---

## 7. Adaptive Tick Frequency

### 7.1 The Problem

Fixed-interval ticking (e.g., every 60 seconds) wastes LLM calls in calm markets where nothing changes between ticks.

### 7.2 Volatility-Driven Intervals

Use ATR (Average True Range) on the benchmark asset to modulate tick frequency:

```python
def get_adaptive_interval(base_interval_ms, benchmark_atr_pct):
    if atr_pct < LOW_VOL_THRESHOLD:  # e.g., 0.3%
        return base_interval_ms * LOW_VOL_MULTIPLIER  # e.g., 3×
    elif atr_pct > HIGH_VOL_THRESHOLD:  # e.g., 1.5%
        return base_interval_ms * HIGH_VOL_MULTIPLIER  # e.g., 0.5×
    else:
        return base_interval_ms
```

**Override conditions** (always use base interval):
- Open positions near stop-loss or take-profit
- Wake signal received (external event)
- User message pending

### 7.3 Position-Aware Intervals

When the agent is flat (no open positions), it can tick less frequently:

```python
if no_open_positions:
    interval = config.flat_tick_interval  # e.g., 30 min
else:
    interval = config.holding_tick_interval  # e.g., 5 min
```

### 7.4 Event-Driven Wakes

Supplement scheduled ticks with event-driven wakes for significant market moves:

- Price crosses a watched threshold (e.g., +5% on held token)
- Volume spike detected (e.g., 3× average)
- External signal (social sentiment, news)

This allows long base intervals (30–60 min) without missing fast moves.

---

## 8. Shared Computation Across Agents

### 8.1 The Problem

In a multi-agent system, N agents scanning the same market each independently:
1. Fetch the same market data
2. Compute the same indicators
3. Ask the LLM the same "what's happening in the market?" question

### 8.2 Shared Market Commentary Layer

Generate one market analysis per chain per interval, shared across all agents:

```python
# Runs once per interval per chain (not per agent)
commentary = generate_market_commentary(
    chain="solana",
    model=cheapest_model,
    candidates=discovery_snapshot,
    regime=regime_evaluation
)
cache.set(f"commentary:{chain}", commentary, ttl=interval_ms)
```

Individual agents then consume this pre-computed context instead of each deriving their own market read:

```python
# Per-agent tick (much cheaper)
commentary = cache.get(f"commentary:{chain}")
agent_prompt = build_prompt(
    market_context=commentary,  # Shared (read from cache, ~200 tokens)
    portfolio=agent_positions,   # Agent-specific
    playbook=agent_rules          # Agent-specific
)
```

**Savings at scale:**
- Without: 100 agents × 1500 tokens market analysis = 150K tokens/tick
- With: 1 commentary call (2000 tokens) + 100 × 200 tokens (injected) = 22K tokens/tick
- **85% reduction** in market analysis tokens

### 8.3 Shared Discovery Coordination

A single discovery coordinator fetches and filters token data. Individual agents read from the shared snapshot:

```python
# Coordinator (runs once per interval)
snapshot = discover_and_enrich_tokens(chain, filters)
redis.set(f"discovery:{chain}", snapshot, ttl=staleness_threshold)

# Per-agent (reads shared data, no API calls)
candidates = redis.get(f"discovery:{chain}")
```

---

## 9. Context Diffing (Incremental Prompts)

### 9.1 The Problem

Most ticks, 95% of the context is identical to the previous call. You're paying full input price for information the model already "saw."

### 9.2 Delta Prompts

Instead of resending full context, send only what changed:

```python
diff = compute_context_diff(last_sent_context, current_context)

if diff.materiality_score < IMMATERIAL_THRESHOLD:
    return last_decisions  # Nothing worth re-evaluating

if diff.materiality_score < FULL_RESEND_THRESHOLD:
    prompt = build_delta_prompt(diff, last_decision_summary)
    # ~200 tokens instead of ~2000
else:
    prompt = build_full_prompt(current_context)
    # Full resend for major changes
```

### 9.3 Delta Prompt Template

```
Since your last analysis (3 min ago), the following changed:
- SOL price: $168.20 → $169.05 (+0.5%)
- BONK volume 24h: $12M → $14M (+16.7%)
- New candidate: POPCAT (liq $2.1M, vol $8.3M, +15% 24h)
- RSI(14) for WIF: 62 → 67

Previous decision: HOLD all positions.
Given only these changes, should your decision change?
Reply with updated decisions only, or "NO_CHANGE".
```

### 9.4 Materiality Thresholds

Define what constitutes a "material" change worth including in the diff:

| Data Point | Immaterial (ignore) | Material (include) |
|---|---|---|
| Price | < 0.3% change | ≥ 0.3% change |
| Volume | < 10% change | ≥ 10% change |
| RSI | < 3 points | ≥ 3 points |
| New/removed candidate | — | Always material |
| Position P&L | < 1% change | ≥ 1% change |

### 9.5 Full-Context Resync

Send the complete context periodically (e.g., every 10th tick) to prevent drift. Models processing only diffs may gradually lose broader awareness.

---

## 10. Structured Output Enforcement

### 10.1 The Problem

Without schema enforcement, LLMs often produce:
- Reasoning preamble before the JSON ("Let me analyze..." = +50 wasted tokens)
- Verbose explanations in the `reason` field
- Invalid JSON that triggers retries (each retry = full cost again)

### 10.2 Provider-Native Schemas

Use the provider's constrained decoding when available:

```python
# OpenAI / OpenRouter
response_format = {
    "type": "json_schema",
    "json_schema": {
        "name": "trading_decisions",
        "schema": DECISION_SCHEMA
    }
}

# Anthropic
# Use tool_use with a single tool whose input_schema matches your decision format
tools = [{
    "name": "submit_decisions",
    "input_schema": DECISION_SCHEMA
}]
tool_choice = {"type": "tool", "name": "submit_decisions"}
```

### 10.3 Minimal Decision Schema

```json
{
  "type": "object",
  "properties": {
    "decisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "action": { "enum": ["buy", "sell", "hold"] },
          "token": { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "size_pct": { "type": "number", "minimum": 0, "maximum": 100 },
          "reason": { "type": "string", "maxLength": 80 }
        },
        "required": ["action", "token", "reason"]
      }
    }
  },
  "required": ["decisions"]
}
```

Note the `maxLength: 80` on `reason` — this alone can save 30–50% of output tokens vs unbounded reasoning.

### 10.4 Fallback for Unsupported Providers

If a provider doesn't support native schema enforcement, fall back to prompt instruction + JSON mode:

```
Respond with ONLY valid JSON matching this schema. No preamble, no explanation outside the JSON.
```

---

## 11. Token Budget Guardrails

### 11.1 Daily Budget Cap

Hard-cap daily LLM spend per agent to prevent runaway costs:

```python
DAILY_TOKEN_BUDGET = 10_000_000  # ~$5-15/day depending on model

def pre_call_check(agent_id):
    today_tokens = get_today_usage(agent_id)
    if today_tokens >= DAILY_TOKEN_BUDGET:
        raise BudgetExceededError(f"Agent {agent_id} exceeded daily budget")
```

### 11.2 Per-Call Budget

Set `max_tokens` appropriately for each call type:

| Call Type | Recommended max_tokens |
|---|---|
| Scout triage | 256–512 |
| Standard decision | 1024–2048 |
| Strategic review | 4096–8192 |
| Config generation | 4096 |

Over-provisioning `max_tokens` doesn't cost extra (you only pay for generated tokens), but it does affect latency and prevents you from detecting truncation early.

### 11.3 Incomplete Response Handling

Detect truncation and handle it explicitly:

```python
if response.finish_reason == "length":
    if call_type == "trade_decision":
        # Fail closed — do not parse partial trade decisions
        raise IncompleteResponseError()
    elif call_type == "analysis":
        # Retry once with increased budget
        retry_with(max_tokens=original * 1.5)
```

**Never execute trade actions from a truncated response.** Partial JSON may be missing critical fields (stop-loss, size, direction).

---

## 12. Observability and Cost Attribution

### 12.1 Cost Ledger

Record every LLM call with:

```python
record_cost(
    agent_id=agent_id,
    input_tokens=response.usage.input,
    output_tokens=response.usage.output,
    cached_tokens=response.usage.cached_input,
    model=model_name,
    cost_usd=provider_reported_cost or estimated_cost,
    call_type="scout" | "judge" | "strategic_review",
    tick_kind=tick_classification,
    cache_hit=was_redis_hit,
)
```

### 12.2 Key Metrics to Track

| Metric | Why |
|---|---|
| Cost per decision | Are you paying more for HOLD than for actionable trades? |
| Cache hit rate (in-memory) | If low, hash function or rounding may be wrong |
| Cache hit rate (Redis shared) | If low, agents may have divergent contexts |
| Prompt cache hit rate (provider) | If low, prompt structure is non-deterministic |
| Scout→Judge escalation rate | If >50%, scout threshold too aggressive |
| Ticks gated (by gate type) | Validates each gate is contributing |
| Tokens per call (input/output) | Detects prompt bloat over time |
| Budget utilization | Are agents burning budget on low-value ticks? |

### 12.3 Cost Alerts

Set up alerts for:
- Daily spend > 80% of budget (warning)
- Single call > $X (anomaly — possible prompt injection or context explosion)
- Cache hit rate drops below threshold (regression in prompt structure)
- Escalation rate spikes (market regime may have shifted)

---

## 13. Anti-Patterns to Avoid

### 13.1 LLM for Everything

**Anti-pattern:** Using the LLM to compute things that have deterministic solutions.

```python
# BAD: asking the LLM to calculate RSI
prompt = "Given these candles, what is the RSI(14)?"

# GOOD: compute deterministically, pass result to LLM
rsi = compute_rsi(candles, period=14)
prompt = f"RSI(14) = {rsi}. Based on this and other indicators..."
```

### 13.2 Full Context Every Call

**Anti-pattern:** Resending the entire playbook, all memories, full trade history, and all candidates on every single tick.

Instead: cache static content, use diffs, truncate history to aggregates.

### 13.3 Retry Without Diagnosis

**Anti-pattern:** On parse failure, immediately retry with the same prompt.

```python
# BAD
for attempt in range(3):
    result = call_llm(same_prompt)
    if valid_json(result):
        return parse(result)

# GOOD
result = call_llm(prompt, response_format="json_schema")
if result.finish_reason == "length":
    retry_with_more_tokens()
elif not valid_json(result):
    log_anomaly(result)
    fallback_to_hold()
```

### 13.4 Premium Models for HOLD

**Anti-pattern:** Using an expensive reasoning model for ticks that result in "do nothing."

~80% of ticks in a well-gated system result in HOLD. If your cheapest gate (context hash) doesn't catch them, the model tier should. Don't route a HOLD-likely tick to Opus.

### 13.5 Per-Agent Market Analysis

**Anti-pattern:** Each agent independently asking the LLM "what's happening in the market?"

Share this computation via a market commentary layer. 100 agents asking the same question independently costs 100× what a single shared call costs.

### 13.6 Unbounded Memory Injection

**Anti-pattern:** Dumping all agent memories into the prompt.

Memories grow over time. Without truncation, a long-running agent's prompt grows linearly. Implement:
- Max N recent memories (full content)
- Older memories: keys-only (titles, no content)
- Per-entry character cap
- Periodic memory summarization (compress 50 entries into 5)

### 13.7 Timestamps in Cached Sections

**Anti-pattern:** Including `"current_time": "2026-05-31T14:32:01Z"` in the system prompt.

This busts the provider's prompt cache every second. Put timestamps only in the dynamic (user message) section.

---

## 14. Cost Estimation Formulas

### 14.1 Per-Tick Cost

```
cost_per_tick = (system_prompt_tokens × cache_rate + dynamic_tokens) × input_price
             + output_tokens × output_price

where cache_rate = 0.1 (if prompt cache hits) or 1.0 (if miss)
```

### 14.2 Daily Cost (Single Agent)

```
ticks_per_day = (active_hours × 3600) / tick_interval_seconds
effective_ticks = ticks_per_day × (1 - gate_skip_rate)
daily_cost = effective_ticks × cost_per_tick
```

Example:
- 16 active hours, 15-min interval = 64 ticks/day
- 70% gated = 19 effective ticks
- $0.005 per tick (cheap model) = **$0.10/day**

### 14.3 Fleet Cost

```
fleet_daily_cost = N_agents × daily_cost_per_agent × (1 - shared_cache_hit_rate)
```

With 100 agents sharing 40% of calls via Redis cache:
- 100 × $0.10 × 0.6 = **$6/day** (vs $10 without sharing)

### 14.4 Scout/Judge Cost Model

```
scout_cost = scout_ticks × scout_tokens × cheap_price
judge_cost = scout_ticks × escalation_rate × judge_tokens × premium_price
total_cost = scout_cost + judge_cost

# Example: 100 ticks, 20% escalation
scout = 100 × 500 × $0.001/1K = $0.05
judge = 100 × 0.2 × 2000 × $0.01/1K = $0.04
total = $0.09 vs $0.20 (all ticks at premium) = 55% savings
```

---

## 15. Implementation Checklist

When building a new agentic trading system, implement these in order of cost impact:

### Phase 1 — Foundation (Day 1)

- [ ] Fixed trading session gate (skip nights/weekends)
- [ ] Context hash caching (in-memory, per-instance)
- [ ] `max_tokens` set appropriately per call type
- [ ] Cost ledger recording every LLM call
- [ ] Daily token budget cap

### Phase 2 — Cheap Gates (Week 1)

- [ ] Regime gate (ADX, EMA alignment, VWAP)
- [ ] Deterministic scout (candidate discovery check)
- [ ] Provider prompt caching enabled (static content first)
- [ ] Flat vs holding interval differentiation
- [ ] Structured output schema (JSON mode at minimum)

### Phase 3 — Model Routing (Week 2)

- [ ] Tick classification (scheduled/wake × flat/holding)
- [ ] Scout/Judge split with tool restriction
- [ ] Cheap model for HOLD-likely ticks
- [ ] Premium model only for escalated decisions
- [ ] Confirmation pattern for trade proposals

### Phase 4 — Fleet Optimization (Week 3+)

- [ ] Redis shared decision cache (cross-agent)
- [ ] Shared market commentary layer
- [ ] Shared discovery coordinator
- [ ] Adaptive tick intervals (volatility-driven)
- [ ] Context diffing (incremental prompts)

### Phase 5 — Continuous Tuning

- [ ] Monitor escalation rate (target: 15–30%)
- [ ] Monitor cache hit rates (target: >60% combined)
- [ ] Monitor cost per decision (should trend down)
- [ ] Periodic memory summarization
- [ ] A/B test materiality thresholds
- [ ] Consider fine-tuning a small model on logged decisions (100–1000× cheaper inference)

---

## Summary

The single most impactful principle: **most ticks should never reach an LLM.** Gates, caches, and adaptive intervals eliminate 80–95% of calls. For the remaining calls, route by complexity: cheap models for triage, premium models only for confirmed trade execution and periodic strategic reviews. Structured outputs and incremental prompts minimize tokens per call. Shared computation prevents fleet-level duplication.

A well-optimized system achieves **$0.05–$0.20/agent/day** at scale, vs **$5–$50/agent/day** for naive implementations — a 25–250× cost difference.
