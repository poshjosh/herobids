# 012 — Arabic and Hindi locale catalogs missing `tickInterval` validation and legacy keys

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-12
- **Summary:** `apps/web/src/app/i18n/catalog-consistency.test.ts` failed because `ar.ts` and `hi.ts` were missing three keys present in `en.ts`.

## Root Cause

Three i18n keys were added to the English catalog but not to the Arabic and Hindi catalogs:
- `agents.controls.tickInterval.legacyNotice`
- `agents.controls.tickInterval.validation.minimum`
- `agents.controls.tickInterval.validation.wholeMinutes`

## Fix

Added the three missing keys with appropriate translations to both `ar.ts` and `hi.ts`. Also fixed a missing trailing comma on `tickInterval.slowdownCaveat` in both files that caused a parse error.

## Files Changed

- `apps/web/src/app/i18n/locales/ar.ts`
- `apps/web/src/app/i18n/locales/hi.ts`

## Verification

`catalog-consistency.test.ts` passes. All web locale files parse without syntax errors.
