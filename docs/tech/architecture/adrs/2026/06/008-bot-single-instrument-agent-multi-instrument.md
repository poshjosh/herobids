# ADR 008: Bots Are Single-Instrument; Agents Are Multi-Instrument

Status: Proposed
Date: 2026-06-23
Parent: [002-hybrid-agent-redesign decisions][decisions]
Related: [ADR 004: Actor–Executor Separation][adr-004]

## Context

The system has two entity types that can trade: bots and agents. ADR 004 established
that bots are executors (no agency over instrument selection), while agents are
actors (with discovery and portfolio-level reasoning). However, the *scope* of each
entity's trading domain has not been formalized.

Without a clear scope boundary, there is ambiguity:
- Can a bot trade multiple instruments? (Technically possible today — one bot can
  run a strategy loop that iterates over symbols.)
- Can an agent be constrained to a single instrument? (Technically possible — just
  don't give it discovery tools.)
- If both can do both, what distinguishes them?

## Decision

**Bots are single-instrument. Agents are multi-instrument.** This is a hard
architectural constraint, not a configuration preference.

### Bot: Single Instrument

A bot:
- Trades **one symbol**, **one strategy**, **one execution loop**.
- Has no discovery capability — the instrument is set at creation time and is
  immutable.
- Has no portfolio-level reasoning — it does not know about other bots or the
  agent's overall exposure.
- If an agent needs a bot on a different instrument, it creates a *separate* bot.

This aligns with the executor role from ADR 004: a bot is a mechanical executor
for a specific instrument. Multi-instrument coordination happens at the actor
(agent) level.

### Agent: Multi-Instrument

An agent:
- Operates across **multiple instruments** — discovery, scanning, and capital
  allocation are portfolio-wide.
- With `technical` capabilities: the scanner evaluates signals across all
  discovered instruments and presents a ranked table to the LLM.
- With `intelligence` capabilities: the LLM reasons about portfolio allocation,
  correlation, and concentration risk.
- Submits decisions that may span multiple instruments in a single prompt cycle
  (see ADR 007).

### Capital Allocation Model

```
Agent (portfolio-level)
├── Capital: $10,000
├── Discovery: ETH-PERP, BTC-PERP, SOL-PERP
├── Scanner: ranks signals across all three
├── LLM: allocates capital across signals
│   ├── 25% → ETH-PERP long
│   ├── 15% → SOL-PERP long
│   └── 60% → idle (no signal for BTC-PERP)
└── Execution
    ├── [direct] submit ETH-PERP long decision
    ├── [direct] submit SOL-PERP long decision
    └── or [via bot] delegate each to a single-instrument bot
```

## Consequences

- **Bot schema constraint**: `instrument` becomes a required, immutable field on
  bot creation. The strategy loop hardcodes a single symbol.
- **Simpler bot code**: no symbol iteration, no discovery, no portfolio math.
  The bot's `TradingActor` loop is: fetch market data for one symbol → evaluate
  strategy → submit decision.
- **Agent portfolio tracking**: the agent's position tracker must be
  multi-instrument-aware. Risk limits (max open positions, concentration caps)
  are enforced at the agent level, not per-bot.
- **Migration**: existing bots that iterate over multiple symbols must be split
  into separate single-instrument bots, or their multi-symbol logic must be moved
  into an agent.
- **User experience**: in the UI, agents show a portfolio view (all positions,
  aggregate P&L). Bots show a single-instrument detail view. The mental model is
  "agent = portfolio manager, bot = single-strategy executor."
- **Agent-created bots**: when an agent delegates execution to bots, it creates
  one bot per instrument. The agent is responsible for lifecycle management of
  its bot fleet.

[decisions]: ../../features/2026/06/22/002-hybrid-agent-redesign/000-decisions.md
[adr-004]: ./004-actor-executor-separation.md
