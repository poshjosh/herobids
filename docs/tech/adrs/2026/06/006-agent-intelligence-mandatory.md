# ADR 006: Agent Intelligence Is Mandatory

Status: Proposed
Date: 2026-06-23
Parent: [002-hybrid-agent-redesign decisions][decisions]

## Context

The system has three `decisionMode` values: `llm`, `hybrid`, `mechanical`. Under the
[hybrid agent redesign][decisions], the architecture simplifies by making the scanner
the gate for LLM invocations on hybrid agents. This raises a question: can an agent
exist without any LLM-based intelligence at all?

An "agent" that only runs mechanical rules is indistinguishable from a bot — it
follows a fixed strategy on fixed instruments with no reasoning, no adaptation, and
no portfolio-level judgement. Calling such an entity an "agent" dilutes the term and
confuses the actor model.

## Decision

**Agents always have an `intelligence` config.** An entity without LLM capabilities
should be modeled as a bot, not an agent.

- The presence of `technical` config on an agent implies hybrid mode — the scanner
  feeds signals to the LLM for ratification.
- No explicit `decisionMode` field is needed on agents. For agents, the mode is
  derived from capability presence:
  - `intelligence` only → `llm` mode
  - `intelligence` + `technical` → hybrid mode
- Bots continue to use the explicit `decisionMode` field (`mechanical`, `hybrid`,
  `llm`) since bots have no capability concept.

This is a *simplification*: it removes `decisionMode` from the agent config surface,
reducing configuration errors (e.g., setting `decisionMode: 'mechanical'` on an
agent — which would be contradictory).

## Consequences

- Agent config validation rejects agents without `intelligence` — the API returns
  a clear error directing users to create a bot instead.
- The `decisionMode` field is removed from the agent config schema. It remains on
  the bot config schema.
- Migration: any existing agent rows with `decisionMode: 'mechanical'` and no
  `intelligence` config must be converted to bots, or have `intelligence` added.
- The capability model (`intelligence` + optional `technical`) becomes the single
  source of truth for agent behavior classification.
- Hybrid mode for agents is fully derived — no boolean flag, no enum. If the agent
  has a `technical` block, the scanner gates LLM invocations.

[decisions]: ../../features/2026/06/22/002-hybrid-agent-redesign/000-decisions.md
