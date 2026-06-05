# 2026-06-06-01 — Journal Live Helpers: Wrong Function Signature (actorType/actorId → tradingInstanceId)

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `packages/engine/src/journal.ts`

## Summary

All live-observability journal event helpers (`liveBlockedEvent`, `liveArmedEvent`, `orderSubmittedToVenueEvent`, `orderAcknowledgedEvent`, `fillConfirmedFromStreamEvent`, `completionRecoveredEvent`, `slippageAlertEvent`, `credentialUsedEvent`) used a 3-argument signature `(actorType: string, actorId: string, payload)` and set `actorType`/`actorId` on the returned entry. Tests expected the new 2-argument signature `(tradingInstanceId: string, payload)` setting `tradingInstanceId` on the entry.

`JournalEntry` was missing the `tradingInstanceId?: string` field.

`CredentialDecryptedPayload` carried `actorType`/`actorId` instead of `tradingInstanceId`.

## Root Cause

Incomplete migration from the `actorType`/`actorId` attribution model to the `tradingInstanceId`-based model. Helper signatures were not updated alongside the new protocol.

## Fix

- Added `tradingInstanceId?: string` to `JournalEntry`
- Changed all live helpers to `(tradingInstanceId: string, payload)` returning `{ tradingInstanceId, type, payload }`
- Changed `CredentialDecryptedPayload` to use `tradingInstanceId?: string`
- Changed `credentialUsedEvent` from 3-arg to 2-arg `(tradingInstanceId, payload)`

## Tests Fixed

`packages/engine/src/journal-live.test.ts` — 9 tests
