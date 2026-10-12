# Plan: Pin the preset-assessment boundary wire shape with contract + regression tests

- **Status:** pending
- **Owner:** (unassigned)
- **Created:** 2026-10-12
- **Goal:** Prevent the class of bug fixed in
  `docs/bug-reports/2026/10/12/002-review-wake-never-written-wire-shape-mismatch.md`
  from recurring. That bug was a **wire-shape mismatch**: the herobids review
  route read `payload['data']['results']`, but the traderton boundary returns the
  tool's `data` **directly** as the payload (`payload['results']`). The existing
  unit test mocked the *same wrong shape*, so test and code shared one false
  assumption and both passed while the real wire disagreed.
- **Why now:** the fix is in, but nothing asserts the wire shape as a contract.
  A drift on either side (traderton re-wrapping `data`, or herobids re-reading a
  `data` key) would silently re-break the review flow with no failing test.

---

## Background — the wire contract (verified)

The traderton boundary dispatcher maps a tool's `ToolResult` onto the wire via
`successResult(identity, result.data)` (`traderton/packages/boundary/src/dispatcher.ts:172`),
so the success payload **is the tool's `data` object, with no `data` wrapper**.
Herobids' `mapClientResultToReadResult` (`apps/api/src/routes/exports-traderton.ts:102`)
then maps `result.payload` → `{ kind: 'success', data: result.payload }` — i.e.
the read-boundary `data` field IS the wire payload, still no extra `data` key.

The two tools this plan pins:

| Tool | Tool `data` (traderton) | Wire payload (boundary) |
|------|-------------------------|-------------------------|
| `assess_strategy_preset` | `{ requestedInstrumentCount, assessedInstrumentCount, maxInstrumentsPerRequest, results }` | same, top-level `results` |
| `list_agent_strategy_changes` | `{ ok: true, changes }` | same, top-level `changes` |

The herobids consumers are `narrowAssessResults` / `narrowChanges` in
`apps/api/src/routes/agent-platform-assessment-reviews.ts`.

---

## Scope

In scope:
- A traderton-side contract test asserting the boundary's success payload shape
  for the two tools (the single source of truth).
- A herobids-side mirror test asserting the narrowing functions accept the real
  shape and reject the wrong (`data`-wrapped) shape.
- A route-level regression test for the `GET …/results` path with the real
  `{ ok: true, changes }` shape.
- A new E2E scenario (G4) in `scripts/ts/platform-assessment-review-test.ts`
  proving the happy-path POST → `assessment_review` wake lands in
  `agent:outbound:{agentId}`.

Out of scope:
- Changing the wire contract itself (it is already correct; this plan only pins it).
- The wake-buffer priority change in `runtime-composition.ts` (already covered by
  its own tests; see `docs/bug-reports/2026/10/12/001-…`).

---

## Steps

### 1. Traderton boundary wire-shape contract test

**File:** `traderton/packages/boundary/src/preset-assessment-wire-shape.test.ts` (new).

Assert, through the real dispatcher (or the closest existing harness — mirror
`boundary.verification.integration.test.ts`'s `outcome.payload` assertions), that:

- `assess_strategy_preset` success → `outcome.payload` has top-level `results`
  (array) and **no** `data` key.
- `list_agent_strategy_changes` success → `outcome.payload` has top-level
  `changes` (array) and `ok === true`, and **no** `data` key.

This is the authoritative contract. If traderton ever re-wraps `data`, this test
fails first.

### 2. Herobids narrowing contract test (positive + negative)

**File:** `apps/api/src/routes/agent-platform-assessment-reviews.test.ts` (extend).

- Positive: `narrowAssessResults({ results: [...] })` returns the rows;
  `narrowChanges({ ok: true, changes: [...] })` returns the rows.
- Negative: `narrowAssessResults({ data: { results: [...] } })` returns `[]`;
  `narrowChanges({ data: { changes: [...] } })` returns `[]`.

The negative cases make the accepted shape explicit — a future re-introduction of
the `data` wrapper is caught even if the traderton contract test is not run.

### 3. `GET …/results` route regression with the real shape

**File:** `apps/api/src/routes/agent-platform-assessment-reviews.test.ts` (extend).

The existing "reads the agent strategy-change history" test already uses the
corrected top-level `changes` shape. Add the `ok: true` field to that mock (the
real `list_agent_strategy_changes` payload carries it) and assert the route still
returns `changes` correctly. This pins the full real payload, not a trimmed one.

### 4. E2E happy-path scenario (G4)

**File:** `scripts/ts/platform-assessment-review-test.ts` (extend).

Add a `G4` scenario that, for a hybrid + opted-in + active + running-session agent
with a ready trading connection:

1. `POST /agents/:id/platform-assessment/reviews` → expect 202.
2. Poll `agent:outbound:{agentId}` (Redis) for an envelope whose
   `payload.context.scannerKind === 'assessment_review'` and
   `payload.context.advice.length > 0`.
3. Assert the wake is present within a bounded window.

This is the only layer that would have caught the original bug end-to-end (the
unit tests shared the wrong assumption). Wire it into the existing script's
`SCENARIOS` list (default `G1,G2,G3,G4`) and note it requires the traderton
boundary + a ready connection (same prerequisites as `agent-trade-test.sh`).

---

## Verification

- `pnpm --filter @traderton/boundary exec vitest run src/preset-assessment-wire-shape.test.ts`
- `pnpm exec vitest run apps/api/src/routes/agent-platform-assessment-reviews.test.ts`
- `pnpm --filter @herobids/api exec tsc --noEmit`
- `pnpm --filter @traderton/boundary exec tsc --noEmit`
- Manual: `SCENARIOS=G4 tsx scripts/ts/platform-assessment-review-test.ts` against
  the xstack.

## Risks

- **Step 1 harness choice:** the traderton boundary tests may need a real DB/registry
  to dispatch `assess_strategy_preset` (it reads regime/volatility/candles). If the
  full dispatch is too heavy for a unit test, pin the shape at the `mapToolResult`
  / `successResult` level instead (assert `successResult(identity, toolData)` yields
  `outcome.payload === toolData` with no `data` key), which is the actual contract
  point and needs no trading data.
- **Step 4 timing:** the wake write is synchronous in the POST handler, so the
  Redis poll should be near-instant; still bound the wait and fail with a clear
  message rather than hanging.