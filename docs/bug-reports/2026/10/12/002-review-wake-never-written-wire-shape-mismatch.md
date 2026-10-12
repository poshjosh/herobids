# Bug Report 001 — Strategy review never wakes the agent: assess results read from a non-existent `data` wrapper

- **Status:** FIXED
- **Severity:** High. "Run Strategy Review" succeeds (the assessment runs and persists an artifact), but the agent is never woken, so the review screen shows "The agent has not made a decision yet." indefinitely.
- **Date:** 2026-10-12
- **Environment:** Local dev (`reset-and-run-xstack.sh`), agent `thyper`, `scanner_gated` + `hybrid`.

---

## 1. Summary

`POST /agents/:id/platform-assessment/reviews` calls traderton's `assess_strategy_preset` owner-scoped, then builds an `advice` list from the returned results and writes an `assessment_review` wake to `agent:outbound:{agentId}` **only when `advice.length > 0`**.

The bug: `narrowAssessResults` (and `narrowChanges`) read the results from `payload['data']['results']` — a `data` key that does not exist on the wire. The traderton boundary returns the tool's `data` **directly** as the payload (see `dispatcher.ts` `successResult(identity, result.data)` and herobids' `mapClientResultToReadResult` which maps `result.payload` → `{ kind: 'success', data: result.payload }`). So `narrowAssessResults` always returns `[]`, `advice.length === 0`, and the wake is never written.

The agent therefore never sees the review advice, never calls `change_strategy_preset`, and `agent_strategy_changes` stays empty — the review screen's "The agent has not made a decision yet." is technically true but misleading: the agent was never told.

## 2. Evidence

- `market_assessment_requests` / `market_assessment_artifacts`: the owner-scoped assessment completed and persisted `assess:BTC:…` (active).
- `agent_strategy_changes`: **0 rows**.
- `agent:outbound:{agentId}` stream: **zero** `assessment_review` wakes (only `signal_scoring`).
- `boundary_invocations` (traderton): `submit_decision` terminal responses show the payload is the tool's `data` directly (e.g. `{"outcome":{"kind":"success","payload":{"ok":true,"planId":…}}}`) — no `data` wrapper.

## 3. Root cause

Wire-shape mismatch in `apps/api/src/routes/agent-platform-assessment-reviews.ts`:

```ts
function narrowAssessResults(payload: unknown): AssessResult[] {
  const data = (payload as Record<string, unknown>)['data'];   // ← undefined on the wire
  const results = (data as Record<string, unknown>)['results']; // ← never reached
  ...
}
```

The boundary returns `{ results: [...] }` (and `{ ok: true, changes: [...] }` for `list_agent_strategy_changes`), not `{ data: { results: [...] } }`.

## 4. Fix

`narrowAssessResults` and `narrowChanges` now read `results` / `changes` from the payload top level (matching the boundary's direct-`data` wire shape).

## 5. Acceptance criteria

- [x] A successful `assess_strategy_preset` with results + artifacts produces a non-empty `advice` list.
- [x] The `assessment_review` wake is written to `agent:outbound:{agentId}` when `advice.length > 0`.
- [x] `GET …/results` reads `changes` from the payload top level.

## 6. Required tests

- `apps/api/src/routes/agent-platform-assessment-reviews.test.ts`:
  - "writes an assessment_review wake when assess returns results with artifacts"
  - existing tests updated to the correct wire shape (payload top-level `results` / `changes`, no `data` wrapper).

## 7. Note on an earlier misdiagnosis

An earlier draft of this report attributed the symptom to a "review wake superseded by routine signal wakes" in the agent's wake buffer. That was **incorrect** — the wake was never written in the first place. The wake-buffer priority change in `runtime-composition.ts` (`isReviewScannerWake`) is a defensive improvement but is not the fix for this bug.