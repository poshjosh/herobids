# 003 — Migration 0009: `ON CONFLICT DO UPDATE` references index before it is created

**Date:** 2026-06-13  
**Severity:** High  
**Component:** `packages/db/drizzle/0009_*.sql` (database migration)

## Summary

Migration 0009 contained an `ON CONFLICT DO UPDATE` clause that referenced the unique constraint `uq_skill_revisions_skill_version` **before** the `CREATE UNIQUE INDEX` statement that creates it appeared in the migration file. Postgres evaluated the `ON CONFLICT` target at migration time, causing the migration to fail with:

```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```

## Root Cause

The `INSERT ... ON CONFLICT ON CONSTRAINT uq_skill_revisions_skill_version DO UPDATE` was ordered before the `CREATE UNIQUE INDEX CONCURRENTLY ... uq_skill_revisions_skill_version` statement.

## Fix

Reordered the migration so the `CREATE UNIQUE INDEX` statement appears **before** the `INSERT ... ON CONFLICT` that uses it.

## Impact

- API container failed to start on a fresh database run
- All integration and E2E tests could not run until fixed
