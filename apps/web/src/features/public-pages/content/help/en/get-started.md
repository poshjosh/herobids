# Get Started with HeroBids

HeroBids is an AI-first algorithmic trading platform. You create AI agents that reason about markets and trade on your behalf — across Hyperliquid perpetuals, Jupiter DEX swaps, and more.

## 1. Sign up

Go to the [HeroBids web app](/) and sign in. Your account is your control center — agents, bots, billing, and settings all live here.

## 2. Link Telegram (recommended)

Your agents can talk to you directly on Telegram. To set it up:

1. Go to **Settings** in the web app.
2. Enter your Telegram Chat ID.
3. Your agents will start sending you messages when they have updates, need input, or hit a billing cap.

See [Telegram Slash Commands](/docs/messaging/telegram/slash-commands) for how to talk back to your agents from Telegram.

## 3. Create your first agent

1. Go to **AI Agents** in the sidebar.
2. Click **New AI Agent**.
3. Give it a name and a goal — describe what you want it to trade and how.
4. Choose an **agent style** (Careful, Balanced, or Bold). This controls how aggressively it spends its LLM budget. See [Agent Style](/docs/agents/agent-style) for the full breakdown.
5. Optionally set billing caps from the **Billing** page to prevent surprise costs.

## 4. Start your agent

Once created, click **Start** on your agent. It will:

1. Run its first tick — the judge model assesses the initial market state.
2. Begin reasoning on its configured tick interval.
3. Send you a Telegram message when the session starts (if Telegram is linked).

## 5. Monitor and adjust

- **Mission Control** — Your dashboard shows agent activity, P&L, and alerts.
- **Activity Feed** — A chronological log of every agent action and decision.
- **Exposure** — See your current positions and risk across all agents.

## Where to go next

- [FAQs](/help/faqs) — Common questions about agents, Telegram, and billing.
- [Agent Style](/docs/agents/agent-style) — Understand how agent styles control cost and behavior.
- [Agent Billing Limits](/docs/agents/billing-limits) — Set spending caps so you never get a surprise bill.
- [Pricing](/help/pricing) — How HeroBids pricing works.
