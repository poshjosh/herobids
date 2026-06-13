# 012 — scripts: seed-admin crash — drizzle-orm not in package dependencies

- **Status:** FIXED (applied 2026-06-13)
- **Severity:** Medium
- **Date:** 2026-06-13
- **Summary:** `build-and-run.sh` failed at Step 5 (seed admin) because `seed-admin.ts` (and `audit-orphaned-connections.ts`) import `eq` from `drizzle-orm` directly, but `drizzle-orm` was not listed in `scripts/package.json` dependencies.

## Root Cause

`scripts/package.json` only declared `@herobids/db`, `@herobids/domain`, and `viem` as dependencies. pnpm strict isolation means packages cannot access transitive dependencies not declared in their own `package.json`. Running `tsx ts/seed-admin.ts` from the `scripts` package context failed with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'drizzle-orm' imported from .../scripts/ts/seed-admin.ts
```

## Fix

Added `drizzle-orm: "^0.44.0"` to `scripts/package.json` dependencies (matching the version used by `packages/db`).

## Files Changed

- `scripts/package.json`

## Verification

- `pnpm install` completed cleanly.
- `pnpm lint` passes with no TypeScript errors.
