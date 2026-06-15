# Review: Agent Wake Semantics Ideal-State Plan

## Verdict

Partially implemented.

The branch strengthens the wake payload by requiring `source` in [packages/domain/src/agent-protocol.ts](../../../../packages/domain/src/agent-protocol.ts) and adds source-specific runtime context rendering in [apps/worker/src/runtime-composition.ts](../../../../apps/worker/src/runtime-composition.ts). That is real progress, but it does not yet reach the plan's fully typed, capability-aware end state.

## Findings

1. High: the wake `context` field is still an untyped catch-all.
   [packages/domain/src/agent-protocol.ts](../../../../packages/domain/src/agent-protocol.ts) keeps `context` as `z.record(z.unknown()).optional()`, and [apps/worker/src/runtime-composition.ts](../../../../apps/worker/src/runtime-composition.ts) still downcasts family-specific fields ad hoc. That falls short of the plan's typed, source-specific contract.

2. Medium: legacy generic wake semantics are still present in the runtime consumer.
   [apps/worker/src/runtime-composition.ts](../../../../apps/worker/src/runtime-composition.ts) still keeps the fallback branch that renders a generic `Market wake` summary when `source` is missing or unrecognized. The plan's success criteria call for removing legacy ambiguous semantics after migration.

3. Medium: the capability/subscription eligibility model is still absent from this branch slice.
   The commit does not change producer-side eligibility selection in the market-monitor surfaces, so the review branch does not yet establish a shared rule that agents must both be capable of and subscribed to a wake family before emission.

## Suggested Change List

1. High: modify [packages/domain/src/agent-protocol.ts](../../../../packages/domain/src/agent-protocol.ts) to replace the generic `context` record with a discriminated, source-specific wake payload schema.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: stage the migration carefully if mixed producers and consumers still exist; keep backward compatibility only for the rollout window.
   Test expectation: unit-test schema parsing for each wake family and rejection of cross-family fields.

2. Medium: modify [apps/worker/src/runtime-composition.ts](../../../../apps/worker/src/runtime-composition.ts) to remove the generic fallback path once all producers are on the typed wake contract.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: if any legacy producer still omits `source`, remove it only after the rollout path is complete or feature-flag the strict mode.
   Test expectation: unit-test source-specific rendering and rejection of legacy untyped wakes.

3. Medium: add or extract a shared wake-eligibility contract in the producer path so reminder, watch, discovery, and regime wakes are emitted only for agents that are both eligible and subscribed.
   Files/functions: [apps/worker/src/market-intelligence/monitor.ts](../../../../apps/worker/src/market-intelligence/monitor.ts), [apps/worker/src/reminder-coordinator.ts](../../../../apps/worker/src/reminder-coordinator.ts).
   Change: add or modify.
   Dependencies: step 1.
   Risks/Open questions: define whether eligibility is driven by skills, explicit user watch subscriptions, trading readiness, or a combination per wake family.
   Test expectation: integration-test producer emission rules; no visual verification needed.