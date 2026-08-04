# Plan: Fix POST /skills 500 in Functional Tests

**Created:** 2026-08-03
**Status:** COMPLETED (2026-08-04)
**Bugs addressed:**
- [005-skills-creation-500-build-skill-views-crash](../../../bug-reports/2026/08/03/005-skills-creation-500-build-skill-views-crash.md)
- [009-post-skills-500-functional-tests](../../../bug-reports/2026/08/03/009-post-skills-500-functional-tests.md)

## Resolution

**Root cause:** The `skills` table has a FK constraint `published_revision_id → skill_revisions(id)`. The `POST /skills` and `POST /skills/:id/fork` handlers inserted the skills row with `publishedRevisionId` set to the new revision ID BEFORE the `skillRevisions` row existed. PostgreSQL rejected the INSERT with a foreign key violation.

`syncSystemSkills` already handled this correctly (null FK pointers → insert revision → UPDATE FK pointers), but the POST and fork handlers did not follow the same pattern.

**Fix applied in `apps/api/src/routes/skills.ts`:**

Both handlers now follow a 3-step transaction pattern:
1. INSERT skills with `currentRevisionId: null`, `publishedRevisionId: null`
2. INSERT skillRevisions
3. UPDATE skills to set `currentRevisionId` and `publishedRevisionId`

**Verification:**
- `pnpm lint` passes
- All 6 skills functional tests pass (POST /skills, GET /skills/:id ×2, DELETE /skills/:id, POST /skills/:id/fork, POST /skills/:id/fork 404)
- The 3 previously-cascading failures (005, 009) are all resolved
