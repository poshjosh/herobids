# Agents

Documentation covering AI agent configuration and management on OpenAIdom.

- [Agent Style](/docs/agents/agent-style) — How agent styles control LLM budget and trading behavior.
- [Billing Limits](/docs/agents/billing-limits) — Soft caps, hard caps, and what happens when your agent hits its spending limit.

## Agent Presets

When creating an agent, you choose a preset that determines which tools and capabilities your agent has:

| Preset | Skills | Description |
|---|---|---|
| **Trading** | Trading, Bot management | Full trading autonomy — the agent can trade directly and create/manage automated bots. |
| **Direct Trading** | Trading | The agent trades directly but cannot create bots. |
| **Trading Assistant** | Trading | Trading analysis with per-trade user approval. The agent researches and proposes trades, but you must approve each one before execution. Trade Authorization defaults to **Approval required**. |
| **Personal Assistant** | Task management, Web access, Email | General-purpose assistant for tasks, research, and communication. No trading. |
| **Custom** | You choose | Full control over which skills to enable. |

## Trade Authorization

Trade Authorization (`authorizationMode`) controls how your agent's trade decisions reach the market. It applies to agents with the **Trading** capability.

| Mode | Behavior |
|---|---|
| **Direct** | The agent executes accepted trade decisions immediately with no human review. |
| **Approval required** | Each trade proposal is sent to you for approval before any market action. You approve or reject from the web app or Telegram using `/yes <code>` and `/no <code>`. |

The **Trading Assistant** preset defaults to Approval required. All other trading presets default to Direct, but you can change the mode at any time when creating or editing your agent.
