- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-08-03
- **Summary:** `POST /skills` returns 500 when creating a plan-published skill in the functional test suite. This cascades to multiple downstream test failures (fork 404, GET /skills/:id 404).

- **Root Cause:** The `buildSkillViews` function (or a dependency like `loadViewerContext`) throws an unhandled exception when called after skill creation in the test environment. The skill insertion succeeds but the subsequent `buildSkillViews` call fails, causing Fastify to return 500.

- **Test failures caused:**
  1. `POST /skills creates a plan-published skill` — expected 201, got 500
  2. `GET /skills/:id returns the skill by id` — expected 200, got 404 (skill was never successfully created)
  3. `POST /skills/:id/fork creates a private copy` — expected 201, got 404 (source skill doesn't exist)

- **Affected files:**
  - `apps/api/src/__tests__/functional/analytics-ai-skills-datasets.functional.test.ts`
  - `apps/api/src/routes/skills.ts` (likely `buildSkillViews` or `loadViewerContext`)

- **Reproduction:** Run `scripts/shell/tests/run-all-tests.sh --e2e` with functional test infrastructure.

- **Notes:** This is likely a regression from a recent schema or route change. The test helper calls `syncSystemSkills` before `skillsRoutes`, and `beforeEach` truncates all tables. The test config has `autoPublishNonDraftSkills: true` for the free plan.
