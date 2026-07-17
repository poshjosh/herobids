# Bug Report: Gmail OAuth Missing Email Scope For Userinfo

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-17
- **Summary:** Gmail OAuth callback failed at `gmail.callback.userinfo_failed` because the authorize flow requested only `gmail.send`, but the callback also called Google userinfo to resolve the connected account email.

## Root Cause

The Gmail OAuth route exchanged the code for an access token and then called `https://www.googleapis.com/oauth2/v3/userinfo` to read the account email. The requested scope set only included `https://www.googleapis.com/auth/gmail.send`, which is sufficient for sending mail but not for the userinfo endpoint.

## Fix

Added `https://www.googleapis.com/auth/userinfo.email` to the Gmail OAuth scope list so the callback can resolve the account email without requesting broader Gmail read access.

Also added error-body logging for failed userinfo responses to make future Google scope/config issues visible in API logs.

## Files Changed

- `apps/api/src/routes/connections-oauth.ts`
- `apps/api/src/routes/connections-oauth.test.ts`

## Verification

- `pnpm exec vitest run apps/api/src/routes/connections-oauth.test.ts` passes.
- `pnpm lint` passes.
- Live authorize URLs now include both `gmail.send` and `userinfo.email` scopes.