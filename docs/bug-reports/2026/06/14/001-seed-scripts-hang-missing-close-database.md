# 001 — Seed Scripts Hang After Completing (Missing closeDatabase)

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-14
- **Summary:** `build-and-run.sh` hung indefinitely after the admin seed step printed its success message. The process appeared complete but never exited.

## Root Cause

`seed-admin.ts`, `seed-usage-rate-card.ts`, and `upsert-system-skills.ts` all called `createDatabase()` to open a `postgres.js` connection pool but never called `closeDatabase()` before returning from `main()`. The postgres.js pool holds a keep-alive timer on the Node.js event loop, so the process does not exit naturally after async work completes.

`audit-orphaned-connections.ts` was unaffected because it always reaches a `process.exit()` call.

## Fix

Imported `closeDatabase` from `@herobids/db` in each affected script and wrapped the database work in a `try/finally` block to ensure the pool is closed before the process exits.

## Files Changed

- `scripts/ts/seed-admin.ts`
- `scripts/ts/seed-usage-rate-card.ts`
- `scripts/ts/upsert-system-skills.ts`

## Verification

- `pnpm lint` passes with no errors.
- Pattern: `try { ... } finally { await closeDatabase(db); }` applied consistently to all three scripts.
