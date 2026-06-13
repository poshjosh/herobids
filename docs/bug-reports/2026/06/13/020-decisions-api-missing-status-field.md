# 020 — GET /agents/:id/decisions returns no status field — bookkeeping audit false-fails

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-13
- **Summary:** The `/agents/:id/decisions` endpoint returned raw rows from the `decisions` table, which has no `status` column. Any code reading `decision.status` received `undefined`. The trade test's `?? 'pending'` fallback masked this, making every decision appear permanently stuck in `pending`. The Phase 3.7 bookkeeping audit then waited 30 s for the status to change and always timed out — even though the position had closed correctly.

## Root Cause

The `decisions` table is **append-only and has no `status` column** (by design — decisions are immutable records of intent). Execution status is tracked on the related `execution_plans` table via `decisionId` with a `status` column: `pending | executing | completed | failed`.

The `GET /agents/:id/decisions` route did a plain `db.select().from(decisions)` with no join, so `status` was never included in the response.

In the trade test:
1. `flatDecision.status ?? 'pending'` always showed `pending` (since `undefined ?? 'pending'` = `'pending'`), making it appear the decision was stuck.
2. The bookkeeping audit checked `flatDecision.status && flatDecision.status !== 'pending'` — since `status` is `undefined`, this is always falsy, so the 30 s wait always expired → `bookkeeping_failure`.

Meanwhile the position **was** closed correctly (`closedAt` set in DB), confirming the execution engine was fine.

## Fix

Added a correlated subquery to the `/agents/:id/decisions` endpoint that joins to `execution_plans` and returns the most recent plan's status as a derived `status` field:

```sql
SELECT ep.status FROM execution_plans ep
WHERE ep.decision_id = decisions.id
ORDER BY ep.created_at DESC
LIMIT 1
```

Also fixed the misleading `?? 'pending'` fallback in `waitForClose` to `?? 'no-plan-yet'` to distinguish "plan not yet created" from "plan stuck in pending".

## Files Changed

- `apps/api/src/routes/agents.ts` — import `executionPlans`; replace bare `db.select().from(decisions)` with `db.select({ ...fields, status: sql<string | null>... })`
- `scripts/ts/agent-trade-test.ts` — fix `?? 'pending'` → `?? 'no-plan-yet'` in `waitForClose`

## Verification

After the fix:
- `GET /agents/:id/decisions` returns `status: "completed"` (or `"failed"`) for settled decisions
- The bookkeeping audit settlement check passes within the 30 s window
- The test output for `go_flat` shows `status=completed` instead of `status=pending`
