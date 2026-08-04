# Sync System Skills Unit Test — Mock Complexity After Code Changes

**Date**: 2026-08-03
**Severity**: LOW (unit test only; the function is covered by functional/e2e tests)
**Status**: FIXED
**Found during**: test-and-fix validation run
**Error log**: [error.log](./error.log) — 1 failing test in `sync-system-skills.test.ts` (test 1/18)

## Summary

`apps/api/src/sync-system-skills.test.ts` had 1 failing test because the mock DB didn't handle the new code paths in `syncSystemSkills()`. The mock's `select` tracking via `selectCallIndex` didn't account for the multiple select calls per skill iteration, and the mock didn't filter by WHERE clauses.

## Fix Applied

The mock was enhanced with proper WHERE clause filtering. The `extractEqCondition` function inspects Drizzle's `queryChunks` array (which contains `PgText` column definitions and `Param` value objects) to extract the column name and bound value. The mock's `select().then()` resolver now filters results by matching column name and value. The `update().set().where()` chain also filters by WHERE clause instead of updating all rows blindly.

## What Remains

None — the test now passes.
