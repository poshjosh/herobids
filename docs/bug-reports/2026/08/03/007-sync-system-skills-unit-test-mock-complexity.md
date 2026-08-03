# Sync System Skills Unit Test — Mock Complexity After Code Changes

**Date**: 2026-08-03
**Severity**: LOW (unit test only; the function is covered by functional/e2e tests)
**Found during**: test-and-fix validation run

## Summary

`apps/api/src/sync-system-skills.test.ts` has 1 failing test because the mock DB doesn't handle the new code paths in `syncSystemSkills()`. The mock's `select` tracking via `selectCallIndex` doesn't account for the multiple select calls per skill iteration, and the mock doesn't filter by WHERE clauses.

## Root Cause

The `syncSystemSkills` function was refactored to use advisory locks, revision-based upserts, and multi-step transactions. Each skill iteration now has 3+ select calls (existing skill check, latest revision check, max version query). The mock's simple call-index tracking no longer maps correctly to the data being returned.

## Partial Fix Applied

- Added `transaction`, `update`, `execute`, `for` methods to mock
- Updated mock to differentiate between `skillsTable` and `skillRevisions` queries
- Insert and update mocks now store data in maps

## What Remains

- The mock's `select` doesn't filter by WHERE clause, so it returns all rows regardless of the filter
- The max-version query needs special handling to return `[{ max: N }]`

## Recommendation

Consider simplifying the unit test to mock at a higher level (e.g., mock `syncSystemSkills` itself for consumer tests) or rewrite using an in-memory SQLite test DB instead of complex mocks.
