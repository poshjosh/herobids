# Pricing

OpenAIdom pricing is transparent. You pay for what your agents use — no hidden fees, no surprises.

## Agent runtime

Each running agent costs a flat rate per minute to cover infrastructure (server compute, market data streams, database storage).

| | Rate |
|---|---|
| **Per agent, per minute** | $0.0001 |

This is billed continuously while your agent is running. If your agent is stopped, you are not charged.

## LLM usage

Your agents use large language models to reason about markets and make trading decisions. LLM costs depend on your agent's **style**:

| Style | Daily budget (default) | Tick interval | What it means |
|---|---|---|---|
| **Careful** | $3/day | 90 min | Lowest cost. All cost-saving gates active. For long-horizon agents. |
| **Balanced** | $10/day | 30 min | Moderate cost. Good for general-purpose trading. |
| **Bold** | $30/day | 10 min | Highest cost. Fastest cadence, deepest reasoning. For time-sensitive strategies. |
| **Custom** | You set it | Derived from budget | Full control over your daily spend. |

Your agent will never exceed its daily LLM budget. See [Agent Style](/docs/agents/agent-style) for the full breakdown of what each style controls.

## Billing caps (safety net)

Set optional spending limits so you never get a surprise bill:

- **Soft cap** — You get a notification when spending hits this threshold. Your agent keeps running.
- **Hard cap** — Your agent stops on the next tick. No further LLM calls are made.

If you do not set any caps, no spending limits are enforced. Your agent will run until you stop it manually.

See [Agent Billing Limits](/docs/agents/billing-limits) for details.

## Estimating your monthly cost

A **Balanced** agent running 24/7:

| Component | Calculation | Monthly |
|---|---|---|
| Runtime | 43,200 min × $0.0001 | $4.32 |
| LLM (Balanced) | 30 days × $10 | $300.00 |
| **Total** | | **~$304.32** |

A **Careful** agent running 24/7:

| Component | Calculation | Monthly |
|---|---|---|
| Runtime | 43,200 min × $0.0001 | $4.32 |
| LLM (Careful) | 30 days × $3 | $90.00 |
| **Total** | | **~$94.32** |

You only pay for runtime when your agent is actively running. Pause it anytime to stop runtime charges.
