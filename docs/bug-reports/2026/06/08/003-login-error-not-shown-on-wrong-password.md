# Bug Report: Login Error Not Shown When Password Is Wrong

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-08
- **Summary:** When a user submitted an incorrect password on the email login form, no error message was shown. Instead the form silently reset and the Google tab became active.

## Root Cause

The `request()` function in `api-client.ts` had a blanket handler for 401 responses that called `window.location.href = '/login'` for all endpoints, including `/auth/login`. This hard redirect caused the page to reload, resetting all React state (including the active tab and error state), before the `catch` block in `LoginPage.tsx` could render the error message.

## Fix

Modified the 401 handler in `apps/web/src/lib/api-client.ts` to skip the redirect for auth endpoints (`/auth/login`, `/auth/register`, `/auth/exchange`). For these endpoints, the 401 now falls through to the generic error body parser, which reads the API response message and throws an `ApiError` that the login form's `catch` block can display.

## Files Changed

- `apps/web/src/lib/api-client.ts`

## Verification

- Wrong password now shows "Invalid email or password" error banner
- Email tab stays selected after failed login
- Form fields remain accessible (user can correct password)
- Session expiry (401 from other endpoints) still redirects to `/login` as expected
