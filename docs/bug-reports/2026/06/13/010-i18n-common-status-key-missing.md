# 010 — i18n: `common.status` key missing from all locale files

**Date:** 2026-06-13  
**Severity:** Medium  
**Component:** `apps/web/src/app/i18n/locales/en.ts`, `hi.ts`, `ar.ts`

## Summary

The i18n message key `common.status` was used in `AgentDetailPage.tsx` (for the Status label in the agent status card and runtime health card) and in `BillingPage.tsx`, but it was never defined in any of the three locale files (`en.ts`, `hi.ts`, `ar.ts`). React-Intl falls back to rendering the raw key string as the label, so users saw the literal text `common.status` instead of "Status".

## Root Cause

The key was added to component code (`intl.formatMessage({ id: 'common.status' })`) but was not added to the locale message maps.

## Fix

Added `'common.status': 'Status'` to `en.ts`, `'common.status': 'स्थिति'` to `hi.ts`, and `'common.status': 'الحالة'` to `ar.ts`.

## Impact

- "Status" label on the agent detail page showed as `common.status` for all users
- Same issue appeared in the Billing page status display
- Affected all three supported locales (EN, HI, AR)
