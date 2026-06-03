# Phase 5d: V1 Agent Message Catalog

## Canonical Technical References

The normative technical contract now lives in:

- [Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)

This file is now a short workstream note instead of a duplicate full catalog.

## Finalized V1 Choices

- The envelope uses `initiatorType` and `initiatorId` for current message authorship, plus optional `originType` and `originId` for original flow provenance.
- Lifecycle messages use `agent.lifecycle.*`, not `agent.control.*`.
- `agent.decision.submit` remains single-decision-only in v1.
- `instance.context.snapshot` stays compact and summary-first; deeper context is referenced through bounded slices or artifact references.
- There is no `instance.context.snapshot.full` message in v1.
- Artifact metadata is synchronous; large artifact bodies are asynchronous or out-of-band.
- Reconnect uses hybrid replay rather than full replay or latest-state-only.

## What Implementers Should Reuse

- reuse existing `Decision`, `ExecutionPlan`, and `ExecutionResult` concepts
- keep direct order-entry out of the contract
- keep risk outcomes and agent guardrails distinct
- keep message handling duplicate-safe and correlation-based

## Implementation Reminder

Any new message shape or field should be added to the canonical docs under `docs/tech/agents/` first, then reflected here only if the workstream note still needs to track it.

See [003-open-questions.md](./003-open-questions.md) for the smaller remaining unresolved items.
