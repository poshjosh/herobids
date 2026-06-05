# 2026-06-06-12 — Alert Dispatcher: Cooldown Key Uses actorId Instead of tradingInstanceId

**Date:** 2026-06-06  
**Severity:** Low  
**Files:** `apps/worker/src/alerting/alert-dispatcher.ts`, `apps/worker/src/alerting/alert-policy.ts`

## Summary

`AlertDispatcher.cooldownKey()` extracted `actorId` from the event row for cooldown de-duplication. `JournalEventRow` had no `tradingInstanceId` field, so alerts for events carrying only `tradingInstanceId` would never match existing cooldown keys, causing duplicate alerts.

## Root Cause

`JournalEventRow` was defined without the newer `tradingInstanceId` column. `cooldownKey` was not updated when the attribution model changed.

## Fix

- Added `tradingInstanceId?: string | null` to `JournalEventRow`
- Updated `cooldownKey` to use `${event.tradingInstanceId ?? event.actorId ?? ''}:${event.type}`

## Tests Fixed

`apps/worker/src/alerting/alert-dispatcher.test.ts`
