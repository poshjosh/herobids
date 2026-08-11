# Agent Billing Limits

OpenAIdom enforces spending limits on your agent's LLM usage so you never get a surprise bill. Limits are set by your subscription plan and apply automatically. There are two kinds of limits, and they behave very differently.

## Soft cap vs hard cap

| | Soft cap | Hard cap |
|---|---|---|
| **What it is** | An early-warning threshold | A spending stop |
| **Effect on your agent** | None — your agent keeps running normally | Your agent stops reasoning on the next tick |
| **What you receive** | A notification (Telegram, email, or both) telling you the cap has been reached and what happens next | A notification explaining that the agent has stopped, and whether any open trades remain unmanaged |

## Why the soft cap does not change agent behavior

Your agent's trading logic is yours. The platform does not silently degrade, pause, or alter how your agent thinks or trades just because a spending threshold was crossed.

The soft cap is purely a notification boundary. It tells you that spending is approaching your plan's hard limit, so you can decide what to do — top up, upgrade your plan, or let it reach the hard cap.

## What happens at the hard cap

When spending reaches the hard cap:

1. The agent stops on the next tick (no further LLM calls are made).
2. You receive a notification explaining the stop.
3. If the agent has open positions, the notification makes this explicit — those positions will remain unmanaged until you take action.

The agent does **not** automatically close positions, submit orders, or change your trading state at the hard cap. It simply stops reasoning.

The hard-cap boundary is exact. For example:

- If your plan's hard cap is **$1.00**, paid usage stops once your balance reaches exactly **-$1.00** — not -$0.99, not after the next tick.
- If your plan's hard cap is **$0.00**, paid usage stops at exactly $0.00 (i.e. once your included credits are exhausted).
- If your plan **has no hard cap**, no hard limit is enforced — your agent can continue spending until stopped manually.

## What to do when a cap is reached

- **Top up** — Purchase additional credits from the Billing page to move your balance back above the cap.
- **Upgrade your plan** — Higher-tier plans include more included credits and higher spending limits.
- **Let it stop** — If you are comfortable with the stop, no action is needed. Your agent will resume on its next tick once spending is back under the cap.

## Open positions at the hard cap

This is the most important scenario to understand.

If your agent has open positions when the hard cap stops it, those positions will no longer be monitored or managed by the agent. No stop-loss checks, no take-profit evaluations, no regime reassessments.

You should treat a hard-cap stop with open positions as an event that needs your attention. The notification you receive will list the open positions so you can act.

## Where caps come from

Caps are set by your subscription plan:

- **Plan defaults** — Every plan tier includes a soft cap and a hard cap configured by the platform operator. These apply automatically to all agents under your account.
- **No manual override** — You cannot set custom caps from the Billing page. If your current plan's limits are too restrictive, upgrading to a higher tier is the way to get more headroom.

If your plan has no caps configured, no spending limits are enforced. Your agent will run until you stop it manually.

## Notifications

When a cap is reached, OpenAIdom notifies you through your configured channels (Telegram, email, or both). The notification includes:

- Which cap was reached (soft or hard)
- Current spending vs the cap
- Whether open positions exist
- What actions you can take