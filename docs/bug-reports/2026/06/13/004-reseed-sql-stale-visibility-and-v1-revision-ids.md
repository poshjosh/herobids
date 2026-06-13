# 004 — Re-seed SQL uses dropped `visibility` column and stale `:v1` revision ID format

**Date:** 2026-06-13  
**Severity:** High  
**Component:** `scripts/shell/tests/run-all-tests.sh` (re-seed SQL block)

## Summary

The re-seed block in `run-all-tests.sh` used two stale patterns that caused a `duplicate key value violates unique constraint "uq_skill_revisions_skill_version"` error on API startup after the test suite seeded the database:

1. `current_revision_id` values used the old format `'bot-management:v1'`, `'trading:v1'`, `'risk-monitoring:v1'`, while the API startup code now uses `'{id}:system:1'` (e.g. `'bot-management:system:1'`). Both formats targeted the same `(skill_id, version)` unique index with different `id` values, causing a conflict.
2. The inline `SELECT` fallback used `(s."id" || ':v1')` instead of `(s."id" || ':system:1')`.
3. The `ON CONFLICT DO UPDATE` clause was missing `"current_revision_id" = EXCLUDED."current_revision_id"`, so existing rows were never updated to the new format.

## Root Cause

The `version` column of `skill_revisions` changed its naming convention from `v1` to `system:1` in a prior refactor. The shell script was not updated to match.

## Fix

- All `current_revision_id` literals changed from `':v1'` suffix to `':system:1'` suffix.
- `SELECT` fallback changed from `(s."id" || ':v1')` to `(s."id" || ':system:1')`.
- `ON CONFLICT DO UPDATE` extended to include `"current_revision_id" = EXCLUDED."current_revision_id"`.
- Added `DELETE FROM "skill_revisions" WHERE skill_id IN (...) AND id NOT LIKE '%:system:%'` before the `INSERT` to purge any stale `:v1` rows left from previous runs.

## Impact

- API container crash on every test suite run after re-seed
- All integration and E2E tests blocked
