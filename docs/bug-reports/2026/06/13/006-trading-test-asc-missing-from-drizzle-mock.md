# 006 — Trading capability test: `asc` missing from drizzle-orm mock

**Date:** 2026-06-13  
**Severity:** Low  
**Component:** `apps/api/src/routes/capabilities/trading.test.ts`

## Summary

The `vi.mock('drizzle-orm', ...)` block in the trading capability unit tests was missing a mock for `asc`. The production code in `resolveRuntimeCapabilityDescriptor` calls `asc()` from drizzle-orm when building an ordered query. Without the mock, calling `asc()` inside the mocked module threw a runtime error, causing `publishRuntimeRefresh` to silently never call `redisClient.xadd`. Tests that asserted `xadd` was called received 0 call counts and failed.

## Root Cause

When adding/refactoring the drizzle query, `asc()` was imported and used but the corresponding entry was not added to the mock factory in the test file.

## Fix

Added `asc: vi.fn((col) => ({ _asc: col }))` to the `vi.mock('drizzle-orm', ...)` block.

## Impact

- All trading capability tests that asserted `redisClient.xadd` call count were failing
- The failure was silent (no thrown error, just 0 call assertions)
