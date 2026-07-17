# Bug Report: Gmail OAuth Redirect URI Used Internal API Host

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-17
- **Summary:** Gmail OAuth authorize requests generated `redirect_uri=http://api:3000/...`, which Google rejects because `api:3000` is only valid inside Docker networking and not as a public callback origin.

## Root Cause

The Gmail connection OAuth route built its callback URL from `config.api.publicBaseUrl`. That config defaults to `http://api:3000`, which is suitable for internal service-to-service addressing but not for browser-visible OAuth callbacks.

The rest of the auth OAuth flows already use `auth.publicBaseUrl`, which is the public-facing callback base and is correctly overridden in local and deployed environments.

## Fix

Changed Gmail OAuth callback URL generation to use `auth.publicBaseUrl` instead of `api.publicBaseUrl`.

## Files Changed

- `apps/api/src/routes/connections-oauth.ts`
- `apps/api/src/routes/connections-oauth.test.ts`

## Verification

- `pnpm exec vitest run apps/api/src/routes/connections-oauth.test.ts` passes.
- `pnpm lint` passes.
- Gmail authorize URLs now emit `redirect_uri=http://localhost:3000/connections/oauth/gmail/callback` in local dev unless an explicit `GMAIL_REDIRECT_URI` override is set.