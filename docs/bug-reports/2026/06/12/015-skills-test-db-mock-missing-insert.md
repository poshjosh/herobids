# 015 — `skills.test.ts` db mocks missing `insert` breaks all tests after startup upsert added

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-12
- **Summary:** All 20 tests in `apps/api/src/routes/skills.test.ts` failed with `TypeError: db.insert is not a function` after `skillsRoutes` was updated to upsert system skills via `db.insert(...).values(...).onConflictDoUpdate(...)` on startup.

## Root Cause

`skillsRoutes` calls `db.insert(skills).values({...}).onConflictDoUpdate({...})` for each system skill during route registration. Most test `db` mocks only had `select` (or were empty objects `{}`), causing a runtime error at `await skillsRoutes(app, db)` before any route was exercised.

Tests that had `insert` mocked but only as `{ values: fn().mockResolvedValue(undefined) }` also failed because the startup path calls `.onConflictDoUpdate()` on the `values()` return value.

## Fix

Added a `makeInsertMock(onValues?)` helper function that returns a properly chained mock:
```ts
function makeInsertMock(onValues?: (v: unknown) => void) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockImplementation((v) => {
    onValues?.(v);
    return { onConflictDoUpdate };
  });
  return { insert: vi.fn().mockReturnValue({ values }) };
}
```

Applied `...makeInsertMock()` to all `db` objects in the test file (15 occurrences). Tests that need to capture inserted values use `makeInsertMock((v) => { ... })`.

## Files Changed

- `apps/api/src/routes/skills.test.ts`

## Verification

All 20 skills route tests pass.
