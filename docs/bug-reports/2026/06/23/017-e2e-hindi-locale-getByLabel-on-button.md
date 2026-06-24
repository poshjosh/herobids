# 017 — E2E: Hindi locale test uses `getByLabel` on a button with text content

- **Status:** FIXED
- **Severity:** Medium (test-only; no user-facing impact)
- **Date:** 2026-06-23
- **Summary:** The J12 Hindi locale test uses `page.getByLabel('नया AI एजेंट')` to find the "New AI Agent" button. However, the `Button` component renders its text as children (text content), not as an `aria-label` attribute. `getByLabel` only matches `aria-label`, `aria-labelledby`, or associated `<label>` elements — none of which apply to a `<button>` with text content. The correct selector is `getByRole('button', { name: 'नया AI एजेंट' })`.

- **Root Cause:** Playwright's `getByLabel` locator does not match button text content. The `Button` component (`apps/web/src/lib/ui.tsx`) renders a plain `<button>{children}</button>` without any `aria-label` attribute.

- **Fix:** Changed `getByLabel('नया AI एजेंट')` to `getByRole('button', { name: 'नया AI एजेंट' })` in `tests/e2e/journeys/12-locale-switch-renders-hindi.spec.ts`.

- **Files Changed:**
  - `tests/e2e/journeys/12-locale-switch-renders-hindi.spec.ts` — line 20

- **Verification:** TypeScript compilation passes. The J12 test should now find the button by its accessible role + name instead of a non-existent `aria-label`.

- **Affected Tests:** J12
