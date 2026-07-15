# Bug: PATCH strategyPreset `technical: null` Collision — Preset's Technical Deleted Before Filters Run

**Date:** 2026-07-16
**Status:** CLOSED
**Severity:** High — Fix 1b (PATCH filters population) silently skipped for all hybrid agents updated via frontend

## Summary

When a user PATCHes a hybrid agent with a strategy preset from the frontend, the API deletes the preset's `technical` config before the filters-population code can run. Result: `unifiedConfig.technical` is stored without `filters`, and the agent's scanner loop silently produces zero candidates (defensive guard catches it, but no trading happens).

## Steps to Reproduce

1. Create a hybrid `scanner_gated` agent with a Hyperliquid connection (POST works — filters populated ✅)
2. Open the agent in the frontend, change the strategy preset (e.g. momentum → swing), save
3. Check the DB: `unified_config->'technical'->'filters'` is NULL
4. Worker scanner runs cleanly but discovers zero candidates (Fix 2 guard prevents crash)

## Root Cause

The frontend always sends `"technical": null` when the user hasn't manually customized indicators (line 291 of `agent-payloads.ts`). The PATCH handler's merge logic at `agents.ts:1366` treats `null` as an explicit delete, stripping the preset's `technical`:

```typescript
// OLD CODE (line 1364-1368):
if (technicalUpdate !== undefined) {
    if (technicalUpdate === null) {
        delete merged['technical'];  // ← deletes preset's technical
    }
}
```

The filters-population code (Fix 1b at line 1444) checks `if (unifiedConfigPatch?.technical)` — always false because `technical` was deleted 80 lines earlier.

## Agent type matrix

| Agent type | `technical` sent by client | Backend handling |
|:--|:--|:--|
| intelligence (create) | omitted | no preset → no technical, correct |
| intelligence (update) | `null` | deletes any existing technical ✅ |
| hybrid (create) | omitted | preset fills technical → Fix 1 populates filters ✅ |
| hybrid (update) | `null` (no manual config) | preset fills → then `null` deletes → Fix 1b skipped ❌ |
| hybrid (update) | `{…}` (manual config) | explicit object overrides preset ✅ |

## Fix

**File:** `apps/api/src/routes/agents.ts` line 1364

Changed `if (technicalUpdate !== undefined)` to `if (technicalUpdate !== undefined && technicalUpdate !== null)`. When a preset is active, `technical: null` from the client means "no manual config" — not "delete." Only an explicit `{…}` object overrides the preset's `technical`.

```diff
- if (technicalUpdate !== undefined) {
-     if (technicalUpdate === null) {
-         delete merged['technical'];
-     } else {
-         merged['technical'] = technicalUpdate;
-     }
- }
+ if (technicalUpdate !== undefined && technicalUpdate !== null) {
+     merged['technical'] = technicalUpdate;
+ }
```

The `null`-to-clear path for intelligence mode is handled by the `else` branch (line 1378) where no preset is active.

A documentation table was added above the merge logic to prevent future regressions.

## Files Changed

- `apps/api/src/routes/agents.ts` — fix + inline documentation table

## Verification

| Check | How |
|-------|-----|
| PATCH hybrid agent with strategyPreset → filters populated | Check DB: `unified_config->'technical'->'filters'` = `{ venue, venueType }` |
| PATCH intelligence agent with `technical: null` → technical cleared | Existing tests pass |
| `pnpm lint` | Zero errors |
| Existing tests | All 115 pass |
