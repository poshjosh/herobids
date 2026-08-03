# POST /skills Returns 500 in Functional Tests

**Date**: 2026-08-03
**Severity**: MEDIUM (functional test only; may indicate a real API issue)
**Found during**: test-and-fix validation run

## Summary

`POST /skills` returns 500 instead of 201 in `apps/api/src/__tests__/functional/analytics-ai-skills-datasets.functional.test.ts`. This causes 3 cascading test failures (create, get by id, fork).

## Details

The test sends a valid payload (`name`, `description`, `instructions`) that passes Zod validation. The endpoint uses `db.transaction()` to insert into `skills` and `skillRevisions` tables, then calls `buildSkillViews()`.

The 500 likely originates from:
- An unhandled error in the transaction (missing column, constraint violation)
- `buildSkillViews()` querying tables that don't exist or have changed schema
- A missing dependency in the test `buildApp()` setup

## Investigation Needed

Check the API server logs during the test to identify the exact exception. The skill creation route was recently refactored to use the new skills/skillRevisions schema.
