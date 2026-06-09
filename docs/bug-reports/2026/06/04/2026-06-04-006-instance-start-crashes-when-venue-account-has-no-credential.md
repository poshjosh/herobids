# Bug Report: Instance starts crashed immediately when the linked venue account had no credential

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** Starting an orderbook instance succeeded at the API layer even when the linked venue account had no credential. The worker then failed during credential resolution with `Venue account ... has no linked credential`, marked the instance as `crashed`, and the UI only showed the crash after the fact.

## Root Cause

`POST /instances/:id/start` validated ownership, live-plan eligibility, and venue-account conflicts, but it did not verify that the linked venue account actually had a credential before enqueueing the start job.

For non-swap instances with a non-default venue account, the worker requires a linked credential to resolve API keys or wallet data. When that link was missing, startup failed immediately in the worker and the instance was marked `crashed`.

## Fix

Updated `apps/api/src/routes/instances.ts` so instance start now fails fast when the linked venue account is missing a required credential.

Also updated `apps/web/src/features/instances/detail/InstanceDetailPage.tsx` so the detail view:

1. polls the instance record while it is `starting` or `running`
2. shows an inline error banner when start or stop mutations fail
3. shows a crash banner when the instance is already in `crashed`

This keeps the operator informed before and after the start attempt instead of letting the worker crash silently.

## Files Changed

- [apps/api/src/routes/instances.ts](../../apps/api/src/routes/instances.ts)
- [apps/api/src/routes/instances.test.ts](../../apps/api/src/routes/instances.test.ts)
- [apps/web/src/features/instances/detail/InstanceDetailPage.tsx](../../apps/web/src/features/instances/detail/InstanceDetailPage.tsx)

## Verification

- Ran `pnpm exec vitest run apps/api/src/routes/instances.test.ts`
- Ran `pnpm lint`
- Confirmed the new regression test passes for the missing-credential case
- Confirmed the workspace type-check passes with the UI changes

## Regression Tests

`apps/worker/src/live-gate.test.ts` — **`rejects live mode when no credential is linked to the venue account and no env-var fallback exists (bug-006 regression)`**:

Simulates the exact failure mode: `credentialsFromDb: false` (no credentialId in DB) and `credentialsPresent: false` (no env-var fallback). With `requireDbCredentials: false` to isolate the `credentialsPresent` check, the gate must still throw `LiveGateError('live_rollout.credentials_empty', ...)`. This documents that a live-mode bot without any credential is rejected at the gate level before any trade is attempted, rather than silently crashing the bot at runtime.

All 17 `live-gate.test.ts` tests pass.
