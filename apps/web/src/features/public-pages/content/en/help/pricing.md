# Pricing

OpenAIdom pricing is transparent. You pay for what your agents use — no hidden fees, no surprises.

## Agent runtime

Each running agent costs a flat rate per minute to cover infrastructure (server compute, market data streams, database storage).

| | Rate |
|---|---|
| **Per agent, per minute** | $0.0001 |

This is billed continuously while your agent is running. If your agent is stopped, you are not charged.

## LLM usage

Your agents use large language models (LLMs) to reason about their tasks. LLM costs depend on the LLM you select and your agent's **style**:

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

LLM cost limits also depend on your agent's **style**:

| Style | Default daily limit | Tick interval | What it means |
|---|---|---|---|
| **Economy** | $3 | 90 min | Lowest cost. lower reasoning |
| **Standard** | $10 | 30 min | Moderate cost. Moderate speed and reasoning |
| **Premium** | $30 | 10 min | Highest cost. Fastest, deepest reasoning.  |
| **Custom** | You set it | Derived from budget | Full control over your daily spend. |

Your agent will typically use less than its daily limit/budget and will never exceed it. See [Agent Style](/docs/agents/agent-style) for the full breakdown of what each style controls.

## Billing caps (safety net)

Set optional spending limits so you never get a surprise bill:

- **Soft cap** — You get a notification when spending hits this threshold. Your agent keeps running.
- **Hard cap** — Your agent stops on the next tick. No further LLM calls are made.

If you do not set any caps, no spending limits are enforced. Your agent will run until you stop it manually.

See [Agent Billing Limits](/docs/agents/billing-limits) for details.