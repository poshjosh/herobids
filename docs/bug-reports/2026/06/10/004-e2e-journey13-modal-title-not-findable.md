# Bug Report 004 — Journey 13: Modal Title Not Findable by Playwright

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-10
- **Summary:** E2E Journey 13 could not verify the trading provider setup modal opened because the modal title "Add trading provider" was rendered in a plain `<div>`, not a semantic heading or element with ARIA role, making `getByRole('heading')` and `getByText()` fail (strict mode violation: two elements matched).

## Root Cause

The `Modal` component in `apps/web/src/lib/ui.tsx` renders its title in a plain `<div>` without `role="dialog"` on the container. The test used `page.getByText('Add trading provider')` which matched both the CTA button and the modal title div, causing a strict mode violation. After changing to `getByRole('heading')`, nothing was found because the title is not a heading element.

## Fix

1. Added `role="dialog"` and `aria-modal="true"` to the inner container `<div>` of the `Modal` component in `ui.tsx`.
2. Updated Journey 13 test to use `page.getByRole('dialog').getByText('Add trading provider')` — scoped to the dialog container to uniquely identify the modal title.

## Files Changed

- `apps/web/src/lib/ui.tsx`
- `tests/e2e/journeys/13-mc-setup-card.spec.ts`

## Verification

Journey 13 passes end-to-end.
