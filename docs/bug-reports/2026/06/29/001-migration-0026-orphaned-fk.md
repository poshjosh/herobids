# Migration 0026 — orphaned FK rows in `capability_grants`

**Date:** 2026-06-29
**Severity:** HIGH
**Status:** Fixed (local dev only — manual cleanup applied)

## Summary

Drizzle migration `0026_clear_charles_xavier` (`venue` → `provider` rename + merge `connections`/`trading_bindings`) fails with:

```
ERROR: insert or update on table "capability_grants" violates foreign key constraint
"capability_grants_connection_id_connections_id_fk"
DETAIL: Key (connection_id)=(ddfa42f1-da90-41de-a6e7-651e7781aade) is not present in table "connections".
```

Two `capability_grants` rows reference `connection_id` values that don't exist in the `connections` table after the rename and data migration. This blocks the `VALIDATE CONSTRAINT` step at the end of the migration.

## Root cause

The `trading_bindings` table had rows that linked to `connections` that were subsequently deleted without cleaning up dependent `trading_bindings` → `capability_grants` rows. When migration 0026 copies data from `trading_bindings` to `connections` and renames `capability_grants.binding_id` → `connection_id`, orphaned references become FK violations.

## Impact

- **Dev environments:** Migration stalls mid-way with partially-applied changes (some columns renamed, some not). DB enters an inconsistent state where Drizzle schema expects `provider` column but DB still has `venue`.
- **Production:** Would block deployment pipeline. Requires manual pre-flight check before applying.

## Local fix applied

```sql
-- Delete orphaned capability_grants rows
DELETE FROM capability_grants 
WHERE connection_id NOT IN (SELECT id FROM connections);

-- Validate the FK constraint
ALTER TABLE capability_grants VALIDATE CONSTRAINT capability_grants_connection_id_connections_id_fk;
```

Then ran remaining migrations 0027, 0028 via drizzle-kit.

## Recommended permanent fix

1. Add a pre-migration safety check to migration 0026 that detects and cleans up orphaned rows BEFORE attempting the rename/validation.
2. Or add `NOT VALID` to the FK constraint creation and skip validation until after deployment (validate later).
