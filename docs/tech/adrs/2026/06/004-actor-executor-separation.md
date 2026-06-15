# ADR 004: Actor–Executor Separation

Status: Proposed  
Date: 2026-06-16

## Context

HeroBids defines four actor types (`agent`, `bot`, `user`, `system`) and treats
bots as first-class actors that submit decisions. However, a bot does not choose
**what** to trade — it is configured with an explicit instrument and mechanically
evaluates a strategy on that single pair. The entity that decides what to trade is
either a human (user creates the bot with specific instrument) or an AI Agent
(creates bots programmatically).

With the introduction of Automation Agents (rule-based, multi-instrument actors
that discover and select instruments autonomously), we need to clarify the
distinction between:

- **Actors** — entities with agency that decide what to trade
- **Executors** — entities that execute decisions on a specific instrument

This distinction matters because:

1. The product vision is "trade for me, I have this wallet." Users should interact
   with actors (agents), not executors (bots).
2. Automation Agents need execution infrastructure but should not create full bots
   for each instrument — that's heavyweight and semantically wrong (a bot implies
   user-visible lifecycle).
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

Actor types:
- **AI Agent** — LLM-driven, multi-instrument, reasons via tools and prompts
- **Automation Agent** — rule-driven, multi-instrument, reasons via indicators and filters

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
| User creates directly | Yes | Deprecated (agents create them, or they become invisible executors) |
| Appears in user's dashboard | Yes (primary) | De-emphasized / hidden behind agent view |
| Has agency | No (but labeled as actor) | No (correctly labeled as executor) |
| Created by | User or AI Agent | AI Agent or Automation Agent (internally) |
| ActorType in decisions | `'bot'` | `'bot'` (retained for audit — the executor that physically submitted) |

### Decision Attribution

When a decision flows through the system:

```
AI Agent decides "go long ETH"
  → actorType: 'agent', actorId: <agent-id>
  → executor submits the order (bot or inline)
  → order attributed to originType: 'agent', executorType: 'bot'

Automation Agent decides "go long ETH" (from indicator scan)
  → actorType: 'agent', actorId: <automation-agent-id>
  → execution happens inline (no separate bot entity needed)
  → order attributed to actorType: 'agent'
```

### Execution Without Bots

Automation Agents may execute decisions without creating bot entities:
- Use extracted execution infrastructure (plan → order → fill) directly
- Track positions in agent-scoped state (one agent, multiple instrument positions)
- No DB bot row per instrument — the agent IS the owner

AI Agents may continue to create bots when they want independent lifecycle:
- A bot gives the AI Agent a "set and forget" executor it can stop thinking about
- This is a valid pattern — the AI Agent delegates execution
- But it's the agent's choice, not a system requirement

## Consequences

- Automation Agents can execute on N instruments without creating N bot DB rows
- User-facing product simplifies to "My Agents" (AI or Automation)
- Bot creation endpoints are retained but de-emphasized in user UX
- `ActorType` enum unchanged (`'agent' | 'bot' | 'user' | 'system'`) — bots
  remain a valid executor type for audit purposes
- Execution infrastructure must be extractable from `TradingActor` so both bots
  and agents can reuse it (plan generation, order submission, fill accounting)
- The existing `AgentTradingActor` (AI) continues to create bots when it wants —
  this ADR does not remove that capability
- Future: bots may be fully hidden behind an "advanced" toggle in the UI

## Risks

- **Migration complexity** — Existing users with bots need a smooth transition.
  Bots continue to work; this ADR changes framing, not runtime behavior.
- **Executor extraction** — Pulling plan/execute/persist logic out of
  `TradingActor` into a reusable module requires careful refactoring.
- **Audit trail** — Must preserve clear attribution: which agent made the
  decision, which executor submitted the order.
