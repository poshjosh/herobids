# 010 — Unused `sql` import in `agent-intake-resolver.ts` causes build failure

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-12
- **Summary:** `pnpm build` failed in `@herobids/worker` because `sql` was imported from `drizzle-orm` but never used.

## Root Cause

`apps/worker/src/agents/agent-intake-resolver.ts` had `sql` in its import list:
```ts
import { eq, and, desc, sql } from 'drizzle-orm';
```
The `noUnusedLocals` TypeScript compiler option (enabled via `strict: true`) rejected this as an error.

## Fix

Removed `sql` from the import.

```diff
- import { eq, and, desc, sql } from 'drizzle-orm';
+ import { eq, and, desc } from 'drizzle-orm';
```

## Files Changed

- `apps/worker/src/agents/agent-intake-resolver.ts`

## Verification

`pnpm build` passes with no errors.
