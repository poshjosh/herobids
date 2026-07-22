# Bug Report: Missing Migration for `agent_assessment_review_runs` Table

**Date:** 2026-07-22  
**Severity:** HIGH (blocks the forced-strategy-review feature)  
**Status:** Open

## Summary

The Drizzle schema file `packages/db/src/schema/agent-assessment-review-runs.ts` was created as part of the frontend-triggered forced strategy review feature, but no corresponding Drizzle migration SQL file was generated. The table `agent_assessment_review_runs` does not exist in the database, causing the API to fail with a PostgreSQL "relation does not exist" error whenever the frontend triggers the review flow.

## Reproduction

1. Start the local dev environment: `scripts/shell/run/reset-and-run.sh`
2. Start an agent from the web UI (http://localhost:8080)
3. Navigate to the agent detail page
4. Click **"Run Strategy Review"**

### Observed Error

```
Failed query: select "id" from "agent_assessment_review_runs"
where ("agent_assessment_review_runs"."agent_id" = $1
and "agent_assessment_review_runs"."status" IN ('queued', 'running'))
limit $2
params: <agent-id>,1
```

This is a PostgreSQL error — the table `agent_assessment_review_runs` does not exist in the database.

## Root Cause

The Drizzle schema was updated (new file `packages/db/src/schema/agent-assessment-review-runs.ts` registered in `packages/db/src/schema/index.ts`) but `drizzle-kit generate` was never run. No migration SQL file exists under `packages/db/drizzle/`.

The Docker Compose setup runs migrations via `docker/Dockerfile.migrate` which calls `drizzle-kit migrate`. Since no migration SQL exists for this table, it's never created.

### Files involved

| File | Role |
|------|------|
| `packages/db/src/schema/agent-assessment-review-runs.ts` | Drizzle schema definition (exists) |
| `packages/db/src/schema/index.ts` | Schema barrel export (updated) |
| `packages/db/drizzle/` | Migration SQL directory (**no migration for this table**) |

### Call chain

1. Frontend clicks "Run Strategy Review"
2. `POST /agents/:id/platform-assessment/reviews` → `agent-platform-assessment-reviews.ts`
3. Route calls `hasActiveManualReviewRun(db, agentId)` → `manual-review-repository.ts`
4. Repository queries `agent_assessment_review_runs` table → **PostgreSQL error: relation does not exist**

## Recommended Fix

1. **Generate the migration:**
   ```bash
   cd packages/db
   pnpm run db:generate
   ```
   This will create a new `.sql` file in `packages/db/drizzle/` with the `CREATE TABLE` statement for `agent_assessment_review_runs`.

2. **Apply the migration:**
   - The migration will be automatically applied on the next `docker compose up` (the `migrate` service runs `db:migrate`).
   - Or manually: `cd packages/db && pnpm run db:migrate`

3. **Verify** by checking that the table exists:
   ```sql
   SELECT * FROM agent_assessment_review_runs LIMIT 1;
   ```

## Impact

- **User-facing:** The "Run Strategy Review" button always fails. The feature is completely blocked.
- **API:** Returns a 500 error (unhandled PostgreSQL exception) instead of a proper error response.
- **Data:** No data loss — the table simply doesn't exist yet.

## Related

- Feature plan: `docs/features/2026/07/20/001-frontend-force-strategy-review/001-plan.md`
- Schema: `packages/db/src/schema/agent-assessment-review-runs.ts`
- Repository: `packages/db/src/manual-review-repository.ts`
- API route: `apps/api/src/routes/agent-platform-assessment-reviews.ts`
