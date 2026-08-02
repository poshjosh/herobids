# Follow-up Plan: Executable Completion Matrix

**Status:** Done - mandatory completion gate
**Follows:** [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md)
**Companion plans:** [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md) through [013-code-cleanup.md](./013-code-cleanup.md)

## Purpose

This document is the final evidence gate for the per-symbol, on-demand assessment feature. It replaces the previous stale gap register: the `assessment_review` message builder, scanner-wake routing, wake emission, and worker-startup scheduler wiring already exist structurally. They are not proof that the feature works; the remaining work is to make their inputs and downstream request/transition actions real and verifiable.

`005` remains the retained requirements checklist. The follow-up plans own implementation. This document owns the cross-plan acceptance scenarios and the definition of complete.

## Current Baseline

The following code exists and must be preserved and tested, not reimplemented:

- `ReviewScheduler` can emit one `source: scanner`, `scannerKind: assessment_review` wake for advised candidates.
- Worker startup creates schedulers for initially active opted-in agents and stops them at shutdown.
- `agent.ts` renders assessment-review advice and prevents that wake from entering the hybrid entry evaluator.
- `PlatformAssessor`, `AssessmentRequestService`, the three transition tools, and `assess_strategy_preset` are still incomplete or bypass the authoritative flow.

Any implementation status must distinguish these existing plumbing surfaces from the remaining behavior below.

## Completion Register

| ID | Required behavior | Owning plan | Required executable proof |
|---|---|---|---|
| C1 | An assessment has real, versioned, fresh deterministic evidence and scorecards, or fails before LLM/provider work with a structured evidence error. | `008` | Unit tests for every evidence source and unavailable path; integration test persists and reloads the evidence snapshot. |
| C2 | The assessor calls the platform-owned LLM only after C1, validates a complete ranking, and persists no partial artifact on failure. | `009` | Unit tests for prompt projection, invalid output, and semantic ranking checks; recorded-response integration test. |
| C3 | Every assessment request, including a cache hit and every public batch path, goes through one durable request/billing/service boundary. | `007` | Service and tool integration tests prove no direct artifact-read path can claim a billable assessment. |
| C4 | Reservations, capture, release, daily limits, retries, and cross-worker identity leases are durable and idempotent. | `007` | DB integration tests prove no double charge or duplicate provider run under concurrent requests. |
| C5 | The review pre-check reads persisted scanner candidates and can create meaningful advice without calling an LLM or charging an account. | `010` | Scheduler integration test proves advised/no-advice outcomes and exactly one bounded wake. |
| C6 | A transition changes the effective active preset and the running actor configuration, preserves creator-locked risk, and performs only the selected permitted position actions. | `012` | Transition integration test proves persisted active-preset state, actor reload, audit record, and rejection of prohibited changes. |
| C7 | Recommendations and applications use the exact fresh artifact supplied by the billed request; they never substitute a newer artifact or implicitly request another assessment. | `012` | Tool tests for exact-ID handoff, expiry, mismatched identity, and no hidden billable call. |
| C8 | Legacy segment-key and scheduler artifacts are removed only after all replacements are live and their code/test references are gone. | `013` | Targeted source-only grep, lint, build, and migration/journal validation. |

No item may be reported as complete based solely on a TODO removal, a mock-only unit test, a log line, or a passing compilation check.

## End-to-End Acceptance Scenario

Run this against an isolated integration database, Redis instance, deterministic market-data/LLM fixtures, and a seeded billing account. The scenario must exercise the worker composition root rather than constructing individual methods in isolation.

1. Seed an opted-in hybrid `scanner_gated` agent with an active preset, a valid venue binding, persisted scanner candidates, enough credit, and a review check due.
2. Run the review scheduler. Verify that it writes a review-check record and bounded `review_advice` records with either an auditable advised outcome or an auditable no-advice outcome.
3. For advised candidates, verify exactly one `assessment_review` wake. Confirm the hybrid entry evaluator is not called and no assessment request, reservation, provider call, or artifact is created merely by delivery.
4. Have the agent invoke the canonical assessment request tool for one advised symbol. Verify canonical identity resolution, request-row creation, reservation before provider work, persisted run intent, real evidence snapshot, deterministic scorecards, validated LLM artifact, capture, and an exact artifact ID in the response.
5. Request the same fresh identity from another eligible agent. Verify a separate charged request row and no new provider run. Verify the artifact remains shared and immutable.
6. Issue concurrent cache-miss requests for one identity from separate worker processes. Verify one provider run and one active artifact, while each successful requesting agent has its own request/billing outcome.
7. Force provider failure after reservation. Verify release rather than capture, durable failure state, no artifact, and daily-cap accounting. Retry according to the documented request-attempt policy.
8. Call `recommend_preset_transition` using the returned artifact ID. Verify it reads only that fresh artifact and combines it with the requesting agent's local active-preset, policy, and position state.
9. In `recommend_only`, verify `apply_preset_transition` rejects without changing state. In an explicitly enabled non-shadow test configuration, verify an `entries_only` transition changes the active preset, writes the exact behavior versions and identity snapshot, and reloads the actor configuration.
10. Attempt an `entries_and_tighten_existing` transition with a creator-locked stop. Verify the implementation can tighten only; it cannot widen protection, remove protection, add to a losing position, or overwrite a creator lock.
11. Restart the worker. Verify due-review state, in-flight assessment reconciliation, idempotent request results, and current active-preset state remain recoverable from Postgres.

## Evidence Deliverables

Before feature closure, retain these executable artifacts in the test report or CI output:

- focused unit and integration test commands with results;
- migration SQL and matching Drizzle journal entry;
- source-only removal report for legacy assessment identity symbols;
- a recorded LLM fixture that exercises the production response schema;
- a trace or structured test assertion showing reservation precedes provider invocation;
- a trace showing an assessment-review wake remains advice-only;
- a trace showing actor configuration changed after a permitted transition.

## Release Gates

1. Run all focused plan tests and the end-to-end acceptance scenario.
2. Run `pnpm lint`, `pnpm build`, and the relevant workspace test suites.
3. Deploy in `recommend_only` mode first. Monitor persisted request outcomes, evidence failures, ranking validity failures, wake volume, cache-hit ratio, and actor accept/defer/reject outcomes.
4. Do not enable any mode that changes a preset until the recorded shadow evidence satisfies the rollout policy in `005` and the transition integration tests pass in the target environment.

The feature remains incomplete if any completion-register item lacks executable proof.