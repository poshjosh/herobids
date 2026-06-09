# 010 — API functional tests: skills INSERT uses raw SQL with wrong array syntax

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** All functional tests failed with `column "required_tools" is of type text[] but expression is of type record`. The `truncateAll()` helper used raw SQL to re-seed system skills but passed individual array elements as positional parameters wrapped in `()`, which Postgres interprets as a record literal, not an array.
- **Root Cause:** The raw SQL `($5, $6, $7, ...)` syntax creates a row/record expression, not a text array. Drizzle's `db.execute(sql`...`)` with spread array values uses this form.
- **Fix:** Replaced the raw SQL INSERT with Drizzle ORM's typed `db.insert(skillsTable).values({...}).onConflictDoNothing()`, which correctly serialises array columns. Also exported `LlmRuntimeConfigSchema` from `@herobids/domain` and used it to construct the stub LLM config in the functional test helpers.
- **Files Changed:**
  - `apps/api/src/__tests__/functional/helpers.ts`
  - `packages/domain/src/config/index.ts`
- **Verification:** All 89 functional tests pass.
