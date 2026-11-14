# Agent Style

Agent style controls how deeply the agent reasons and how broadly it retains context. It determines tick cadence, tool-turn limits, token budgets, active hours, and context window sizes. Style is independent of the cost preset — you can run a **Bold** agent on cheap models, or a **Careful** agent on premium models.

## Styles

Three built-in styles are available: **Careful**, **Balanced**, and **Bold**. Individual fields can be overridden after selecting a base style.

### Cost & Cadence

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Default cost preset** | Standard | Premium | Premium |
| **Daily spend budget (default)** | $1 | $5 | $30 |
| **Tick interval** | 30 min | 10 min | 10 min |
| **Open position escalation** | On missing coverage | Always | Always |

### Tool Turn Limits

Turn caps are runaway-loop protection rather than behavioural tuning, so they are uniform across all styles.

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Scout max turns** | 499 | 499 | 499 |
| **Judge max turns** | 9,999 | 9,999 | 9,999 |

### LLM Token Limits

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Scout max tokens** | 1,024 | 2,048 | 4,096 |
| **Judge max tokens** | 4,096 | 8,192 | 16,384 |
| **Light thinking tokens** | 2,048 | 4,096 | 8,192 |
| **Deep thinking tokens** | 10,240 | 20,480 | 32,768 ¹ |

¹ Bold's deep thinking budget is clamped to the operator ceiling of 32,768 (the unclamped value would be 40,960).

### Reasoning

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Economy (scout) reasoning** | Medium | Medium | Medium |
| **Judge reasoning** | Medium | High | High |

Economy models already keep costs low, so every style uses at least medium reasoning for the economy model.

### Active Hours

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Allowed hours (UTC)** | All hours | All hours | All hours |
| **Weekend pause** | ❌ No | ❌ No | ❌ No |

### Context Budgets

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Max history messages** | 20 | 40 | 80 |
| **Max history tokens** | 40,000 | 80,000 | 160,000 |
| **Max recent tool messages** | 6 | 12 | 24 |
| **Max tool result chars** | 4,000 | 8,000 | 16,000 |
| **Max visible tool schemas** | 64 | 128 | 256 |
| **Max context block chars** | 4,000 | 8,000 | 16,000 |
| **Tool result full retention turns** | 3 | 5 | 10 |
| **Tool result max stale chars** | 500 | 1,000 | 2,000 |

### Scout Hold

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Max hold duration** | 90 min | 10 min | 10 min |

## What each field means

**Tick interval** — How often the agent wakes up to reason and act. Shorter intervals mean faster reactions but higher cost.

See [FAQs](/help/faqs#when-does-escalation-happen) for more on the scout-judge model.

**Scout max turns / Judge max turns** — The maximum number of tool-call rounds the scout (cheaper model) or judge (more capable model) may perform in a single tick. Higher values allow deeper research but increase cost and latency.

**Scout/Judge max tokens** — The maximum number of output tokens the model may generate per turn. Keeps individual responses concise.

**Light / Deep thinking tokens** — How many tokens the model may use for internal chain-of-thought reasoning before producing a response. `lightThinkingTokens` applies when brief reasoning is sufficient; `deepThinkingTokens` applies when extended analysis is requested.

**Allowed hours (UTC)** — The UTC hours during which the agent is permitted to act. An empty list means all hours are allowed. All three styles default to all hours; restrict activity to a specific window by overriding this field.

**Weekend pause** — When enabled, the agent skips routine ticks over the weekend (Saturday 00:00 UTC through Sunday 12:00 UTC), but only while it has no open positions — ticks continue so it can manage existing positions.

**Max history messages** — How many past conversation messages are included in each tick's context window.

**Max history tokens** — A token-count ceiling on the history carried into each tick, regardless of message count.

**Max recent tool messages** — How many of the most recent tool-call/result pairs are kept verbatim (beyond this limit, older results are truncated).

**Max tool result chars** — Character limit for a single tool result included at full fidelity. Results exceeding this are truncated.

**Max visible tool schemas** — How many tool definitions are shown to the model per tick. Limiting this reduces prompt size and directs the model's attention.

**Max context block chars** — Character limit for a single context block (e.g. a data snapshot or skill output) injected into the prompt.

**Tool result full retention turns** — How many turns a tool result is kept at full length before being compressed to the stale limit.

**Tool result max stale chars** — How many characters of a stale tool result to retain after the full-retention window expires.

**Max hold duration** — How long the scout may hold a decision open before it is considered expired and replaced by the next tick's output.

## Selecting a style

- **Careful** — Long-horizon or cost-sensitive agents. Longest tick interval, most compact context, and the longest scout hold window.
- **Balanced** — General-purpose agents. Moderate context and standard token budgets.
- **Bold** — High-frequency or time-sensitive agents. Largest token and context budgets. Runs 24/7 like the other styles.

To go beyond a preset, select a base style and override individual fields in **Advanced Settings → Runtime Policy**.

## Billing limits

Agent style sets the default daily spend budget and cost preset, but does not enforce a hard ceiling. Separate from style, you can set **spending caps** (soft and hard limits) from the Billing page.

See [Agent Billing Limits](/docs/agents/billing-limits) for details.
