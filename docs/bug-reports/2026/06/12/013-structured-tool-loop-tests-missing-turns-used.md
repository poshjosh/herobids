# 013 — `runStructuredToolLoop` tests missing `turnsUsed` in expected result shape

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-12
- **Summary:** Three tests in `apps/worker/src/structured-tool-loop.test.ts` failed because `turnsUsed` was added to the function's return type but the test assertions were not updated.

## Root Cause

`runStructuredToolLoop` was updated to include a `turnsUsed: number` field in its success result. The tests asserted the exact result shape using `toEqual`, so they failed when receiving an extra `turnsUsed` property.

## Fix

Added `turnsUsed` to the expected result in the three affected test cases:
- "executes tool turns until the model returns a final response" → `turnsUsed: 2`
- "preserves the last assistant response when the turn limit is reached" → `turnsUsed: 2`
- "executes each tool call from a structured assistant turn once" → `turnsUsed: 2`

## Files Changed

- `apps/worker/src/structured-tool-loop.test.ts`

## Verification

All five `runStructuredToolLoop` tests pass.
