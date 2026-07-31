# Glossary

An alphabetic reference of terms used across the OpenAIdom platform.

## Actor

The author of an action, decision, message, or creation event. Valid types: `agent`, `bot`, `user`, `system`.

## Agent

An AI that works on your behalf. Agents respond to you, use tools, and help achieve your goals. An agent can help you trade, respond to emails, do your taxes, handle basic legal claims etc

## Agent Guardrail

Guardrails control agent behavior — tool allowlists, time budgets, pause state, request limits. Does not replace safety checks.

## Agent Mode Purity

Your agent's goal text and your explicit constraints determine how your agent trades. The platform won't add hidden restrictions you didn't ask for. System-level rules (execution mode, slippage, retries) are always enforced.

## Approval

A trade proposal that is waiting for your review before execution. When your agent's Trade Authorization is set to **Approval required**, each trade decision becomes an approval you must explicitly approve or reject. Approvals expire after a configurable time window.

## Approval Code

A 6-character short code (e.g. `26B8D`) that identifies a specific pending approval. Use it with Telegram slash commands (`/yes 26B8D`, `/no 26B8D`) or the web Approvals panel.

## Authorization Mode

Controls whether your agent's trade decisions execute immediately or wait for your approval. Two modes: **Direct** (immediate execution) and **Approval required** (each trade waits for user approval). Set when creating or editing a trading-capable agent.

---

## Binding

A permission granted from a connection. Think of a connection as "link to service X" and a binding as "grant agent Y permission to use the link to service X."

## Blueprint

The configuration that defines a bot — which strategy, which exchange account, which asset, risk limits, and execution mode. Blueprints are versioned and stable.

## Bot

An automated trading strategy. Bots follow a blueprint to trade on your behalf. Unlike agents, bots generally donot use AI — they follow predefined, rule-based strategies.

## Bot Run

One start-to-stop execution cycle of a bot. Records when it ran, which blueprint version it used, and how it ended.

## BPS (Basis Point)

One-hundredth of a percent (0.01%). 100 BPS = 1%. Used for slippage, fees, and thresholds throughout the platform.

---

## Connection

A link you've established between the platform and an external service (e.g. an exchange). Connections may reference a credential for authentication. Linking a service doesn't automatically grant trading permission — connections and permissions are separate.

## Credential

Your secret for authenticating with an external service — API keys, secrets, passphrases, or private keys. Encrypted at rest and reusable across connections.

---

## dailyLossLimit

A hard cap on how much your agent can lose in a rolling 24-hour window. Set in USD (or your account's base currency). If you don't set one, the platform applies a default limit based on a percentage of your capital.

## Decision

A proposal to change your exposure on an asset. Decisions are sent from agents or bots to the platform, which validates and executes them. The platform has the final say — a decision is a request, not a guarantee.

---

## Execution Mode

How your trades reach the market:

- **Test** — Simulated trading. Tracks real market data but does not place real orders. No real money at risk.
- **Live** — Real orders on real exchanges. Real capital at risk.

---

## globalMaxDrawdownPct

A platform-wide drawdown limit as a percentage. Applies to trading done outside of agents.

---

## maxDrawdown

Absolute dollar ceiling on how far your equity can fall from its peak. For agents, the percentage-based `maxDrawdownPct` is used instead.

## maxDrawdownPct

A hard cap on peak-to-current equity drawdown as a percentage. If your equity falls this far below its peak, trading stops. You set this on your agent; if you don't, the platform applies a default.

## maxOpenPositions

The maximum number of positions your agent can hold at once. Agents can lower this at runtime but can't exceed the platform's absolute maximum.

---

## Platform Safety Alert

A critical notification from the platform itself — not from your agent. Delivered for events like crashes, forced stops, or position mismatches with the exchange. Always on; you can't opt out.

---

## Reconciliation

The process of comparing what the platform thinks your positions are against what the exchange says they are. If there's a mismatch beyond acceptable limits, trading may be blocked until it's resolved.

---

## Skill Preset

A bundled set of capabilities for an agent. Determines which tools your agent can use. Chosen when you create the agent. Examples: `trading`, `direct-trading`, `trading-assistant`, `personal-assistant`.

## Slippage

The difference between the price you expected and the price you got. The platform simulates realistic slippage in test mode.

## stopLossCooldownMs

How long your agent must wait after a stop-loss exit before it can re-enter a position. Default: 5 minutes.

## Strategic Intent

What your agent wants to achieve — the desired final exposure, not a specific order. The platform figures out how to get there.

## Strategy Preset

A bundled configuration for a bot blueprint — default strategy parameters, risk limits, and execution settings. Examples: `momentum`, `dca`, `range`.

---

## targetSize

The desired final position size for an asset. This is the end goal, not the size of the next order. The platform plans the steps to reach it.

## Tick

One iteration of your agent's thinking cycle. On each tick, the agent reads context, may use tools, and may submit decisions. Tick speed depends on your agent's style.

## Trading Instance

The system that powers a bot behind the scenes. Handles planning, risk checks, execution, and state tracking. Users interact with bots; the platform runs trading instances.

---

## Venue Account

Your connection to a specific exchange (e.g. a Hyperliquid API key, a Solana wallet). Each bot blueprint references one venue account.
