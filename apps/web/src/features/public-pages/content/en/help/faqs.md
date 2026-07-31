# Frequently Asked Questions

## How do I talk to my agent from Telegram?

First, make sure your Telegram account is linked — go to **Settings** in the web app and enter your Telegram Chat ID. Your agent must be running.

Once set up, you have three options:

1. **Reply to an agent message** — When your agent sends you a message on Telegram, just reply to it. Your reply is automatically routed back to that agent. No special syntax needed.

2. **Use slash commands** — OpenAIdom supports a full set of Telegram commands for controlling your agents:
   - Messaging: `/to <agent> <message>` to talk to an agent
   - Discovery: `/agents`, `/info`, `/log`, `/connections`
   - Lifecycle: `/start`, `/pause`, `/resume`, `/stop`, `/restart`
   - Configuration: `/mode`, `/connect`, `/disconnect`
   
   Use `/help` in Telegram to see the full list. Use quotes if the agent name has spaces: `/to "DCA Bot" pause trading`. Use `/to all` or `/to *` to broadcast to every running agent at once.

3. **Plain message (single agent)** — If only one of your agents is running, just type your message normally. It will be delivered to that agent automatically.

## What is the scout-judge model, and how does escalation work?

OpenAIdom uses a two-stage LLM routing system to balance cost and decision quality:

- **Scout** — A cheaper, faster model that runs every tick. It does triage: scanning positions, checking market conditions, and deciding whether the situation is routine or needs deeper analysis.
- **Judge** — A more capable (and more expensive) model called in when the scout escalates. The judge has access to the full tool set and makes the actual trading decisions.

### When does escalation happen?

Three triggers can force escalation, bypassing the scout:

1. **First tick** — Every agent escalates on its very first tick so the judge can assess the initial state.
2. **Judge-scheduled reminder** — If the judge asks to be woken up at a specific time (e.g. "check back in 30 minutes"), that reminder always escalates.
3. **Open positions** — Controlled by your agent's **open position escalation policy**. You can set this in Advanced Settings when creating or editing an agent:
   - **Never** — The scout handles open positions on its own. Lowest cost, but the judge won't review your positions unless triggered by another rule.
   - **On missing coverage** — Escalates only when a position lacks active protection (no stop-loss, no take-profit, no active watch). This is the default for Balanced agents.
   - **Always** — Every tick with open positions goes straight to the judge. Highest cost, but ensures the most capable model reviews every position every time.

Your [agent style](/docs/agents/agent-style) sets the default policy (Careful → Never, Balanced → On missing coverage, Bold → Always), but you can override it manually at any time.

## What are billing limits, and what happens when I hit them?

OpenAIdom lets you set spending limits so you never get a surprise bill. There are two kinds:

- **Soft cap** — A warning threshold. When reached, you receive a notification (Telegram, email, or both) but your agent **keeps running normally**. No trading behavior changes.
- **Hard cap** — A spending stop. When reached, your agent halts on the next tick. No further LLM calls are made. You receive a notification explaining the stop, and if you have open positions, the notification lists them so you can act.

The hard cap never closes your positions automatically. It simply stops reasoning. If you have open positions at the hard cap, those positions become unmanaged until you top up, raise the cap, or take manual action.

You can set your own caps from the **Billing** page at any time. If you do not set any caps, no spending limits are enforced.

See [Agent Billing Limits](/docs/agents/billing-limits) for the full explanation.

## How do agents with "Filter" mode (scanner-gated) manage or close open positions?

Agents in **Filter** mode (`scanner_gated`) only receive trading decisions when the technical scanner wakes them — so it's natural to wonder how they handle exits if no position trigger is active.

The answer: **the scanner evaluates every open position on every cycle**, even when there are no new entry opportunities. It fetches live candles for each of your agent's open positions, checks the indicators (RSI, price action, etc.), and flags any that look like they should be closed.

There are two ways exits are handled:

1. **Advisory mode** (default) — When the scanner detects a potential exit, it wakes the LLM with an "exit review" section showing P&L, current price, and RSI. The agent then decides whether to close (`go_flat`) or hold each position. This gives you full control over exit decisions through your agent's reasoning.

2. **Autonomous mode** — When enabled, the scanner submits exit decisions directly without waking the LLM. This is faster (no delay waiting for the next scan cycle) and cheaper (fewer LLM calls). Recommended if you want quick exits without manual agent involvement. See [Agent Style](/docs/agents/agent-style) to understand how your agent style (Careful, Balanced, or Bold) affects exit behavior.

### What about stop-losses and take-profits?

These execute automatically regardless of mode. Per-trade stop-loss and take-profit levels, plus portfolio-wide drawdown limits, are **hard safety nets** that fire immediately — they don't wait for the next scanner cycle or an LLM decision. They protect your positions in real time.

> **Note:** If your agent hits a hard billing cap (see [Billing Limits](/docs/agents/billing-limits)), it will stop reasoning but **will not automatically close positions**. You'll need to act manually or adjust the cap.

> **Note:** If your agent hits a hard billing cap (see [Billing Limits](/docs/agents/billing-limits)), it will stop reasoning but **will not automatically close positions**. You'll need to act manually or adjust the cap.
