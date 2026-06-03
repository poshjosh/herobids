# ADR 001: Actor-Neutral Agent Protocol

Status: Accepted
Date: 2026-06-02

## Context

Herobids is agent-focused, but the platform must not hardcode `agent` as the only possible actor type. Future runtimes may include bots, users, and system-authored actions. The trading instance remains the execution authority. Different layers may use different provenance terms when they are more precise for that context.

## Decision

Use actor-neutral protocol and audit fields at the boundary, while allowing context-specific names in storage and domain models:

- the canonical boundary may use `actorType` and `actorId` for the current author of a message or decision
- `originType` and `originId` may preserve upstream provenance when different from the current author
- domain tables may use `author`, `actor`, or `initiator` or some other, when one of those terms is clearer in that local context
- valid actor types include `agent`, `bot`, `user`, and `system`
- the execution pipeline always operates on trading instances, not on actors directly

The UI may remain agent-first, but backend schemas, message handling, and audit records must stay actor-neutral at the boundary while using the most precise local term elsewhere.

## Consequences

- Future bot support can reuse the same decision, replay, and recovery contract without schema churn
- the engine can attribute actions correctly without assuming all intent comes from agents
- the current product can stay simple and agent-focused while preserving room for later actor types
- storage and API models may use different provenance labels when they better fit the business meaning, but each label must map back to the same canonical actor concept
- any new market-affecting path must continue to flow through the trading instance boundary