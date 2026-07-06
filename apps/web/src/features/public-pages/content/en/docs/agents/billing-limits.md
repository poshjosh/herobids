# Agent Billing Limits

HeroBids lets you set spending limits on your agent's LLM usage so you never get a surprise bill. There are two kinds of limits, and they behave very differently.

## Soft cap vs hard cap

| | Soft cap | Hard cap |
|---|---|---|
| **What it is** | An early-warning threshold | A spending stop |
| **Effect on your agent** | None — your agent keeps running normally | Your agent stops reasoning on the next tick |
| **What you receive** | A notification (Telegram, email, or both) telling you the cap has been reached and what happens next | A notification explaining that the agent has stopped, and whether any open trades remain unmanaged |

## Why the soft cap does not change agent behavior

Your agent's trading logic is yours. The platform does not silently degrade, pause, or alter how your agent thinks or trades just because a spending threshold was crossed.

The soft cap is purely a notification boundary. It tells you that spending is approaching the limit you set, so you can decide what to do — top up, raise the cap, or let it reach the hard cap.

## What happens at the hard cap

When spending reaches the hard cap:

1. The agent stops on the next tick (no further LLM calls are made).
2. You receive a notification explaining the stop.
3. If the agent has open positions, the notification makes this explicit — those positions will remain unmanaged until you take action.

The agent does **not** automatically close positions, submit orders, or change your trading state at the hard cap. It simply stops reasoning.

## What to do when a cap is reached

- **Top up** — Purchase additional credits from the Billing page.
- **Adjust caps** — Raise or remove the soft cap and/or hard cap from the Billing page.
- **Let it stop** — If you are comfortable with the stop, no action is needed. Your agent will resume on its next tick once spending is back under the cap.

## Open positions at the hard cap

This is the most important scenario to understand.

If your agent has open positions when the hard cap stops it, those positions will no longer be monitored or managed by the agent. No stop-loss checks, no take-profit evaluations, no regime reassessments.

You should treat a hard-cap stop with open positions as an event that needs your attention. The notification you receive will list the open positions so you can act.

## Setting your caps

Caps are set in two places:

1. **Plan defaults** — Your subscription plan may include default soft and hard caps. These are set by the platform operator and apply unless you override them.
2. **Billing page** — You can set your own soft cap and hard cap from the **Billing** page at any time. Your values override the plan defaults.

If you do not set any caps, no spending limits are enforced. Your agent will run until you stop it manually.

## Notifications

When a cap is reached, HeroBids notifies you through your configured channels (Telegram, email, or both). The notification includes:

- Which cap was reached (soft or hard)
- Current spending vs the cap
- Whether open positions exist
- What actions you can take
