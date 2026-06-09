# Bug Report: System Skills Truncated Before E2E Tests

- **Status:** Closed
- **Severity:** High
- **Date:** 2026-06-08
- **Summary:** E2E Journey 7 test 2 and Journey 8 failed with "Could not find skill bot-management in the skills API response" because functional tests truncated the skills table, removing the system skills needed by E2E.

## Root Cause

The functional test teardown calls `truncateAll()` which issues `TRUNCATE ... skills ... CASCADE`. The functional tests and E2E tests share the same PostgreSQL instance (local Docker container). After functional tests ran, the `skills` table was empty. When the E2E stack started, `docker compose run --rm migrate` ran but the migration tool only applies *new* migrations — since 0008 and 0009 were already recorded in `__drizzle_migrations`, no re-seeding occurred. The E2E test helper `createAgent()` called `GET /api/skills`, found an empty array, and threw.

## Fix

Two-part fix:

1. **`apps/api/src/__tests__/functional/helpers.ts`** — `truncateAll()` now re-seeds system skills after truncation using `ON CONFLICT (id) DO NOTHING`.

2. **`scripts/shell/tests/run-all-tests.sh`** — After functional tests and before starting the E2E Docker stack, a `psql` INSERT re-seeds system skills into the shared postgres container.

## Files Changed

- `apps/api/src/__tests__/functional/helpers.ts`
- `scripts/shell/tests/run-all-tests.sh`

## Verification

Full test suite run: E2E Journey 7 test 2 and Journey 8 now pass (9/9 E2E journeys green).

## Regression Tests

Added to `apps/api/src/routes/skills.test.ts`:
- `returns system skills (authorId=null) even when user has no own or public skills` — verifies the GET /skills contract that system skills are always surfaced, even when the calling user has created no skills of their own.
