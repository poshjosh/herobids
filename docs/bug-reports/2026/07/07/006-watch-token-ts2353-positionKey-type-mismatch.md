# Bug Report 006 — `watch_token` TS2353: `positionKey` not in Zod-inferred coverage type

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-07
- **Summary:** `tsc --build` fails in `apps/worker` with TS2353 at `src/tools/watch.ts:388` and `:404`. The Zod-inferred type for `coverage` lacks `positionKey`, but the code spreads `positionKey` into `resolvedCoverage` (which shares that type). The mismatch prevents the worker from building.

## Root Cause

The `watch_token` tool's Zod parameter schema defines `coverage` without a `positionKey` field — it uses `targetPosition` instead, since the worker owns the `positionKey` derivation contract. However, `resolvedCoverage` was declared as `let resolvedCoverage = coverage`, inheriting the Zod-inferred type (no `positionKey`). Later, when deriving a canonical `positionKey` from matched positions or caller input, the code does:

```ts
resolvedCoverage = { ...coverage, positionKey: derivedKey };
```

This object literal has a `positionKey` property not declared in the inferred type, triggering TS2353.

The actual runtime type that `WatchEntry.coverage` expects is `WatchCoverageLink` (from `watch-types.ts`), which _does_ include `positionKey?: string`.

## Fix

1. Import `WatchCoverageLink` from `../watch-types.js`.
2. Annotate `resolvedCoverage` as `WatchCoverageLink | undefined` instead of letting it infer from the Zod type.
3. Use a type assertion (`as WatchCoverageLink | undefined`) for the initial assignment from `coverage`.

**Files Changed:**
- `apps/worker/src/tools/watch.ts` — added `WatchCoverageLink` import, changed `resolvedCoverage` type annotation and cast.

## Verification

```bash
pnpm --filter @herobids/worker run build  # passes cleanly
```
