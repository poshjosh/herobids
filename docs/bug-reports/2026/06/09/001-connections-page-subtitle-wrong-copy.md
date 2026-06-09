# 001 — Connections Page Subtitle Wrong Copy

- **Status:** CLOSED
- **Severity:** Low
- **Date:** 2026-06-09
- **Summary:** The Connections page subtitle reads "Platform connections to reusable providers" instead of the specified "Platform connections to external providers".

## Root Cause

`apps/web/src/features/connections/ConnectionsPage.tsx` line 27 uses the string `"Platform connections to reusable providers"`. The word "reusable" incorrectly describes the providers rather than the connections. The UAT spec and product design both called for "external providers" to convey that these are third-party integrations.

## Fix

Changed the `subtitle` prop on the `PageHeader` in `ConnectionsPage.tsx`:

```diff
- subtitle="Platform connections to reusable providers"
+ subtitle="Platform connections to external providers"
```

## Files Changed

- `apps/web/src/features/connections/ConnectionsPage.tsx`
- `docs/tech/web/user-acceptance-tests.md` (UAT note updated)

## Verification

Navigated to `/connections` in the browser after the fix — heading reads "Platform connections to external providers". CN-01 now matches the expected text.

## Regression Test

`tests/e2e/journeys/09-connections-page-renders.spec.ts` — Journey 9 asserts the heading, subtitle (exact text "Platform connections to external providers"), and empty state copy on the Connections page. Test passes (1/1).
