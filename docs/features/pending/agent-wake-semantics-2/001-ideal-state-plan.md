# Agent Wake Semantics Ideal-State Plan

Move the wake system to a fully typed, capability-aware contract where a wake
signal tells the agent exactly why it was woken, includes structured triggering
context, and is only sent to agents that can act on that wake family.

## Goal

Reach the target state:

> A wake signal should tell the agent exactly why it was woken in
> capability-relevant terms, with structured context for the triggering event,
> and agents that cannot act on that event should not be woken at all.

## Background

The current system has two partial strengths and one major gap:

- It already distinguishes durable market events from wake signals.
- It already bounds wake traffic with coalescing and cooldown rules.
- It does not yet guarantee that every wake is semantically precise or that all
  wake families are gated by declared capability and expressed interest.

## Desired End State

### Explicit wake semantics

Every wake carries:

- a typed `source`
- a structured source-specific `context`
- references to the underlying durable event ids
- a bounded scheduling priority

No wake depends on opaque reason strings or prefix conventions.

### Strong capability and subscription gating

Wake delivery is based on both:

- what the agent is allowed and able to do
- what the agent has explicitly subscribed to or expressed interest in

Examples:

- watch-threshold wakes only go to agents with relevant watch subscriptions
- discovery wakes only go to agents that opted into discovery monitoring
- regime-change wakes only go to agents with regime-aware trading or risk
  behavior configured
- reminder wakes only go to the agent that scheduled them

### Clear runtime rendering

The agent runtime renders wake context as dedicated, source-specific context
blocks for the immediate tick so the LLM does not need to infer meaning from a
generic scheduler label.

## Scope

### In scope

- Typed wake payloads across all wake families.
- A capability/subscription model for wake eligibility.
- Source-specific wake rendering in runtime context.
- Coalescing rules that preserve semantic accuracy.
- Tests for protocol, eligibility, emission, and runtime behavior.

### Out of scope

- A broad redesign of unrelated agent message families.
- Replacing the current bounded early-tick scheduling mechanism.
- A product-level redesign of all market-monitor UX in one slice.

## High-Level Plan

1. Define the ideal wake contract.
   Introduce a typed wake schema that makes wake source and source-specific
   context explicit for reminders, watch triggers, discovery deltas, and regime
   changes.

2. Introduce wake eligibility rules.
   Create a shared model for which agents are eligible for each wake family,
   based on both capability and explicit subscription or expressed interest.

3. Preserve semantics through coalescing.
   Update pending-wake storage so coalescing never collapses heterogeneous event
   types into a single generic wake. Coalescing should remain bounded while
   preserving actionable meaning.

4. Update producers to emit only relevant wakes.
   Market-monitor and reminder producers should emit wakes only after checking
   family-specific eligibility and attaching family-specific context.

5. Update the runtime to consume typed wake context.
   The runtime should render a dedicated context block for the immediate tick and
   avoid fallback to ambiguous generic summaries except during migration.

6. Complete a staged migration.
   Roll out additive schema changes first, then producer changes, then runtime
   rendering changes, then remove legacy string-based fallback behavior.

## Major Workstreams

### Workstream A: Protocol and message contract

- Formalize typed wake payloads in the shared domain package.
- Version the contract carefully enough for mixed old/new producers and
  consumers during rollout.

### Workstream B: Eligibility and subscriptions

- Define what counts as capability for each wake family.
- Define what state expresses subscription or interest for each wake family.
- Ensure agents without matching capability/subscription are never selected for
  that wake family.

### Workstream C: Producer correctness

- Ensure each wake is derived from a concrete triggering event.
- Ensure coalescing preserves meaning rather than flattening it.

### Workstream D: Runtime clarity

- Render source-specific wake context blocks.
- Keep wake context tick-scoped unless a wake family explicitly requires longer
  retention.

### Workstream E: Rollout and safety

- Add focused test coverage.
- Keep compatibility fallbacks only long enough to support rollout.
- Remove legacy generic wake semantics after the system is stable.

## Risks

- Over-designing the subscription model before the required wake families are
  clearly bounded.
- Allowing coalescing to reintroduce ambiguity after the protocol is cleaned up.
- Leaving partial compatibility paths in place long enough to become permanent.

## Success Criteria

- Every wake is typed and self-describing.
- The agent can tell from the wake context exactly why it was woken.
- Agents that cannot act on a wake family are never woken for it.
- Coalescing and cooldown still bound wake traffic without degrading semantics.
- Legacy generic wake semantics are removed after migration.