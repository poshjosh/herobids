# Bug Report 001 — Capability Model: Setup Route Not Registered in Functional Tests

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-10
- **Summary:** `POST /setup/provider-link` returned 404 in functional tests because `setupRoutes` was not registered in the functional test app builder.

## Root Cause

`apps/api/src/__tests__/functional/helpers.ts` `buildApp()` registered all API route groups except `setupRoutes`. The `capability-model.functional.test.ts` calls `setupTradingLink()` which POSTs to `/setup/provider-link`, which returned 404.

## Fix

Added `import { setupRoutes } from '../../routes/setup.js'` and `await setupRoutes(app, db)` (no plan config, so plan limits are skipped) to `buildApp()` in `helpers.ts`.

## Files Changed

- `apps/api/src/__tests__/functional/helpers.ts`

## Verification

All 3 capability-model functional tests pass after the fix.
