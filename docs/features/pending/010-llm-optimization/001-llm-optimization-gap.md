## LLM Optimization Gap Analysis

### 🔴 High impact, low effort — do now

| # | Feature | What it does | Why we need it |
|---|---------|-------------|----------------|
| 1 | **OpenRouter prompt caching** | `cache_control: { type: 'ephemeral' }` on API requests. Within a multi-turn tool loop, the system prompt is identical — turns 2+ hit cache at ~90% discount. | We burned $0.40 on 284 LLM calls. With caching, ~200 of those (turns 2+ in each loop) would cost 10% — saving **~$0.18** per session. The llm provider already wraps OpenRouter; adding one header is trivial. |
| 2 | **Stale tool result truncation** | After N retention turns in a tool loop, truncate older tool results to `maxStaleChars` with `...[truncated]` marker. Breaks quadratic history growth. | This is the "conversation context pruning" I recommended. During the frenzy hour, the judge loop ran many turns. Each turn resent ALL previous tool results. Truncating after 3 turns cuts peak input tokens by ~60%. |

### 🟡 Medium impact, medium effort — do this sprint

| # | Feature | What it does | Why we need it |
|---|---------|-------------|----------------|
| 3 | **Context hash gate** | Hash the user context before calling the LLM. If unchanged, reuse the previous scout disposition. Round prices to 2 sig figs so noise doesn't bust the cache. | During the blocked period (session 3), the agent made ~8 scout calls on nearly identical context (prices barely moved, no positions changed). This would skip those calls entirely — **$0 cost** on hold ticks. |
| 4 | **Compact number formatting** | `1234567` → `"1.23M"`, `12345` → `"12.3K"`. Piped table format for market data instead of prose. | The user context payload is ~4K tokens. Compact formatting reduces this by ~30-40%. Market data tables (price, volume, liquidity) are the biggest offenders. |
| 5 | **`maxHistoryTokens` budget** (replace count-based) | Cap conversation history by token count, not message count. `maxHistoryMessages: 20` → `maxHistoryTokens: 40_000`. | Prevents the 20-message-window from silently growing to 200K tokens. Simple config + small code change. |

### 🟢 Lower impact or already partially done — backlog

| # | Feature | Status | When |
|---|---------|--------|------|
| 6 | Memory entry truncation (`maxMemoryEntryChars`) | We have `maxToolResultChars: 4000` but no memory-specific truncation with `"... [read_memory for full]"` marker | When agents start using memory heavily |
| 7 | Older memory keys-only display | Not implemented | When memory key count grows past ~15 |
| 8 | Output `maxLength` constraints on reason fields | Not implemented — agent can emit 1,000-char rationales | When we see output token waste |
| 9 | `stripEmptyValues()` on LLM output | Not implemented | When we see parse failures from null/zero fields |
| 10 | Scout/judge model split | Already have the architecture (scout uses light model, judge uses heavy) but both use the same model today | When cost pressure demands it; just a config change |

### Summary: recommended implementation order

```
This sprint:  #1 (prompt caching) + #2 (stale tool truncation) = ~50% token savings
               #5 (token budget) = safety net against OOM crash recurrence
               
Next sprint:   #3 (context hash gate) = eliminates redundant scout calls
               #4 (compact formatting) = ~30% smaller prompts

Backlog:       #6–10 as usage patterns demand
```

The top two (#1 + #2) directly address the crash we observed: #2 prevents conversation history from growing unbounded within a tick, and #1 makes whatever history remains 90% cheaper for turns 2+. Together they would have cut the frenzy hour's 825K tokens to approximately **~150K** — well within the 512 MB container budget and at a fraction of the cost.