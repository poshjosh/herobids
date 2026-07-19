# Follow-up Plan: Gap Closure for Per-Symbol On-Demand Assessment

**Status:** Draft — mandatory follow-up closure plan
**Follows:** [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md)
**Purpose:** Close the end-to-end implementation gaps left open after the base checklist work, with explicit coverage checks and runtime acceptance criteria.

---

## 0. How To Use This Document

Use this plan together with [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md).

- `005` remains the authoritative feature build checklist.
- `006` is the enforcement plan for the remaining gaps, especially the missing end-to-end `assessment_review` delivery path.
- Work is **not complete** until every row in the Gap Register is closed with executable proof.

This document exists specifically to prevent another partial implementation from being described as complete.

---

## 1. Gap Register

Every known gap must have an owner surface, a concrete change, and a proof artifact. No row may remain vague.

| Gap ID | Missing behavior | Owner files | Required change | Proof |
|---|---|---|---|---|
| G1 | No dedicated assessment-review prompt builder, so the agent cannot see review advice | `apps/worker/src/agent.ts` | Add `buildAssessmentReviewMessage()` for `scannerKind: 'assessment_review'` | Unit test for rendered message plus runtime log or prompt snapshot showing injected advice block |
| G2 | No `assessment_review` routing block in `runTick()` | `apps/worker/src/agent.ts` | Detect `scannerKind === 'assessment_review'`, route it away from ordinary signal handling, and inject the dedicated review message | Test proving an `assessment_review` wake changes prompt context and does not route through normal entry-signal flow |
| G3 | No wiring from `ReviewScheduler` to the agent wake pipeline | `apps/worker/src/market-intelligence/review-scheduler.ts` | Convert advised review rows into an `agent.wake` event with `source='scanner'` and `scannerKind='assessment_review'` | Integration test showing one due advised review publishes one wake event |
| G4 | No integration between `AssessmentRequestService` and `PlatformAssessor` | `apps/worker/src/market-intelligence/assessment-request-service.ts`, `apps/worker/src/market-intelligence/platform-assessor.ts` | Replace assessor stub with a real call into `PlatformAssessor`, persist run intent/artifact, and return real artifact IDs | Integration test proving a request creates or reuses a real artifact |
| G5 | No scheduler instantiation in worker startup | `apps/worker/src/index.ts` | Instantiate and start `ReviewScheduler` for eligible agents; stop it on worker shutdown | Startup/integration test or runtime evidence showing scheduler creation for an opted-in agent |
| G6 | No actual `assessment_review` wake emission from the scheduler | `apps/worker/src/market-intelligence/review-scheduler.ts` | Emit exactly one wake per due interval when one or more unexpired `advised` rows exist | Integration test proving one due interval with multiple advised symbols emits one wake |

---

## 2. Coverage Gate

The next implementation effort must satisfy all of the following gates.

1. No work may be called complete if any Gap Register row is still open.
2. No status update may claim end-to-end completion without pointing to code for wake emission, wake consumption, prompt rendering, and request execution.
3. `pnpm lint` and `pnpm build` are necessary but not sufficient. Runtime-path proof is mandatory.
4. Any behavior described in prose must be traceable to code in the owner files listed in the Gap Register.
5. If a slice lands only foundations or scaffolding, its status must say `partial` and list the still-open gap IDs.

---

## 3. Required Implementation Order

Implement by runtime control flow, not by architecture layer.

1. `ReviewScheduler` emits the wake.
2. Worker startup instantiates and starts the scheduler.
3. Agent runtime detects `assessment_review` and builds the dedicated prompt segment.
4. Request service calls the real assessor.
5. End-to-end tests prove the whole path.

This order is mandatory because it exposes broken delivery earlier and prevents false claims based on isolated foundations.

---

## 4. Acceptance Scenario

The feature is not complete until this exact scenario passes.

1. Seed one opted-in agent whose review is due.
2. Run the scheduler.
3. Verify one or more `review_advice` rows are persisted with outcome `advised`.
4. Verify the scheduler emits exactly one `agent.wake` with:
   - `source = 'scanner'`
   - `scannerKind = 'assessment_review'`
5. Verify the agent runtime consumes that wake and injects a dedicated assessment-review message into prompt context.
6. Verify that if the agent takes no tool action:
   - no billing occurs
   - no assessor run occurs
   - no artifact is created solely because of the wake
7. Verify that when the agent explicitly calls `get_market_preset_assessment`:
   - the request service runs
   - billing gate logic runs
   - the assessor is invoked or a fresh artifact is reused
   - a real `assessmentArtifactId` is returned
8. Verify that `recommend_preset_transition` works only off the exact artifact reference.
9. Verify that `apply_preset_transition` is blocked when `recommend_only` is active.

If any one of those checks fails, the flow is incomplete.

---

## 5. Required Proof Per Gap

Each gap must be closed with both code and executable validation.

| Gap ID | Minimum proof |
|---|---|
| G1 | Unit test for `buildAssessmentReviewMessage()` and captured prompt output |
| G2 | Agent runtime test for `assessment_review` routing |
| G3 | Scheduler integration test showing wake publication |
| G4 | Request-service integration test showing assessor invocation and artifact result |
| G5 | Worker lifecycle test or startup log proof for scheduler instantiation |
| G6 | Test proving one wake per due interval, not one wake per symbol |

---

## 6. Completion Rule

Completion of the per-symbol on-demand assessment feature requires:

- all relevant items in [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md) to remain satisfied,
- all six gaps in this document to be closed,
- the acceptance scenario in Section 4 to pass,
- and the final review to enumerate proof for every gap row.

If a future implementation or review cannot do that, it must explicitly say the feature remains incomplete.