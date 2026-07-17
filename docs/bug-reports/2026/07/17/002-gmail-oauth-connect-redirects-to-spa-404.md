# Bug Report: Gmail OAuth Connect Redirects To SPA 404

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-17
- **Summary:** Clicking "Connect Gmail" on the connections page redirected the browser to a frontend route instead of the API OAuth endpoint, producing a "Page not found" error in local development.

## Root Cause

The Gmail connect and reconnect buttons used browser-relative URLs like `/connections/oauth/gmail/authorize`. In local development, the web app runs on `http://localhost:8080` and only proxies `/api/*` to the API service, so `/connections/oauth/*` was handled by the SPA router instead of the backend.

That exposed a second issue in the original flow: even when the route target is corrected, a top-level browser redirect cannot attach the SPA's bearer token, so the API cannot identify the user when starting the OAuth flow.

## Fix

Changed the flow to start Gmail OAuth with an authenticated `POST /connections/oauth/gmail/authorize` request from the SPA. That request carries the bearer token, lets the API set the signed state cookie on the API origin, and returns the Google authorize URL for the browser to navigate to.

## Files Changed

- `apps/web/src/lib/config.ts`
- `apps/web/src/features/setup/ProviderSetupForm.tsx`
- `apps/web/src/features/connections/ConnectionsPage.tsx`

## Verification

- `pnpm lint` passes.
- `pnpm exec vitest run apps/api/src/routes/connections-oauth.test.ts` passes.
- The SPA now starts Gmail OAuth through an authenticated API call instead of navigating directly to a frontend 404 route.