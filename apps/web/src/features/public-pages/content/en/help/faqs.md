# Frequently Asked Questions

## How do approvals work?

If your agent's Authorization is set to **Approval required**, the agent won't execute actions on its own. Instead, it sends each proposal to you for review.

Each proposal includes:
- What the agent wants to do (buy/sell, size, price)
- A confidence score and rationale
- A **6-character short code** (e.g. `26B8D`)

You have three ways to respond:

1. **Telegram** — Use `/yes 26B8D` to approve or `/no 26B8D` to reject. Always include the code. Code-less `/yes` and `/no` only work when you have exactly one pending approval.

2. **Web app** — Go to your agent's detail page and use the **Approvals** panel. Click **Approve** or **Reject** on any pending proposal.

3. **API** — Use the approvals API endpoints for programmatic resolution.

Approvals expire after a configurable time window (default 24 hours). Expired approvals cannot be actioned — the agent will submit a new proposal if it still wants to act.

See [Authorization](/docs/agents/#authorization) for more on configuring authorization mode.

## How do I talk to my agent from Telegram?

First, make sure your Telegram account is linked — go to **Settings** in the web app and enter your Telegram Chat ID. Your agent must be running.

Once set up, you have three options:

1. **Reply to an agent message** — When your agent sends you a message on Telegram, just reply to it. Your reply is automatically routed back to that agent. No special syntax needed.

2. **Use slash commands** — OpenAIdom supports a full set of Telegram commands for controlling your agents:
   - Messaging: `/to <agent> <message>` to talk to an agent
   - Discovery: `/agents`, `/info`, `/log`, `/connections`
   - Lifecycle: `/start`, `/pause`, `/resume`, `/stop`, `/restart`
   - Configuration: `/mode`, `/connect`, `/disconnect`
   
   Use `/help` in Telegram to see the full list. Use quotes if the agent name has spaces: `/to "My PA" Re-send yesterdays report`. Use `/to all` or `/to *` to broadcast to every running agent at once.

3. **Plain message (single agent)** — If only one of your agents is running, just type your message normally. It will be delivered to that agent automatically.

## What is the scout-judge model, and how does escalation work?

OpenAIdom uses a two-stage LLM routing system to balance cost and decision quality:

- **Scout** — A cheaper, faster model that runs every tick. It does triage to decide whether the situation is routine or needs deeper analysis.
- **Judge** — A more capable (and more expensive) model called in when the scout escalates. The judge has access to the full tool set and makes the actual decisions.

### When does escalation happen?

Two triggers can force escalation, bypassing the scout:

1. **First tick** — Every agent escalates on its very first tick so the judge can assess the initial state.
2. **Judge-scheduled reminder** — If the judge asks to be woken up at a specific time (e.g. "check back in 30 minutes"), that reminder always escalates.

## What are billing limits, and what happens when I hit them?

OpenAIdom lets you set spending limits so you never get a surprise bill. There are two kinds:

- **Soft cap** — A warning threshold. When reached, you receive a notification (Telegram, email, or both) but your agent **keeps running normally**. No behavior changes.
- **Hard cap** — A spending stop. When reached, your agent halts on the next tick. No further LLM calls are made. You receive a notification explaining the stop, and if you have pending actions, the notification lists them so you can act.

You can set your own caps from the **Billing** page at any time. If you do not set any caps, no spending limits are enforced.

See [Agent Billing Limits](/docs/agents/billing-limits) for the full explanation.
