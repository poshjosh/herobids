# ADR 004: Actor–Executor Separation

Status: Proposed  
Date: 2026-06-16

## Context

HeroBids defines four actor types (`agent`, `bot`, `user`, `system`) and treats
bots as first-class actors that submit decisions. However, a bot does not choose
**what** to trade — it is configured with an explicit instrument and mechanically
evaluates a strategy on that single pair. The entity that decides what to trade is
either a human (user creates the bot with a specific instrument) or an agent
(creates bots programmatically or trades directly).

With the unified agent model (agents have optional `technical` and `intelligence`
capabilities), agents gain multi-instrument discovery and autonomous instrument
selection. This makes the distinction between actors and executors critical:

- **Actors** — entities with agency that decide what to trade
- **Executors** — entities that execute decisions on a specific instrument

This distinction matters because:

1. The product vision is "trade for me, I have this wallet." Users should interact
   with actors (agents), not executors (bots).
2. Agents with `technical` capabilities need per-instrument execution but should
   not create heavyweight bot entities for each instrument.
3. The system currently conflates "submitting a decision" (agency) with "executing
   a decision" (plumbing), leading to bots being labeled actors when they have no
   agency over instrument selection.

## Decision

Separate the concepts of **Actor** and **Executor** in the domain model:

### Actor (has agency)

An actor is an entity that autonomously decides **what** to trade. It has:
- Discovery capability (finds instruments)
- Selection logic (picks which instruments to engage)
- Portfolio-level reasoning (manages multiple positions holistically)
- Lifecycle authority (starts/stops its own execution)

In HeroBids, the only actor is the **Agent** — configured with `technical`
capabilities (rule-based discovery + indicators), `intelligence` capabilities
(LLM reasoning), or both. The capability mix determines behavior, not actor type.

### Executor (no agency)

An executor carries out a decision on a specific instrument. It has:
- Order submission (venue interaction)
- Position tracking (fill accounting, P&L)
- Risk enforcement (stop-loss, drawdown limits)
- Plan generation (decision → concrete orders)

An executor does NOT:
- Discover instruments
- Choose what to trade
- Reason about portfolio allocation
- Have user-visible lifecycle independent of its parent actor

### The Bot's New Role

Bots transition from "user-facing actor" to "internal executor":

| Aspect | Before | After |
|---|---|---|
| User creates directly | Yes | Deprecated (agents handle this, or agent executes directly) |
| Appears in user's dashboard | Yes (primary) | De-emphasized / hidden behind agent view |
| Has agency | No (but labeled as actor) | No (correctly labeled as executor) |
| Created by | User or Agent | Agent (internally) or legacy user path |
| ActorType in decisions | `'bot'` | `'bot'` (retained for audit — identifies the execution path) |

### Decision Attribution

When a decision flows through the system:

```
Agent (technical-only) decides "go long ETH" from indicator scan:
  → actorType: 'agent', actorId: <agent-id>
  → execution happens inline (no separate bot entity)
  → order attributed to actorType: 'agent'

Agent (with intelligence) creates a bot for delegation:
  → actorType: 'agent' on the decision
  → bot executes the order: executorType: 'bot'
  → order carries both originType: 'agent' and executorType: 'bot'
```

### Execution Without Bots

Agents with `technical` capabilities may execute decisions without creating bot
entities:
- Use extracted execution infrastructure (plan → order → fill) directly
- Track positions in agent-scoped state (one agent, multiple instrument positions)
- No DB bot row per instrument — the agent IS the owner

Agents with `intelligence` may continue to create bots when they want independent
lifecycle:
- A bot gives the agent a "set and forget" executor it can stop thinking about
- This is a valid pattern — the agent delegates execution
- But it's the agent's choice, not a system requirement

### Agents Cannot Create Agents

Only users create agents. An agent that wants to test a strategy:
- Adds `technical` to its own config (live market testing)
- Calls the `run_backtest` tool (historical testing)

This prevents infinite recursion and maintains clear human accountability.

## Consequences

- Agents with `technical` can execute on N instruments without creating N bot rows
- User-facing product simplifies to "My Agents" with capability indicators
- Bot creation endpoints are retained but de-emphasized in user UX
- `ActorType` enum unchanged (`'agent' | 'bot' | 'user' | 'system'`) — bots
  remain a valid executor type for audit purposes
- Execution infrastructure must be extractable from `TradingActor` so both agents
  (directly) and bots (as delegates) can reuse it
- Existing AI agent bot-creation workflows continue to work unchanged
- Future: bots may be fully hidden behind an "advanced" toggle in the UI

## Risks

- **Migration complexity** — Existing users with bots need a smooth transition.
  Bots continue to work; this ADR changes framing, not runtime behavior.
- **Executor extraction** — Pulling plan/execute/persist logic out of
  `TradingActor` into a reusable module requires careful refactoring.
- **Audit trail** — Must preserve clear attribution: which agent made the
  decision, which executor submitted the order.
