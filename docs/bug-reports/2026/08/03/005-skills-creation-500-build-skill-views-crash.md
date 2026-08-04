- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-03
- **Plan:** [001-fix-skills-500-functional-tests](../../../features/2026/03/001-fix-skills-500-functional-tests/001-plan.md)
- **Summary:** `POST /skills` returns 500 when creating a plan-published skill in the functional test suite. This cascades to multiple downstream test failures (fork 404, GET /skills/:id 404).

- **Root Cause:** The `skills` table has a FK constraint `published_revision_id → skill_revisions(id)`. Both `POST /skills` and `POST /skills/:id/fork` handlers inserted the skills row with `publishedRevisionId` set BEFORE the `skillRevisions` row was inserted. PostgreSQL rejected the INSERT with a foreign key violation. The `syncSystemSkills` function already handled this correctly (null FK pointers → insert revision → UPDATE FK pointers) but the POST and fork handlers did not follow the same pattern.

- **Fix:** Updated `POST /skills` and `POST /skills/:id/fork` to follow the 3-step pattern:
  1. INSERT skills with `currentRevisionId: null`, `publishedRevisionId: null`
  2. INSERT skillRevisions
  3. UPDATE skills to set `currentRevisionId` and `publishedRevisionId`

- **Test failures caused:**
  1. `POST /skills creates a plan-published skill` — expected 201, got 500 → **FIXED**
  2. `GET /skills/:id returns the skill by id` — expected 200, got 404 (cascading) → **FIXED**
  3. `POST /skills/:id/fork creates a private copy` — expected 201, got 500 → **FIXED**

- **Affected files:**
  - `apps/api/src/routes/skills.ts` — POST /skills and POST /skills/:id/fork handlers

- **Verification:** All 6 skills-related functional tests pass (`pnpm lint` clean).
