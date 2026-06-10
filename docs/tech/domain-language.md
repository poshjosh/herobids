# Domain Language

This document defines the canonical terms used across herobids — in code, documentation, and user interfaces.

When a term appears in a schema, API, UI, or document, it must match the definition here. If a term needs to change, update this document first.

---

## Agent

An isolated, LLM-driven reasoning runtime owned by a user.

An agent reads approved context, calls approved tools through the platform broker, and submits strategic intent (decisions) for one or more bots. It does not own execution authority. It cannot call venue APIs, write directly to the database, or access operator credentials.

Agents run in isolated containers. Crashes and resource usage are bounded per agent. One agent runtime = one container.

An agent has:
- a goal (natural language, user-provided)
- a skill preset (determines which capabilities and tools are available)
- zero or more bots it has created and manages

Agents do not have blueprints. An agent's instructions come entirely from its goal text and any context the user attaches at creation time. When an agent needs a bot, it creates one with the appropriate blueprint — it does not inherit a blueprint itself. In practice agents often create multiple bots simultaneously, each with a different blueprint, to test or run multiple strategies in parallel.

**The agent's goal text is the authoritative source of trading policy.** Platform defaults and bot blueprint risk parameters are data the agent reasons over — they are not constraints silently enforced over the agent's decisions. See [Agent Mode Purity](./agents/runtime-boundary-and-message-contract.md#agent-mode-purity).

**An agent has full lifecycle authority over its own bots.** It may create, start, stop, reconfigure, and delete bots without user confirmation. The agent acts autonomously within tenancy and execution boundaries.

See also: [Runtime Boundary And Message Contract](./agents/runtime-boundary-and-message-contract.md)

---

## Bot

A deterministic strategy executor owned by a user.

A bot applies a strategy against a venue account to produce trading decisions. It does not use an LLM. It owns execution authority within the bounds of its risk configuration.

A bot is defined by a **blueprint** and may be running or stopped at any time.

Every bot has a creator: an agent, a user, or the system. The creator is recorded as `creatorType` and `creatorId` on the bot record. There is no separate link table — ownership flows from the creator relationship.

An agent may own and run multiple bots simultaneously. The default platform cap is 5 concurrent running bots per agent (configurable via `agents.maxBotsPerAgent`).

---

## Blueprint

The configuration specification for a bot.

A blueprint captures what the bot is: which strategy, which venue account, which symbol or instrument, risk limits, and execution mode (paper, shadow, live). It is the stable, versioned, user-configured part of a bot.

The blueprint does not change when a bot is started or stopped. Changing the blueprint increments `configVersion`.

A bot run (session) always refers to the blueprint version it was started with.

---

## Bot Run (or Bot Session)

The operational record of one start-to-stop execution of a bot.

A bot run captures: when it started, when it stopped, which blueprint version it ran against, and what its final status was.

A bot run is transient. A blueprint is durable.

---

## Skill Preset

A bundled capability profile for an agent.

A skill preset determines which tools and capabilities are available to the agent. It is chosen at agent creation and is not changed at runtime in the MVP.

Examples:
- `trading` — decision submission, market data reads, send_message
- `reminder` — scheduled notifications, send_message
- `custom` — user-defined capability bundle

Skill presets belong on agents. Strategy presets (e.g. `momentum`) belong on bot blueprints.

---

## Strategy Preset

A bundled configuration profile for a bot blueprint.

A strategy preset selects default strategy parameters, risk defaults, and execution defaults. It is chosen at blueprint creation.

Examples: `momentum`, `dca`, `range`.

Strategy presets belong on bots. Skill presets belong on agents.

---

## Credential

A user-owned secret record for authenticating with an external provider or system.

A credential stores authentication material such as API keys, API secrets, passphrases, or private keys. Credentials are encrypted at rest and may be reused across multiple connections. A credential does not by itself grant an agent or bot permission to act; it only stores the secrets needed to authenticate.

---

## Connection

A user-owned platform link to an external provider or system.

A connection identifies the provider being linked, carries a user-facing label, and may reference one credential when the provider requires secrets. Connections are capability-agnostic: they represent that the user has linked something external, not what a specific agent or capability is allowed to do with it.

---

## Binding

A capability-specific target derived from a connection.

A binding adapts a connection into the shape required by a capability family. The primary example is a trading binding: the concrete trading target an agent can be granted access to. Grants, readiness, and audit history attach to bindings rather than raw connections so the platform can manage capability-specific access separately from the underlying provider link.

A trading binding serves the same conceptual role as a Venue Account for legacy API surfaces. New integrations should work with trading bindings; venue accounts remain for backward-compatible bot configuration.

---

## Venue Account

A user-owned connection to an external trading venue (e.g. a Hyperliquid API key, a Solana wallet address).

A venue account is the credential and identity used to trade on a specific venue. A bot blueprint references one venue account.

Users provide a venue account credential. The platform determines the venue type, available instruments, and supported execution modes automatically where possible.

---

## Decision

A proposal to change exposure on one instrument, submitted through the platform message protocol.

Decisions may originate from an agent, a bot, a user, or the system. They flow to the trading instance for planning, risk checking, and execution. The engine is the sole authority over whether a decision becomes an order.

---

## Trading Instance

The internal authoritative runtime for one configured bot session.

The trading instance owns planning, risk enforcement, execution, reconciliation, journaling, and durable state writes. It is the boundary that separates reasoning from execution.

In user-facing language, users see bots and blueprints. The trading instance is the internal engine concept that runs behind a bot.

---

## Actor

The logical author of an action, decision, message, or creation event.

Valid actor types:

| Type | Description |
|---|---|
| `agent` | An LLM-driven agent runtime |
| `bot` | A deterministic strategy executor |
| `user` | A human user of the platform |
| `system` | The platform itself (e.g. automated reconciliation, scheduled jobs) |

The actor concept is used in three places:

1. **Protocol messages** — every message envelope carries `initiatorType` and `initiatorId` identifying who sent it
2. **Decisions** — every decision record carries `actorType` and `actorId` identifying who produced it
3. **Bot creation** — every bot carries `creatorType` and `creatorId` identifying who created it

The protocol is actor-neutral: not all decisions or creations come from agents. The engine handles actions the same way regardless of actor type, subject to the authorization rules for that actor.

---

## Platform Safety Alert

A system-authored notification delivered to a user for a critical trust or safety event.

Safety alerts are non-configurable in the MVP. They are always delivered regardless of agent or user preferences. They are authored by the platform, not by the agent.

The fixed MVP safety-alert set:
1. Runtime unhealthy or heartbeat lost beyond threshold
2. Runtime failed to start or crashed
3. Agent paused or stopped by a guardrail or platform safety rule
4. Critical execution or reconciliation failure requiring operator attention
