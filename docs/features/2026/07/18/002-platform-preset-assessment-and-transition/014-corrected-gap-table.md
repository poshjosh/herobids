# Corrected Gap Table: Platform Preset Assessment And Transition

**Status:** Draft
**Date:** 2026-07-19
**Purpose:** Replace the earlier gap table with a code-checked status record that distinguishes already-landed foundations, missing implementation, and missing verification.

## Summary

The earlier table was directionally useful, but not fully accurate.

- Items 1, 2, 5, 6, 7, 8, 9, and 10 were broadly valid.
- Item 3 was incorrect as written: the platform assessor LLM config is already seeded in operator config.
- Item 4 mixed one completed subtask with one incomplete subtask: migrations are generated, but deployment-style verification is still missing.
- The earlier table omitted several blocking gaps, especially the incomplete `assess_strategy_preset` response contract.

## Status Legend

- **Implemented**: Present in code and not the current blocker.
- **Not yet implemented**: Behavior is still missing or only partially landed.
- **Needs verification**: Most or all code exists, but production-readiness proof is still missing.

## Implemented Foundations Already In Code

| # | Item | Status | Impact | Effort | Notes |
|---|---|---|---|---|---|
| F1 | Assessment request persistence and billing reservation/capture/release path | **Implemented** | H | N/A | Request rows, billing reservation/capture/release, and artifact/run linkage are present in code and schema. |
| F2 | Review scheduler, review-advice persistence, and scanner-candidate persistence | **Implemented** | H | N/A | The advice-only `assessment_review` path exists and the normal scan path persists `agent_scan_candidates`. |
| F3 | Local preset-apply actor reload path | **Implemented** | M | N/A | Local registry-based actor reload is wired for successful `entries_only` transitions. |
| F4 | Assessment migrations generated and journaled | **Implemented** | M | N/A | The assessment-related schema migrations and journal entries already exist. |
| F5 | Exact-artifact transition handoff tests | **Implemented** | M | N/A | There is already focused test coverage proving exact artifact ID handoff behavior. |

## Current Gap Status Table

| # | Item | Status | Impact | Effort | Notes |
|---|---|---|---|---|---|
| 1 | Real evidence adapters plus persisted evidence/scorecards | **Not yet implemented** | XH | H | Covered by [015-implementation-plan-evidence-catalog-and-assessment-payload.md](./015-implementation-plan-evidence-catalog-and-assessment-payload.md) Workstream 2. Worker startup still wires regime, candles, liquidity, and breadth to `assessment.evidence_unavailable` stubs, and the assessor still does not persist evidence snapshots/scorecards before LLM ranking. |
| 2 | Preset catalog wired into assessor factory | **Not yet implemented** | XH | S | Covered by [015-implementation-plan-evidence-catalog-and-assessment-payload.md](./015-implementation-plan-evidence-catalog-and-assessment-payload.md) Workstream 1. Worker composition still passes `getPresets()` as `[]`, so the assessor has no real candidate preset set. |
| 3 | `assess_strategy_preset` returns the full assessment payload promised by the schema | **Not yet implemented** | XH | M | Covered by [015-implementation-plan-evidence-catalog-and-assessment-payload.md](./015-implementation-plan-evidence-catalog-and-assessment-payload.md) Workstream 3. The domain schema expects assessment data, rankings, recommendation, and canonical identity in the success payload, but the worker tool currently returns mostly billing and transition metadata. |
| 4 | Assessor config propagation and rollout semantics aligned with operator config | **Not yet implemented** | H | S | The LLM config is already seeded, but the assessor factory still hardcodes `enabled: true` and a fixed freshness window instead of propagating resolved operator config cleanly. |
| 5 | Clean-DB migration rehearsal and journal verification | **Needs verification** | H | M | The assessment migrations are generated and journaled already; what is still missing is clean-DB startup rehearsal and deployment-style proof. |
| 6 | Durable cross-worker provider lease and request reconciliation | **Not yet implemented** | H | M | Request rows, reservations, and artifact persistence exist, but same-process in-memory lease reuse is still used for in-flight assessment execution. |
| 7 | Worker-restart reconciliation for in-flight preset transitions | **Not yet implemented** | H | M | The transition service still leaves `applying`-state restart reconciliation as an explicit TODO. |
| 8 | 006 end-to-end acceptance scenario executed against real worker composition | **Needs verification** | H | M | There are focused unit/integration tests, but not the full 11-step acceptance scenario over real worker composition. |
| 9 | Recorded provider-response fixture for platform LLM | **Needs verification** | M | S | Current LLM tests are mock-driven. The missing artifact is a recorded visible-text/provider-schema fixture. |
| 10 | Rollout observability queries and release evidence built from persisted records | **Not yet implemented** | M | M | The persistence surfaces exist, but operator-facing queries/reports for request outcomes, evidence failures, ranking validity, wake volume, cache reuse, and transition outcomes are not yet built. |
| 11 | Legacy segment-key and deprecated wake/scheduler artifacts removed | **Not yet implemented** | M | M | Deprecated segment-key types and helpers are still in active source and should remain gated on replacement proof. |
| 12 | Cross-worker actor reload path for preset application | **Not yet implemented** | M | M | Local actor reload is wired through the registry, but remote actor reload via worker-to-worker message routing is still deferred. |
| 13 | `entries_and_tighten_existing` transition mode implemented rather than explicitly rejected | **Not yet implemented** | M | M | The current apply surface only supports `entries_only`. Tightening/full-transition modes are still explicitly rejected. |
| 14 | Stale docs/config references to removed tools and shadow-mode rollout cleaned up | **Not yet implemented** | L | S | Some docs and config comments still refer to removed tool names or stale rollout semantics. |

## Item-By-Item Corrections Against The Earlier Table

### Original item 1

Keep, but widen the note.

- The problem is not only adapter wiring.
- The assessor also still skips persistence of evidence snapshots and deterministic scorecards before LLM ranking.

### Original item 2

Keep.

- This is still a direct blocker because the worker passes an empty preset catalog into the assessor factory.

### Original item 3

Replace.

- The platform assessor LLM config is already present in `config/default.yaml`.
- The real gap is config propagation drift and rollout-semantic drift, not missing config seeding.

### Original item 4

Narrow.

- Migrations are generated and journaled already.
- What remains is deployment-style verification, not generation.

### Original item 5

Keep.

- This remains valid and should explicitly include stuck `applying` transition recovery.

### Original item 6

Keep.

- Focused tests are not equivalent to the end-to-end acceptance scenario described in `006`.

### Original item 7

Keep, but raise urgency from pure nice-to-have.

- It is still a missing evidence artifact for C2-style completion, even if the code can progress without it.

### Original item 8

Keep.

- The right framing is persisted-record-derived rollout evidence, not new counters.

### Original item 9

Keep.

- This remains cleanup gated on proof, not a prerequisite for proving the replacement path works.

### Original item 10

Keep.

- The original single-worker note is still fair.
- The implementation is not yet safe to describe as multi-worker-complete.

## Important Gaps Omitted By The Earlier Table

### A. The assessment tool contract is still incomplete

This is the biggest omission.

- The feature plans now rely on a two-tool flow:
  - `assess_strategy_preset`
  - `change_strategy_preset`
- The domain response schema for `assess_strategy_preset` expects the returned assessment object itself, including rankings, summaries, confidence, urgency, and the exact transition reference.
- The current worker tool does not yet populate that full success shape.

Without this, the feature is not genuinely end-to-end even if request billing and artifact persistence work underneath.

### B. Cross-worker assessment execution is not yet at the plan’s durability bar

- Request rows and billing reservation/capture/release are significantly implemented.
- However, the current in-flight assessment join path still relies on same-process memory for lease reuse.
- That is weaker than the durable cross-worker identity-lease model the plans call for.

### C. Transition scope is still only partially implemented

- `entries_only` is the only actually supported apply mode today.
- Tightening/full-transition behavior is still not implemented; it is rejected up front.

## Recommended Ordering

If the goal is to reach a truthful “production ready” claim for this feature slice, the highest-value order is:

1. Real evidence adapters plus evidence/scorecard persistence.
2. Real preset catalog wiring.
3. Fix `assess_strategy_preset` so it returns the documented assessment payload.
4. Replace same-process-only assessment execution joining with durable cross-worker behavior and recovery.
5. Prove clean-DB startup and execute the full `006` acceptance scenario.
6. Add recorded provider fixture and rollout observability evidence.
7. Only then run `013` cleanup.

## Current Readiness Verdict

The feature is **not production ready** on the current code state.

The most important reasons are:

- real evidence collection is still stubbed at worker composition time;
- the assessor still receives an empty preset catalog from the worker;
- the public assessment tool does not yet return the full assessment payload required by the documented two-tool flow;
- restart and cross-worker reconciliation remain incomplete;
- the definitive `006` end-to-end acceptance scenario has not been executed.