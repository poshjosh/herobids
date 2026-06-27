# E2E Tests: Login Page Tab Locator Stale After UI Redesign

**Status:** FIXED
**Severity:** High
**Date:** 2026-06-27

## Summary

All E2E Playwright tests fail with a 60s timeout because the `helpers.ts` `registerUser`/`loginUser` functions and several inline test registrations try to click a `getByRole('tab', { name: /email/i })` element that no longer exists on the login page. The `LoginPage` component was redesigned to use a simple email/password form with a login/register toggle, removing the tab-based UI that the tests depended on.

## Root Cause

The `LoginPage` component (`apps/web/src/features/auth/LoginPage.tsx`) was redesigned:
- **Before:** The page had a tab-based UI with an "Email" tab (and possibly a "Wallet" tab).
- **After:** The page defaults to a single email/password form with a toggle button to switch between login and register modes. There are no ARIA `tab` roles on the page.

The E2E test helpers (`tests/e2e/helpers.ts`) and several journey test files still referenced the old tab pattern:
```ts
await page.getByRole('tab', { name: /email/i }).click();
```

Since this element never appears, Playwright waits 60s (the test timeout), causing every test that registers or logs in to fail.

## Fix

Removed the `getByRole('tab', { name: /email/i }).click()` line from all affected files. Updated the register flow to directly click the login/register toggle (`"Don't have an account? Sign up"`) since the page now defaults to login mode with the form already visible.

## Files Changed

1. **`tests/e2e/helpers.ts`** — `registerUser()` and `loginUser()`
   - Removed `await page.getByRole('tab', { name: /email/i }).click();`
   - In `registerUser`: changed from clicking a "sign up/register" text link to clicking the toggle button (which is always visible since the page defaults to login mode)
   - In `loginUser`: removed tab click (form is already in login mode by default)

2. **`tests/e2e/journeys/02-agent-decision-visible.spec.ts`** — `beforeEach` registration
   - Removed tab click; simplified the conditional `if (signUpLink.isVisible())` to always click the toggle

3. **`tests/e2e/journeys/03-agent-send-message.spec.ts`** — inline registration
   - Removed tab click

4. **`tests/e2e/journeys/05-pause-resume-agent.spec.ts`** — inline registration
   - Removed tab click

5. **`tests/e2e/journeys/06-delete-agent.spec.ts`** — inline registration
   - Removed tab click

6. **`tests/e2e/journeys/15-crashed-agent-recovery.spec.ts`** — inline registration
   - Removed tab click

## Verification

- `pnpm lint` passes with zero errors
- The login page UI was verified by reading the source: no `tab` role elements exist on the page
- i18n messages confirmed the exact button text strings used in the tests match the current locale files:
  - Toggle (login mode): `"Don't have an account? Sign up"` (`auth.switchToRegister`)
  - Submit (register mode): `"Create account"` (`auth.register.submit`)
  - Submit (login mode): `"Sign in"` (`auth.login.submit`)

## Notes

- There may be additional E2E failures beyond the login page, but this fix unblocks all 19 tests from the first common failure point
- The existing `docs/bug-reports/2026/06/27/001-e2e-playwright-tests-timeout.md` report documents the same symptom but did not identify this specific root cause
- The WebSocket 404 through nginx proxy (documented in `002-websocket-404-nginx-proxy.md`) is a separate issue that may affect tests needing real-time updates
