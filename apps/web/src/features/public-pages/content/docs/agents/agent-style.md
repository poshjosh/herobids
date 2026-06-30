# Agent Style

Agent style controls how deeply the agent reasons and how broadly it retains context. It determines tick cadence, tool-turn limits, token budgets, trading hours, and context window sizes. Style is independent of the cost preset — you can run a **Bold** agent on cheap models, or a **Careful** agent on premium models.

## Styles

Three built-in styles are available: **Careful**, **Balanced**, and **Bold**. Individual fields can be overridden after selecting a base style.

### Cost & Cadence

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Default cost preset** | Minimal | Standard | Premium |
| **Daily spend budget (default)** | $3 | $10 | $30 |
| **Tick interval** | 90 min | 30 min | 10 min |
| **Open position escalation** | Never | On missing coverage | Always |

### Tool Turn Limits

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Scout max turns** | 10 | 30 | 100 |
| **Judge max turns** | 25 | 75 | 300 |

### LLM Token Limits

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Scout max tokens** | 512 | 1,024 | 2,048 |
| **Judge max tokens** | 2,048 | 4,096 | 8,192 |
| **Light thinking tokens** | 1,024 | 2,048 | 4,096 |
| **Deep thinking tokens** | 4,096 | 10,240 | 20,480 |

### Trading Hours

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Allowed hours (UTC)** | 14–20 (US overlap) | All hours | All hours |
| **Weekend pause** | ✅ Yes | ✅ Yes | ❌ No |

### Context Budgets

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Max history messages** | 10 | 20 | 40 |
| **Max history tokens** | 20,000 | 40,000 | 80,000 |
| **Max recent tool messages** | 3 | 6 | 12 |
| **Max tool result chars** | 2,000 | 4,000 | 8,000 |
| **Max visible tool schemas** | 32 | 64 | 128 |
| **Max context block chars** | 2,000 | 4,000 | 8,000 |
| **Tool result full retention turns** | 2 | 3 | 5 |
| **Tool result max stale chars** | 250 | 500 | 1,000 |

### Scout Hold

| | **Careful** | **Balanced** | **Bold** |
|---|---|---|---|
| **Max hold duration** | 180 min | 60 min | 30 min |

## What each field means

**Tick interval** — How often the agent wakes up to reason and act. Shorter intervals mean faster reactions but higher cost.

**Open position escalation** — When you have open positions, should the scout automatically escalate to the judge (the more capable model) every tick, or let the cheaper scout model handle routine checks?

- **Never** — the scout inspects every tick; the judge is never called for routine position checks.
- **On missing coverage** — escalates only when a position lacks active monitoring (e.g. no stop-loss or take-profit covering it), or when a trigger condition fires.
- **Always** — the judge reviews every tick.

See [FAQs](/help/faqs#when-does-escalation-happen) for more on the scout-judge model.

**Scout max turns / Judge max turns** — The maximum number of tool-call rounds the scout (cheaper model) or judge (more capable model) may perform in a single tick. Higher values allow deeper research but increase cost and latency.

**Scout/Judge max tokens** — The maximum number of output tokens the model may generate per turn. Keeps individual responses concise.

**Light / Deep thinking tokens** — How many tokens the model may use for internal chain-of-thought reasoning before producing a response. `lightThinkingTokens` applies when brief reasoning is sufficient; `deepThinkingTokens` applies when extended analysis is requested.

**Allowed hours (UTC)** — The UTC hours during which the agent is permitted to trade. An empty list means all hours are allowed. **Careful** restricts trading to 14:00–20:00 UTC (US session overlap).

**Weekend pause** — When enabled, the agent suspends trading from Friday close to Monday open.

**Max history messages** — How many past conversation messages are included in each tick's context window.

**Max history tokens** — A token-count ceiling on the history carried into each tick, regardless of message count.

**Max recent tool messages** — How many of the most recent tool-call/result pairs are kept verbatim (beyond this limit, older results are truncated).

**Max tool result chars** — Character limit for a single tool result included at full fidelity. Results exceeding this are truncated.

**Max visible tool schemas** — How many tool definitions are shown to the model per tick. Limiting this reduces prompt size and directs the model's attention.

**Max context block chars** — Character limit for a single context block (e.g. a market snapshot or skill output) injected into the prompt.

**Tool result full retention turns** — How many turns a tool result is kept at full length before being compressed to the stale limit.

**Tool result max stale chars** — How many characters of a stale tool result to retain after the full-retention window expires.

**Max hold duration** — How long the scout may hold a decision open before it is considered expired and replaced by the next tick's output.

## Selecting a style

- **Careful** — Long-horizon or cost-sensitive agents. Restricted to US session hours, weekday-only, shallow tool loops, compact context.
- **Balanced** — General-purpose trading agents. Runs 24/7 weekdays, moderate tool depth, standard context.
- **Bold** — High-frequency or time-sensitive agents. Runs 24/7 including weekends, deepest tool loops, largest context window.

To go beyond a preset, select a base style and override individual fields in **Advanced Settings → Runtime Policy**.

## Billing limits

Agent style sets the default daily spend budget and cost preset, but does not enforce a hard ceiling. Separate from style, you can set **spending caps** (soft and hard limits) from the Billing page.

See [Agent Billing Limits](/docs/agents/billing-limits) for details.
