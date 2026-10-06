# Agents

Documentation covering AI agent configuration and management on OpenAIdom.

- [What are AI agents?](/docs/agents/what-are-ai-agents) — A quick introduction to what AI agents are and what they can do.
- [How agent costs are kept low](/docs/agents/how-agent-costs-are-kept-low) — How OpenAIdom keeps long-running agents affordable.
- [Agent Style](/docs/agents/agent-style) — How agent styles control LLM budget and other cost-affecting behavior.
- [Billing Limits](/docs/agents/billing-limits) — Soft caps, hard caps, and what happens when your agent hits its spending limit.

## Authorization

Authorization (`authorizationMode`) controls how your agent's decisions reach the market.

| Mode | Behavior |
|---|---|
| **Direct** | The agent executes accepted decisions immediately with no human review. |
| **Approval required** | Each proposal is sent to you for approval before any market action. You approve or reject from the web app or Telegram using `/yes <code>` and `/no <code>`. |

Authorization defaults to Direct unless you set Approval required.
