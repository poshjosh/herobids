# Bug Report: Unit Test Failure — Skills Route "Auto-Publishes" Select Counter Offset

- **Status:** CLOSED
- **Severity:** Medium
- **Date:** 2026-06-14
- **Summary:** The `skills.test.ts` test "auto-publishes non-draft skills" was failing because `selectCalls` was offset by 8 from `SYSTEM_SKILLS` initialization.

## Root Cause

In `apps/api/src/routes/skills.test.ts`, the test counted `db.select()` calls starting from 0. However, `skillsRoutes(app, db, makePlansConfig())` initialises the skills routes by iterating over 8 `SYSTEM_SKILLS` entries and calling `db.select()` once per skill (to check for existing revisions). This consumed 8 select call counts before the route handler was invoked, so the assertion `expect(selectCalls).toBe(N)` was off by 8.

## Fix

Added `selectCalls = 0;` reset immediately after `await skillsRoutes(app, db, makePlansConfig())` so the counter only tracks calls made during the actual route handler invocation.

## Files Changed

- `apps/api/src/routes/skills.test.ts`

## Verification

`pnpm vitest run` shows all 2288 tests passing, including the skills route tests.

## Test Coverage

A new regression test was added to `apps/api/src/routes/skills.test.ts`:

- `'calls db.select() once per SYSTEM_SKILL entry during route initialisation'` — verifies that `skillsRoutes()` calls `db.select()` exactly `SYSTEM_SKILLS.length` times during init (one per skill to check for an existing revision). This documents the init cost and will catch future regressions where the counter-reset is forgotten.

All 2290 unit tests pass (`pnpm test`).
