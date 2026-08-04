# Sync System Skills Unit Test — DB-Backed Regression Coverage

**Date**: 2026-08-03
**Severity**: LOW (test-only regression; functional coverage already exists)
**Status**: FIXED
**Found during**: test-and-fix validation run
**Error log**: [error.log](./error.log) — 1 brittle test in `sync-system-skills.test.ts`

## Summary

`apps/api/src/sync-system-skills.test.ts` was brittle because it tried to model `syncSystemSkills()` with a hand-rolled Drizzle mock. That mock lagged behind the real query shape and was the wrong level of fidelity for a helper that already runs against Postgres in the functional test harness.

## Fix Applied

The test was converted to a small Postgres-backed integration test. It now opens a real database connection, reseeds system skills through the shared truncation helper, verifies a no-op sync leaves rows unchanged, then mutates one system skill in memory and confirms `syncSystemSkills()` writes a new revision and updates the skill pointers in the database.

## What Remains

None — the regression is covered by a real database instead of a brittle mock.
