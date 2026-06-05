# 2026-06-06-09 — API Routes: live-status at /bots/ but Tests Expect /instances/

**Date:** 2026-06-06  
**Severity:** Medium  
**Files:** `apps/api/src/routes/live-status.ts`

## Summary

Live-status routes were registered at `/bots/:id/live-status` and `/bots/:id/live-readiness`, but all 10 tests injected requests to `/instances/:id/live-status` and `/instances/:id/live-readiness`, resulting in 404 responses instead of 200.

Additionally, the route used `actorId`-based journal queries, `getByVenueAccount`/`getOpenByActor`/`getRecentByActor` repo methods, and returned `botId` in the response body — all of which needed to be migrated to instance-scoped equivalents.

## Root Cause

Route paths and internal method calls not updated after the renaming of "bot" to "trading instance" in the public API.

## Fix

- Changed route paths to `/instances/:id/live-status` and `/instances/:id/live-readiness`
- Updated journal queries to use `tradingInstanceId` instead of `actorId`
- Updated repo calls to `getByInstance`, `getOpenByInstance`, `getRecentByInstance`
- Changed response key from `botId` to `tradingInstanceId`

## Tests Fixed

`apps/api/src/routes/live-status.test.ts` — 10 tests
