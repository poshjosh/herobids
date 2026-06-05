# 2026-06-06-10 — API Credentials Route: runningBotIds vs runningInstanceIds + Response Key Mismatch

**Date:** 2026-06-06  
**Severity:** Medium  
**Files:** `apps/api/src/credential-dependents.ts`, `apps/api/src/routes/credentials.ts`, `apps/api/src/routes/credentials.test.ts`

## Summary

Three related issues in the credentials route:

1. `CredentialDependents` interface and `findCredentialDependents()` returned `runningBotIds: string[]` but tests expected `runningInstanceIds`.

2. The rotate handler sent queue jobs as `{ command: 'restart', botId: instanceId }` but tests expected `{ command: 'restart', tradingInstanceId: instanceId }`.

3. Response JSON used keys `dependentBotIds`/`restartedBotIds`/`blockingBotIds` but tests expected `dependentTradingInstanceIds`/`restartedTradingInstanceIds`/`blockingTradingInstanceIds`.

4. The test mock exported `credentials` from `@herobids/db` but the actual schema export is `userCredentials`.

## Root Cause

Naming migration from `botId` to `tradingInstanceId` was done inconsistently. The test mock was also written against an older schema name.

## Fix

- Renamed `runningBotIds` → `runningInstanceIds` in type and implementation
- Updated rotate handler to use `tradingInstanceId` in job payload and response
- Updated 409 response to use `blockingTradingInstanceIds`
- Fixed mock to export `userCredentials` instead of `credentials`

## Tests Fixed

`apps/api/src/routes/credentials.test.ts` — all tests
