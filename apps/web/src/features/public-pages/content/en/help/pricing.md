# Pricing

OpenAIdom pricing is transparent. You pay for what your agents use — no hidden fees, no surprises. See [agent billing limits](/docs/agents/billing-limits) for how we help prevent surprise bills.

## Subscription Plans

OpenAIdom has various subcription plans. Including `Starter` and `Pro`. These plans give you additional entitlements (e.g. allows you sell your skills or agent's blueprint in our marketplace). However, **you do not have to subscribe, to use our platform**. 

Subscription is optional. However, you pay for agent runtime and LLM usage.

## Agent runtime

Each running agent costs a flat rate per minute to cover infrastructure (server compute, data streams, database storage).

| | Rate |
|---|---|
| **Per agent, per minute** | $0.0001 |

This is billed continuously while your agent is running. If your agent is stopped, you are not charged.

## Browser sessions

When an agent uses the `browse_interactive` tool (via the `system/browser` skill), browser time is billed separately from agent runtime.

| | Rate |
|---|---|
| **Per browser session, per minute** | $0.0002 |

Browser sessions are billed for the duration between opening and closing a session. Sessions are automatically closed and billed when an agent stops.

## LLM usage

Your agents use large language models (LLMs) to reason about their tasks. LLM costs depend on the LLM you select. The cost of LLM is not set by OpenAIdom. You pay whatever the LLM provider set as the cost of its llm. OpenAIdom uses LLM gateways/aggregators (e.g. openrouter) which simplifies serving/paying for multiple LLMs. LLM costs also depend on your agent's **style**. The table below provides example cost for heavy use across various **styles**:

| LLM | Est. cost/run | Est. cost/day **Economy** | Est. cost/day **Standard** | 
|---|---|---|---|
| Deepseek v4 flash | $0.015 | $0.25 | $0.74 |
| Deepseek v4 pro | $0.054 | $0.87 | $2.59 |
| Claude Sonnet 5 | $0.2 | $3.2 | $9.6 |
| GPT 5.5 | $0.55 | $8.8 | $26.4 |
| Claude Fable 5 | $1.00 | 16 | $48 |

Notes:

- _We estimated a run would cost 50k output and 10k input tokens. This is usually for heavy users. Most runs will cost less._
- _Updated 15 July 2026_

Learn [how OpenAIdom keeps agent costs low](/docs/agents/how-agent-costs-are-kept-low) through smart model routing, wake filtering, and disciplined engineering.

## Cost limits

Your agent's **style** sets a default daily spend target that shapes how often it wakes up and how deeply it reasons. If you do not override it, the default depends on the style:

| Style | Default daily spend target | Tick interval | What it means |
|---|---|---|---|
| **Careful** | $1 | 90 min | Lowest cost. Lower reasoning, longer gaps between ticks. |
| **Balanced** | $5 | 30 min | Moderate cost. Moderate speed and reasoning. |
| **Bold** | $30 | 10 min | Highest cost. Fastest, deepest reasoning. |
| **Custom** | You set it | Derived from your settings | Full control over your daily spend target. |

The per-style value is a **spend target**, not a hard cap — it influences cadence and cost estimates, but it does not stop your agent once reached. Your agent will typically spend less than its target, though it can exceed it.

To put a real ceiling on spending, use the account **spending caps** (soft and hard limits) described in [agent billing limits](/docs/agents/billing-limits). Those caps are what actually stop an agent when a limit is reached. 

## Related

See [Agent Style](/docs/agents/agent-style) for the full breakdown of what each style controls.

See [Agent Billing Limits](/docs/agents/billing-limits) for how we prevent surprise bills.