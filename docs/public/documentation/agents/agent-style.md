# Agent Style

Agent style controls how aggressively the AI agent spends its daily LLM budget. It determines tick cadence, which model is used for reasoning, which cost-saving gates are active, and the default thinking depth.

## Styles

| | **Careful** | **Balanced** | **Bold** | **Custom** |
|---|---|---|---|---|
| **Daily budget (default)** | $3 | $10 | $30 | $5 (or user input) |
| **Tick interval** | 90 min | 30 min | 10 min | Derived from budget |
| **Heavy model** | Same as light model | Full heavy model | Full heavy model | ≤$3: light model; >$3: heavy model |
| **Session gate** | ✅ On | ❌ Off | ❌ Off | ✅ On |
| **Regime gate** | ✅ On | ✅ On | ❌ Off | ✅ On |
| **Context-hash gate** | ✅ On | ✅ On | ✅ On | ✅ On |
| **Adaptive interval** | ✅ On | ❌ Off | ❌ Off | ✅ On |
| **Open position escalation** | Never | On missing coverage | Always | ≤$3: never; >$3: on missing coverage |
| **Default thinking depth** | None | Light | Deep | ≤$3: none; >$3: light |

## What each field means

**Tick interval** — How often the agent wakes up to reason and act. Shorter intervals mean faster reactions but higher cost.

**Heavy model** — The more capable (and expensive) model used for complex reasoning steps. On **Careful**, the agent uses its light model for everything to stay within budget.

**Session gate** — Skips a tick if the agent's context hash and market regime match the previous session, indicating nothing has materially changed.

**Regime gate** — Skips a tick if the market regime (trend, volatility) is unchanged from the last tick.

**Context-hash gate** — Skips a tick if the full reasoning context is identical to the previous tick (e.g. no new fills, unchanged positions, same prices).

**Adaptive interval** — Automatically widens the tick interval during quiet periods to conserve budget, then tightens it when significant events occur.

**Open position escalation** — When you have open positions, should the scout automatically escalate to the judge (the more capable model) every tick, or let the cheaper scout model handle routine checks? 

- **Never** lets the scout inspect first; 
- **On missing coverage** escalates only when a position lacks active monitoring (e.g. no stop-loss or take-profit order covering it). 
- **Always** forces the judge to review every tick; 

See [FAQs](/help/faqs#scout-judge-escalation) for more on the scout-judge model.

**Thinking depth** — Controls how much internal chain-of-thought reasoning the model performs before producing a response. `none` = direct answer; `light` = brief reasoning; `deep` = extended reasoning.

## Selecting a style

- **Careful** — Long-horizon agents that check in infrequently or have tight cost budgets. All cost-saving gates are active.
- **Balanced** — General-purpose trading agents. Balanced cadence and reasoning quality.
- **Bold** — High-frequency or time-sensitive agents. Fastest cadence, deepest reasoning, no skipping gates.
- **Custom** — Set your own daily budget and let the system derive the cadence and model routing automatically.

## Billing limits

Agent style controls how your agent spends within its daily budget. Separate from style, you can also set **spending caps** (soft and hard limits) from the Billing page. These caps protect you from surprise bills without changing how your agent trades.

See [Agent Billing Limits](/documentation/agents/billing-limits) for details.
