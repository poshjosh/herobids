## 1. Compact Context Serialization

**File:** context.ts

The `serializeContext()` function builds LLM prompts using **tabular pipe-delimited format** instead of prose, reducing tokens by ~40%:

```
Address | Symbol | Price | 24h Change | Liquidity | Volume 24h
0x... | BONK | $0.000023 | +15.2% | $4.2M | $12.3M
```

Numeric values are formatted compactly via `fmt()`:
- `1234567` → `"1.23M"` 
- `12345` → `"12.3K"`

Enrichment columns (Market Cap, Rank, Categories, CEXs, Risk Level) are **conditionally included** — they only appear when data is actually present (CMC enrichment enabled). Execution parameters and strategy constraints are only included when the corresponding config fields are defined (not null).

---

## 2. Context Hash Gate — Skip Redundant LLM Calls

**File:** context.ts (function `hashContext()`)

Before calling an LLM, the context is hashed. If the hash matches the previous call, the cached decision is reused — **$0 cost**. Prices are rounded to 2 significant figures before hashing so minor price noise doesn't bust the cache:

```typescript
// Use 2 significant figures (~4-7% bucket) so consecutive scans hash identically
parts.push(`p:${p.id}:${p.currentPrice.toPrecision(2)}`);
```

---

## 3. Agent Context Budget System

**Documentation:** agent-context-budget.md
**Implementation:** memory.ts, types.ts

### M1: Memory truncation & caps (IMPLEMENTED)

| Config knob | Default | What it does |
|---|---|---|
| `maxContextMemories` | 15 | Show N most recent memories with full content |
| `maxMemoryEntryChars` | 1,000 | Truncates long memory entries with `"... [read_memory for full]"` marker |
| `maxContextOlderKeys` | 30 | Older memories beyond N: show keys only, no content |
| `maxContextDatasets` | — | Cap datasets listed in prompt |

Changelog entries (lines 344–352 of CHANGELOG.md):
> **Memory entry truncation** — Memory entries in the agent system prompt are now truncated to `maxMemoryEntryChars` (default 1,000) characters with a `"... [read_memory for full]"` marker.
> **Older memory keys cap** — The older-keys list (beyond `maxContextMemories`) is now capped to `maxContextOlderKeys` (default 30) keys. Remaining keys are hidden behind `"(+N more — use list_memories tool)"`.

The base skill instructions also explicitly tell agents to write concisely (seeds.ts line 17):
> "Memory entries over ~1,000 characters are truncated in your context display. Keep entries concise — headline + key data points."

---

## 4. Executor Loop — Stale Tool Result Truncation

**File:** executor.ts (function `truncateStaleToolResults()`, line 278)

Multi-turn tool-calling loops grow quadratically because every turn resends the full message history. The executor truncates old tool results after N retention turns:

```typescript
// Recent turns (within retentionTurns): full results, unmodified
// Older turns: truncate tool result content to maxStaleChars with "... [truncated]"
```

Configurable via `toolResultFullRetentionTurns` and `toolResultMaxStaleChars`. This breaks quadratic growth — ~60% reduction in peak input tokens for long tool-calling sequences (per agent-context-budget.md).

---

## 5. Lower `maxToolTurns` Default

**File:** executor.ts (line 64: `maxToolTurns = 20`)

The default was reduced from 25 to 20 (per CHANGELOG), cutting worst-case token usage by ~75% while still allowing complex multi-step ticks. Configurable per-agent.

---

## 6. Provider-Side Prompt Caching

**File:** executor.ts (Anthropic calls), base.ts (OpenRouter)

The executor sends `cache_control: { type: 'ephemeral' }` on Anthropic API requests. The OpenRouter provider does the same (base.ts line 54):

```typescript
// Enable prompt caching on OpenRouter to reduce costs on repeated context
if (this.name === 'openrouter') {
  body.cache_control = { type: 'ephemeral' };
}
```

This gives **~90% discount on cached input tokens**. Within a tick's multi-turn tool loop, the system prompt is identical across all LLM calls, so turns 2+ hit the cache. The prompt is structured to put static content first and dynamic content last to maximize cache hits.

Cost tracking in token-pricing.ts accounts for cache read discounts (default 0.1× for Anthropic/DeepSeek, 0.25× for OpenAI/Gemini).

---

## 7. Tool-Definition Filtering

**File:** executor.ts (line 70–72)

When `allowedTools` is set (derived from skill `requiredTools`), only those tool schemas are sent to the LLM instead of all ~15. This saves ~1,000 tokens/turn for agents with focused skill sets.

---

## 8. Omit Irrelevant / Default Fields

**File:** context.ts (lines 127–175)

The `serializeContext()` function only includes execution parameters and strategy constraints that are explicitly defined. Undefined/nil fields are omitted:

```typescript
// Only include Execution Parameters section if there are params to show
if (ctx.executionParams) {
  prompt += `\n\n## Execution Parameters\n${ctx.executionParams}`;
}
```

Enrichment columns (Market Cap, Rank, Categories, CEXs) are only included when data exists — the header row changes dynamically.

---

## 9. Output Token Optimization — Structured Output & Schema Constraints

**File:** strategy.ts

The strategy system prompt enforces compact JSON output with constraints:
- `maxLength: 80` on `reason` fields — saves 30–50% of output tokens
- Strict JSON-only output (no markdown, no preamble)
- LLM-mode purists: no mechanical stop-loss/take-profit injected unless in user's playbook

**File:** generate.ts — `stripEmptyValues()` and `stripFailingZeros()` clean LLM outputs before parsing, removing fields that were emitted as `null`/`0` that fail validation.

---

## 10. Pending Features (Planned but not yet implemented)

### Scout/Judge Model Split
**Doc:** agent-scout-judge-model-split-plan.md

Two-stage LLM routing: a cheap scout model does triage with a **compact scout prompt** (read-only tools), and only escalates interesting situations to the premium judge model with the full prompt. Key quote:

> "Do not send the full agent prompt to the scout profile. Create a dedicated compact scout prompt path... Avoid gathering all context providers for scout-stage ticks; only gather the small packet needed for triage."

### Tiered AI Decision Pipeline
**Doc:** 002-contemplations.md

Three-stage cascade with progressively richer prompts:
- **Screen (cheap model):** minimal prompt, no playbook, no analytics — returns `string[]`
- **Rank (mid-tier):** includes indicators but not full playbook — returns ranked list
- **Decide (premium):** full context, playbook, analytics — returns `StrategyDecision[]`

### M4–M6 from context budget doc
**Doc:** agent-context-budget.md (lines 112–127)

- **M4: Tool-definition filtering** — already partially implemented via `allowedTools`
- **M5: Memory compaction** — LLM-driven summarization of old memories (MemGPT pattern)
- **M6: Global prompt token budget** — hard cap via `maxSystemPromptTokens` with priority-based trimming

---

## Documentation Inventory

| Document | Path | Content |
|---|---|---|
| **LLM Cost Optimization Guide** | llm-cost-optimization-guide.md | 15-section comprehensive guide covering gates, tiered routing, prompt engineering, caching, diffing, structured output, budgets |
| **Agent Context Budget** | agent-context-budget.md | Growth vectors analysis, 6 mitigation strategies (M1–M6), rate-limit math |
| **Scout/Judge Split Plan** | agent-scout-judge-model-split-plan.md | Two-profile LLM routing design with compact scout prompts |
| **Tiered Pipeline Contemplations** | 002-contemplations.md | Three-stage cascade with different prompt depths per stage |
| **CHANGELOG** | CHANGELOG.md (lines ~332–360) | Shipped optimizations: Anthropic caching, memory truncation, older keys cap, maxToolTurns reduction |

---

## Summary of the Philosophy

The codebase follows a layered defense against prompt bloat:

1. **Gate before you prompt** — context hash, session gates, deterministic scouts skip LLM calls entirely
2. **Compact what you send** — tabular format, condensed numbers, conditional columns
3. **Truncate what grows** — memory entry caps, stale tool result truncation, key-only older memories
4. **Cache what's static** — provider prompt caching (Anthropic/OpenRouter), in-memory hash cache
5. **Route by complexity** — planned scout/judge split reserves full prompts for high-value decisions