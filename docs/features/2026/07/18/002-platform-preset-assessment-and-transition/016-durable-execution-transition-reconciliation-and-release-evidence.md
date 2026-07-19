# Implementation Plan: Durable Execution, Transition Reconciliation, And Release Evidence

**Status:** Draft
**Date:** 2026-07-19
**Follows:** [015-implementation-plan-evidence-catalog-and-assessment-payload.md](./015-implementation-plan-evidence-catalog-and-assessment-payload.md)
**Depends on:** [006-followup-plan.md](./006-followup-plan.md), [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md), [012c-item-10-and-12-next-slice-plan.md](./012c-item-10-and-12-next-slice-plan.md), [014-corrected-gap-table.md](./014-corrected-gap-table.md)
**Purpose:** Turn the remaining platform preset-assessment and transition work into one production-readiness closure plan after `015` lands.

## Scope

This plan begins where `015` stops.

`015` closes the three highest-priority functional gaps:

1. real evidence adapters and persisted scorecards;
2. real preset catalog wiring;
3. full `assess_strategy_preset` success payload.

After those are in place, the remaining blockers are no longer primarily about feature shape. They are about durability, concurrency, restart safety, runtime application, executable proof, and gated cleanup.

This document combines those remaining blockers into one closure slice so the feature can move from "implemented in parts" to "truthfully production ready."

## Problem Statement

The current plan set already defines the intended feature surface:

- shared platform assessment per canonical market identity;
- assessment-review wakes that remain advice-only until an agent explicitly requests assessment;
- exact-artifact handoff into preset recommendation and change flows;
- actor-local application of preset transitions with creator-locked risk preserved.

The remaining weakness is not missing product intent. The weakness is that the system still lacks enough durability and proof to safely claim production readiness.

After `015`, the main unresolved risks are:

1. concurrent workers may still rely on weaker-than-planned in-flight coordination for assessment execution;
2. transition success is not yet tied strongly enough to live actor reload and restart-safe reconciliation;
3. the end-to-end feature still lacks the definitive executable proof, recorded fixtures, clean-DB rehearsal, and operator-facing rollout evidence required by `006`.

## Goals

1. Make assessment execution durable and cross-worker safe for one canonical identity at a time.
2. Make preset transition application runtime-real, acknowledgement-based, and restart-safe.
3. Prove the full feature slice through the `006` end-to-end scenario and supporting focused tests.
4. Build the persisted-record-derived evidence needed for rollout monitoring and release signoff.
5. Remove legacy code and stale rollout/tool artifacts only after replacement behavior is proven.

## Out Of Scope

This plan does **not** introduce new product surface beyond what the existing plan set already defines.

Specifically out of scope:

- adaptive switching to no preset;
- multiple simultaneous presets per agent;
- new UI work for assessment or preset transition surfaces;
- new market-review prompt UX surfaces;
- broad preset retuning against additional asset classes;
- new billing products or plan-tier packaging beyond the existing assessment-request meter;
- expanding venue inference or other ergonomics unrelated to durability or proof.

## Current Gap Register Covered By This Plan

This plan is the single closure owner for the remaining items from [014-corrected-gap-table.md](./014-corrected-gap-table.md) after `015` completes.

| Gap from `014` | Closure direction in this plan |
|---|---|
| 5. Clean-DB migration rehearsal and journal verification | Workstream 3 |
| 6. Durable cross-worker provider lease and request reconciliation | Workstream 1 |
| 7. Worker-restart reconciliation for in-flight preset transitions | Workstream 2 |
| 8. `006` end-to-end acceptance scenario executed | Workstream 3 |
| 9. Recorded provider-response fixture | Workstream 3 |
| 10. Rollout observability from persisted records | Workstream 3 |
| 11. Legacy segment-key and deprecated artifacts removed | Workstream 4 |
| 12. Cross-worker actor reload path for preset application | Workstream 2 |
| 13. `entries_and_tighten_existing` implemented instead of rejected | Workstream 2 |

## Workstream 1: Durable Assessment Execution And Billing Reconciliation

### Objective

Finish the authoritative request-service architecture so one canonical identity can be assessed safely across concurrent workers without duplicate provider work, billing drift, or stuck reservations.

### Why this is next

Once `015` makes the assessor return real artifacts, the remaining major correctness risk becomes concurrency and settlement. Without this work, the system can look functionally complete while still being unsafe under parallel load or worker failure.

### Required implementation outcomes

1. One canonical identity has one durable live provider lease at a time.
2. Concurrent cache-miss requests from separate workers create one provider run, while preserving separate requester audit and billing outcomes.
3. Billing reservation happens before provider work.
4. Success captures reservations exactly once.
5. Provider failure releases reservations exactly once and records a durable failed outcome.
6. Restart reconciliation can recover expired leases, incomplete runs, and linked request attempts without double-running or double-charging.

### In-scope implementation work

1. Replace same-process-only in-flight join behavior with the DB-backed lease and request-attempt model defined in `007`.
2. Finalize request-attempt persistence, request-group idempotency, and lease ownership rules as the only authoritative concurrency boundary.
3. Ensure cache-hit, cache-miss, provider-failure, and retry outcomes all settle through the same request-service and billing path.
4. Add or finish the reconciler that releases or finalizes in-flight rows after worker death or lease expiry.
5. Ensure public batch and single-item assessment entrypoints both delegate through the same durable service.

### Required proof

- DB integration tests for concurrent request races, idempotent retries, and stale lease recovery;
- assertions that provider work never begins before durable request intent and reservation;
- assertions that no second provider run occurs for the same in-flight canonical identity;
- assertions that released failures still count toward the configured daily request cap.

## Workstream 2: Runtime-Real Preset Transition Application And Reconciliation

### Objective

Make successful preset transitions change the effective running actor behavior, not only Postgres state, and make the result recoverable across worker boundaries and restart scenarios.

### Why this is next

The feature is not complete if `change_strategy_preset` can write transition rows without reliably changing the active runtime configuration. This is the main closure gap behind `006` items C6 and C7.

### Required implementation outcomes

1. Runtime paths consume authoritative preset binding state when present, with a safe fallback for agents that have never transitioned.
2. A successful transition requires live actor reload acknowledgement or deterministic recovery, not a best-effort fire-and-forget callback.
3. Cross-worker actor reload works when the target actor is not local to the requesting worker.
4. Restart reconciliation can recover `applying` transitions and settle them deterministically.
5. `entries_and_tighten_existing` is implemented as a real, bounded protection-tightening mode rather than an unconditional rejection.
6. Exact-artifact handoff remains enforced; no transition path silently substitutes a newer artifact or triggers a hidden assessment request.

### In-scope implementation work

1. Finish the `012c` binding-reload slice, including removal of stale shadow-mode rollout gates that still block the actual two-tool model.
2. Materialize effective technical config from authoritative binding state before actor reload.
3. Reuse the existing config-application path for reload, but require a real applied or rejected acknowledgement contract.
4. Route reload across workers when the actor is remote, rather than assuming same-process registry ownership.
5. Add transition reconciliation for worker restart, missing acknowledgement, and actor-unavailable cases.
6. Implement the permitted `entries_and_tighten_existing` action set with creator-lock and no-risk-widening guarantees.

### Required proof

- focused unit tests for binding resolution, artifact identity enforcement, and transition policy invariants;
- integration tests proving `entries_only` changes authoritative binding state and running actor config;
- integration tests proving tightening mode can tighten protection but cannot widen or remove creator-locked protection;
- restart/reconciliation tests proving `applying` transitions resolve deterministically after worker restart or actor relocation.

## Workstream 3: Release Evidence, Clean-DB Rehearsal, And Rollout Observability

### Objective

Produce the executable evidence package required to claim that the implemented feature set is release-ready, not merely structurally present.

### Why this is next

The plans already describe the required evidence. It still needs one owning slice that actually produces it.

### Required implementation outcomes

1. Clean-DB startup and migration rehearsal prove the assessment schema, journal entries, and worker startup path are consistent.
2. The full `006` end-to-end acceptance scenario executes against real worker composition with deterministic fixtures.
3. A recorded platform-assessor provider-response fixture exists and exercises the production response schema.
4. Operators can inspect persisted records to answer rollout questions about request outcomes, evidence failures, ranking validity failures, wake volume, cache reuse, and transition outcomes.
5. Release signoff artifacts are retained in CI output or an equivalent test-report surface.

### In-scope implementation work

1. Run and stabilize the `006` 11-step acceptance scenario over isolated Postgres, Redis, deterministic market-data fixtures, deterministic LLM fixture data, and a seeded billing account.
2. Add the recorded visible-text/provider-schema fixture for platform assessment ranking tests.
3. Add rollout queries or report helpers derived from persisted request, run, artifact, wake, and transition tables.
4. Verify migration SQL and Drizzle journal alignment through clean-start rehearsal, not only local schema generation.
5. Capture release evidence for reservation-before-provider, advice-only assessment-review wake behavior, exact-artifact transition handoff, and post-transition actor-config change.

### Required proof

- focused commands and results for the relevant unit and integration suites;
- clean-DB migration rehearsal output;
- the recorded provider fixture and the test that consumes it;
- an executable or reported version of the full `006` acceptance scenario;
- persisted-record-derived rollout queries with expected example outputs or assertions.

## Workstream 4: Gated Legacy Cleanup

### Objective

Remove deprecated segment-key code, stale tool references, and old rollout semantics only after the replacement path has executable proof.

### Why this stays last

Cleanup should not become a substitute for proving the new path. The replacement behavior must be live, tested, and observable before deletion begins.

### Required implementation outcomes

1. Legacy segment-key and deprecated scheduler or wake artifacts are removed only after all replacement tests are green.
2. Stale docs or comments that still describe removed tools or removed shadow-mode semantics are updated or deleted.
3. Source-only grep and targeted validation show the deprecated symbols are actually gone.

### Required proof

- targeted source grep over deprecated symbols;
- focused test, lint, and build checks after cleanup;
- migration or journal verification if cleanup affects schema references.

## Task-By-Task Checklist

Use this as the implementation checklist for `016`. The tasks are ordered so that each later step depends on durable behavior from the earlier step.

### Workstream 1 checklist: durable assessment execution and billing reconciliation

| ID | Task | Owner surfaces | Likely files |
|---|---|---|---|
| W1-1 | Lock the authoritative request outcome contract for single and batch requests, including cache-hit, completed, blocked, and provider-failed results. | Domain port, worker request service, worker assessment tool | `packages/domain/src/ports/assessment-request.ts`, `apps/worker/src/market-intelligence/assessment-request-service.ts`, `apps/worker/src/tools/assess-strategy-preset.ts`, `apps/worker/src/tools/assess-strategy-preset.test.ts` |
| W1-2 | Finalize durable request-attempt persistence and canonical-identity request grouping. | DB schema, worker request service | `packages/db/src/schema/market-assessment-requests.ts`, `packages/db/src/schema/market-assessment-runs.ts`, `packages/db/src/schema/index.ts`, `apps/worker/src/market-intelligence/assessment-request-service.ts` |
| W1-3 | Add or finish the cross-worker lease model so one canonical identity has one active provider owner at a time. | DB schema, worker request service, worker coordination helpers | `packages/db/src/schema/market-assessment-runs.ts`, `packages/db/src/schema/market-assessment-artifacts.ts`, `apps/worker/src/market-intelligence/assessment-request-service.ts`, `apps/worker/src/market-intelligence/coordinator.ts`, `apps/worker/src/market-intelligence/leader-election.ts` |
| W1-4 | Make reservation, capture, and release fully authoritative and idempotent for assessment requests. | Billing repository, DB schema, worker request service | `packages/db/src/usage-billing-repository.ts`, `packages/db/src/schema/billing-ledger-entries.ts`, `packages/db/src/schema/billing-usage-events.ts`, `packages/db/src/schema/billing-rate-card-items.ts`, `apps/worker/src/market-intelligence/assessment-request-service.ts` |
| W1-5 | Ensure cache-hit and fresh-run flows settle through the same billing and request-attempt boundary. | Worker request service, worker assessment tool | `apps/worker/src/market-intelligence/assessment-request-service.ts`, `apps/worker/src/tools/assess-strategy-preset.ts`, `apps/worker/src/market-intelligence/assessment-settlement-policy.ts`, `apps/worker/src/market-intelligence/assessment-settlement-policy.test.ts` |
| W1-6 | Add restart reconciliation for expired leases, incomplete runs, and stuck request attempts. | Worker request service, runtime startup wiring, DB schema | `apps/worker/src/market-intelligence/assessment-request-service.ts`, `apps/worker/src/index.ts`, `packages/db/src/schema/market-assessment-requests.ts`, `packages/db/src/schema/market-assessment-runs.ts` |
| W1-7 | Prove concurrent-worker correctness, retry behavior, and stale-lease recovery. | Worker integration tests, DB integration tests | `apps/worker/src/market-intelligence/assessment-request-service.test.ts`, `apps/worker/src/market-intelligence/platform-assessor.integration.test.ts`, `apps/worker/src/market-intelligence/coordinator.test.ts`, `apps/worker/src/market-intelligence/leader-election.test.ts` |

### Workstream 2 checklist: runtime-real transition application and reconciliation

| ID | Task | Owner surfaces | Likely files |
|---|---|---|---|
| W2-1 | Remove stale shadow-mode rollout gates so the runtime path matches the two-tool model. | Domain config, worker transition service, worker transition tool | `packages/domain/src/config/schema.ts`, `packages/domain/src/config/assessment-config.ts`, `apps/worker/src/market-intelligence/preset-transition-service.ts`, `apps/worker/src/tools/change-strategy-preset.ts`, `apps/worker/src/tools/change-strategy-preset.test.ts` |
| W2-2 | Centralize authoritative preset-binding resolution with safe fallback for agents that have never transitioned. | Worker runtime, binding resolver, scheduler | `apps/worker/src/market-intelligence/binding-resolver.ts`, `apps/worker/src/index.ts`, `apps/worker/src/market-intelligence/review-scheduler.ts`, `apps/worker/src/market-intelligence/wake-scheduler.test.ts` |
| W2-3 | Materialize effective technical config from the active binding before any actor reload is attempted. | Domain preset logic, worker transition service, worker runtime | `packages/domain/src/config/presets.ts`, `apps/worker/src/market-intelligence/preset-transition-service.ts`, `apps/worker/src/index.ts` |
| W2-4 | Replace placeholder preset behavior-version handling with real computed behavior-version values. | Domain preset logic, worker transition service, DB transition persistence | `packages/domain/src/config/presets.ts`, `apps/worker/src/market-intelligence/preset-transition-service.ts`, `packages/db/src/schema/agent-preset-bindings.ts`, `packages/db/src/schema/agent-preset-transitions.ts` |
| W2-5 | Require actor reload acknowledgement rather than treating config-apply as best effort. | Worker runtime, actor implementation, transition service | `apps/worker/src/agent-trading-actor.ts`, `apps/worker/src/index.ts`, `apps/worker/src/market-intelligence/preset-transition-service.ts` |
| W2-6 | Route actor reload correctly for both local and remote actors. | Worker runtime, actor messaging, transition service | `apps/worker/src/index.ts`, `apps/worker/src/agent-trading-actor.ts`, `apps/worker/src/tools/messaging.ts`, `apps/worker/src/tools/messaging.test.ts`, `apps/worker/src/market-intelligence/preset-transition-service.ts` |
| W2-7 | Implement restart reconciliation for `applying` transitions and actor-unavailable cases. | Transition service, runtime startup wiring, DB transition state | `apps/worker/src/market-intelligence/preset-transition-service.ts`, `apps/worker/src/index.ts`, `packages/db/src/schema/agent-preset-transitions.ts`, `packages/db/src/schema/reconciliation-events.ts` |
| W2-8 | Implement `entries_and_tighten_existing` as a bounded protection-tightening mode. | Domain preset-transition port, worker transition service, position handling | `packages/domain/src/ports/preset-transition.ts`, `apps/worker/src/market-intelligence/preset-transition-service.ts`, `packages/db/src/schema/positions.ts`, `packages/db/src/schema/agent-preset-transitions.ts` |
| W2-9 | Prove exact-artifact handoff, entries-only application, tightening-only safeguards, and restart recovery. | Worker unit tests, worker integration tests | `apps/worker/src/market-intelligence/preset-transition-service.test.ts`, `apps/worker/src/tools/change-strategy-preset.test.ts`, `apps/worker/src/market-intelligence/assessment-identity-resolver.test.ts`, `apps/worker/src/market-intelligence/platform-assessor.integration.test.ts` |

### Workstream 3 checklist: release evidence, clean-DB rehearsal, and rollout observability

| ID | Task | Owner surfaces | Likely files |
|---|---|---|---|
| W3-1 | Define the deterministic acceptance-test fixture set for market data, LLM responses, billing account state, and opted-in agents. | Worker integration test harness, DB fixtures | `apps/worker/src/market-intelligence/platform-assessor.integration.test.ts`, `apps/worker/src/market-intelligence/assessment-request-service.test.ts`, `tests/fixtures/`, `packages/db/src/schema/*.ts` |
| W3-2 | Add a recorded platform-assessor provider-response fixture that exercises the production ranking contract. | Worker LLM ranking tests, worker fixtures | `apps/worker/src/market-intelligence/llm-ranker.test.ts`, `apps/worker/src/market-intelligence/__snapshots__/llm-ranker.test.ts.snap`, `apps/worker/src/market-intelligence/platform-assessor.test.ts` |
| W3-3 | Execute the clean-DB migration rehearsal and verify Drizzle journal alignment. | DB migrations, DB schema, validation docs or scripts | `packages/db/drizzle/*.sql`, `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema/index.ts`, `tests/staging-config-validation.test.ts` |
| W3-4 | Automate the `006` end-to-end acceptance scenario over real worker composition. | Worker integration composition, runtime startup, scheduler and tool flows | `apps/worker/src/index.ts`, `apps/worker/src/market-intelligence/review-scheduler.ts`, `apps/worker/src/tools/assess-strategy-preset.ts`, `apps/worker/src/tools/change-strategy-preset.ts`, `apps/worker/src/market-intelligence/platform-assessor.integration.test.ts` |
| W3-5 | Add persisted-record-derived rollout queries or report helpers for requests, failures, wake volume, cache reuse, and transition outcomes. | DB/reporting layer, worker monitor surfaces, docs | `apps/worker/src/market-intelligence/monitor.ts`, `apps/worker/src/market-intelligence/monitor.test.ts`, `packages/db/src/schema/market-assessment-requests.ts`, `packages/db/src/schema/review-advice.ts`, `packages/db/src/schema/agent-preset-transitions.ts` |
| W3-6 | Capture release-signoff evidence for reservation-before-provider, advice-only wakes, exact-artifact handoff, and actor config change after transition. | Test reports, docs, integration assertions | `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/006-followup-plan.md`, `test-reports/`, `apps/worker/src/market-intelligence/platform-assessor.integration.test.ts`, `apps/worker/src/tools/change-strategy-preset.test.ts` |

### Workstream 4 checklist: gated legacy cleanup

| ID | Task | Owner surfaces | Likely files |
|---|---|---|---|
| W4-1 | Inventory deprecated segment-key types, stale wake artifacts, and old tool-surface references that should be deleted only after proof is green. | Worker assessment surfaces, domain ports, docs | `apps/worker/src/market-intelligence/*.ts`, `packages/domain/src/ports/assessment-request.ts`, `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/012b-reconciliation-matrix.md`, `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/013-code-cleanup.md` |
| W4-2 | Delete stale rollout-mode and deprecated tool references after Workstreams 1 through 3 pass. | Domain config, worker tools, feature docs | `packages/domain/src/config/schema.ts`, `packages/domain/src/config/assessment-config.ts`, `apps/worker/src/tools/assess-strategy-preset.ts`, `apps/worker/src/tools/change-strategy-preset.ts`, `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/*.md` |
| W4-3 | Remove legacy segment-key code and any dead compatibility helpers once replacement tests and acceptance evidence are green. | Worker assessment logic, DB/reporting surfaces, tests | `apps/worker/src/market-intelligence/*.ts`, `packages/db/src/schema/market-assessment-artifacts.ts`, `apps/worker/src/market-intelligence/*.test.ts` |
| W4-4 | Prove the cleanup is real with targeted grep, lint, build, and post-cleanup test coverage. | Repo validation, docs evidence | `packages/db/drizzle/meta/_journal.json`, `apps/worker/src/market-intelligence/*.test.ts`, `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/013-code-cleanup.md` |

## Suggested Ownership Order

If multiple people are working this plan at once, use this ownership split:

1. **Worker market-intelligence owner**
   Own W1-1 through W1-7, W2-2 through W2-9, and W3-4 through W3-6.
2. **DB and billing owner**
   Own W1-2 through W1-6 and W3-3.
3. **Domain and config owner**
   Own W2-1, W2-3, W2-4, and any schema-contract updates required by W1-1 or W2-8.
4. **Release-proof and cleanup owner**
   Own W3-1 through W3-6 and W4-1 through W4-4 after implementation work is stable.

## Acceptance Criteria

This plan is complete only when all of the following are true.

### A. Durable request execution

1. Every public assessment request path delegates through one authoritative request service.
2. Cross-worker concurrent cache-miss requests for one canonical identity produce one provider run and one active artifact.
3. Reservation, capture, release, retry, and daily-cap behavior are durable and idempotent under restart and concurrency.

### B. Runtime-real transition application

1. A successful preset transition changes both authoritative persisted binding state and the running actor configuration.
2. Transition success depends on acknowledged reload or deterministic reconciliation, not optimistic callback completion.
3. The exact artifact returned by the billed assessment request is the only artifact a later recommendation or application path may use.
4. `entries_and_tighten_existing` is implemented and bounded by creator-lock and risk-tightening rules.

### C. Release proof

1. The full `006` end-to-end acceptance scenario passes.
2. Clean-DB migration rehearsal passes.
3. Recorded provider fixture coverage exists for the platform assessor response contract.
4. Rollout observability can be demonstrated from persisted records.

### D. Cleanup gate

1. Deprecated segment-key and stale rollout or tool artifacts are removed only after A through C are green.
2. Post-cleanup source search, lint, build, and targeted tests pass.

## Deliverables

At closure, this plan should produce:

1. the durable request/lease/reconciliation implementation;
2. the runtime-complete transition and actor-reload implementation;
3. the focused unit and integration tests for concurrency, transition application, and reconciliation;
4. the recorded provider fixture;
5. the clean-DB rehearsal evidence;
6. the end-to-end acceptance report;
7. the rollout observability queries or report helpers;
8. the gated cleanup diff and proof.

## Recommended Execution Order

1. Finish `015` and confirm real evidence, catalog, and payload are landing correctly.
2. Implement Workstream 1 first so the real artifact path is concurrency-safe.
3. Implement Workstream 2 next so transitions become runtime-real and restart-safe.
4. Execute Workstream 3 immediately after the first two are functionally complete.
5. Run Workstream 4 only after the release-proof bar is satisfied.

## Not Ready Until

The feature must still be treated as **not production ready** if any of the following remain true:

- same-process-only concurrency coordination remains in the assessment execution path;
- successful transitions can leave the running actor on the old effective preset;
- the `006` acceptance scenario has not been executed successfully;
- recorded provider fixtures and rollout evidence do not exist;
- cleanup removes legacy symbols before replacement proof is green.