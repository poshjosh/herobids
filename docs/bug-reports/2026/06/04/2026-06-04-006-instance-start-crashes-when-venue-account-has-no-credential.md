# Bug Report: Instance starts crashed immediately when the linked venue account had no credential

- **Status:** FIXED
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
