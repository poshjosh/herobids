# Bug Report 001 — Strategy-review wake is permanently deferred by routine scanner signal wakes

- **Status:** SUPERSEDED — see `002-review-wake-never-written-wire-shape-mismatch.md`. This report's root-cause analysis was **incorrect**: the `assessment_review` wake was never written in the first place (a wire-shape mismatch in the API route), not superseded by signal wakes. The wake-buffer priority change described below was implemented as a defensive improvement and is retained, but it is not the fix for the user-visible symptom.
- **Severity:** High. A user-initiated "Run Strategy Review" produces an `assessment_review` wake that the agent never sees, so the review screen shows "The agent has not made a decision yet." indefinitely even though the assessment itself succeeded and the agent was woken.
- **Date:** 2026-10-12
- **Environment:** Local dev (`reset-and-run-xstack.sh`), agent `thyper` (`0dade092-4e1c-421e-9a97-53558ee966a9`), `scanner_gated` + `hybrid` with `scanIntervalMs: 60000`.

---

## 1. Summary

Clicking "Run Strategy Review" calls traderton's `assess_strategy_preset` owner-scoped (succeeds, persists an artifact), then writes an `agent.wake` with `context.scannerKind === 'assessment_review'` to `agent:outbound:{agentId}`. The agent is expected to route that wake to the transition-review flow, call `change_strategy_preset`, and record a row in `agent_strategy_changes` (which the review screen reads).

The bug: the wake buffer drains **newest-first with no priority**, and a `scanner_gated` agent receives a routine `signal_scoring` wake from traderton's scanner roughly every `scanIntervalMs` (60 s). Each signal wake lands on top of the buffered review wake and is drained instead, so the review wake is **permanently deferred** — it is never selected, the agent never sees the review advice, never calls `change_strategy_preset`, and `agent_strategy_changes` stays empty.

## 2. Evidence

- `market_assessment_requests` / `market_assessment_artifacts`: the owner-scoped assessment completed and persisted `assess:BTC:1791829618648` (active).
- `agent_strategy_changes`: **0 rows** for the agent.
- Agent container log at the tick after the review:
  ```
  [18:27:56] Processing market wake signal
  [18:27:56] Hybrid agent: routing to single-shot evaluator (scanner wake)
  ```
  `canRouteToHybridEvaluator` returns `false` for `assessment_review` wakes, so this log line proves the agent drained a `signal_scoring` wake, not the review wake.
- `agent:outbound:{id}` stream: every wake is `scannerKind: "signal_scoring"`; no `assessment_review` wake was ever consumed.

## 3. Root cause

`drainNewestWakeIntoMarketWake` (`apps/worker/src/runtime-composition.ts`) always selects `buffer[buffer.length - 1]` (the newest entry). The review wake is older than the continuously-arriving signal wakes, so it is never selected. There is no priority ordering between wake kinds.

## 4. Fix

`drainNewestWakeIntoMarketWake` now prefers the newest **review** scanner wake (`scannerKind === 'assessment_review' || 'preset_review'`) when one is buffered, falling back to the newest entry otherwise. Non-selected entries stay in the buffer (deferred, not dropped).

## 5. Acceptance criteria

- [x] A buffered `assessment_review` wake is drained ahead of a newer `signal_scoring` wake.
- [x] The deferred `signal_scoring` wake remains in the buffer (not dropped).
- [x] With no review wake buffered, the newest wake is drained (previous behaviour preserved).
- [x] Reminder wakes still surface as reminders and are not dropped when a review wake is also buffered.

## 6. Required tests

- `apps/worker/src/runtime-composition.test.ts`:
  - "drains a buffered assessment_review wake ahead of a newer signal_scoring wake"
  - "drains the newest review wake when multiple review wakes are buffered"
  - "falls back to the newest wake when no review wake is buffered"
  - "still surfaces a reminder wake when a review wake is also buffered"