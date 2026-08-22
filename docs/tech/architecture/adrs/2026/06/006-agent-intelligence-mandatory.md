# ADR 006: Agent Intelligence Is Mandatory

Status: Superseded (see [2026-07-11 revision of hybrid decisions][decisions-revised])
Date: 2026-06-23
Parent: [002-hybrid-agent-redesign decisions][decisions]

> **2026-07-11 note:** This ADR’s core principle stands (agents always have `intelligence`),
> but the claim that “no explicit `decisionMode` field is needed on agents” is superseded.
> Agents now have an explicit `capabilityMode` field (`intelligence` | `hybrid`) and,
> when hybrid, an explicit `hybridMode` field (`mixed` | `scanner_gated`).
> See D11 and D12 in the revised [hybrid redesign decisions][decisions-revised].

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

- Agents with `intelligence` only have `capabilityMode: 'intelligence'`.
- Agents with both `intelligence` and `technical` config have `capabilityMode: 'hybrid'`.
  Their runtime behavior is further governed by `hybridMode` (`mixed` | `scanner_gated`).
- Bots continue to use the explicit `decisionMode` field (`mechanical`, `hybrid`,
  `llm`) since bots have no capability concept.

This ADR’s original claim that hybrid mode is fully derived from config presence
is superseded. The capability sections (`intelligence`, `technical`) determine what
is possible; the explicit mode fields determine how the runtime behaves.

## Consequences (revised)

- Agent config validation rejects agents without `intelligence` — the API returns
  a clear error directing users to create a bot instead.
- The `capabilityMode` field (`intelligence` | `hybrid`) is explicit on agents.
- For hybrid agents, `hybridMode` (`mixed` | `scanner_gated`) controls wake policy
  and LLM invocation gating.
- The capability sections (`intelligence`, `technical`) remain the source of truth
  for what capabilities are available. The mode fields control runtime behavior.
- `decisionMode` remains on the bot config schema only.
- Migration: existing agents with both `intelligence` and `technical` config
  default to `capabilityMode: 'hybrid'` and `hybridMode: 'mixed'`.

[decisions-revised]: ../../features/2026/06/22/002-hybrid-agent-redesign/000-decisions.md
