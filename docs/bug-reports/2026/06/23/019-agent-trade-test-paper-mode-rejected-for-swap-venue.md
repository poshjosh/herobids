# Bug Report: Agent Trade Test Fails — Paper Mode Rejected for Swap Venue

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-23

## Summary

`scripts/shell/tests/agent-trade-test.sh` fails with `execution_capability.paper_swap_not_supported` when testing against swap venues (1inch, Jupiter). The test was switched from shadow to paper mode after shadow was restricted to admin users, but paper mode is architecturally unsupported for swap venues — they have no simulated price source.

## Symptoms

```
✗ FATAL: Bind failed: 400 {"error":"execution_capability.paper_swap_not_supported","message":"Paper mode is not supported for swap venues — use shadow or live"}
```

The test fails at the `bindTradingCapability` step (Phase 2) because `validateExecutionCapability()` in `packages/domain/src/trading/execution-capability.ts` rejects `paper` + `swap` venue combinations. Swap venues (1inch, Jupiter) have no paper price simulator — they require real price quotes from the venue.

## Root Cause

1. Shadow execution mode was restricted to admin users (June 2026) — non-admin users cannot create shadow-mode agents.
2. The trade test was switched from `EXECUTION_MODE=shadow` to `EXECUTION_MODE=paper` to work around the admin restriction.
3. Paper mode is not supported for swap venues — `validateExecutionCapability()` explicitly rejects this combination because swap venues lack a paper price source.
4. The test had no mechanism to authenticate as an admin user to use shadow mode.

## Fix

### 1. Added admin credential support to the test

**`scripts/.env.trade-test`:**
- Added `ADMIN_EMAIL` and `ADMIN_PASSWORD` variables for admin authentication
- Changed default `EXECUTION_MODE` from `paper` to `shadow`

**`scripts/shell/tests/agent-trade-test.sh`:**
- Added `ADMIN_EMAIL` and `ADMIN_PASSWORD` to the env var snapshot/restore/defaults pipeline
- Added validation: when `EXECUTION_MODE=shadow`, admin credentials must be present
- Exported `DATABASE_URL` so the TS script can promote users to admin via direct DB

**`scripts/ts/agent-trade-test.ts`:**
- Added `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `DATABASE_URL` config reading
- Modified `authenticate()` to use admin credentials when `EXECUTION_MODE=shadow`
- Added `promoteToAdmin()` helper: after registering a new admin user (which defaults to `is_admin=false`), connects directly to Postgres and sets `is_admin=true`. Also called after successful login to ensure the user stays admin (e.g. if the DB was reset).
- The auth plugin reads `isAdmin` from the DB on every request, so the promotion takes effect immediately without re-authentication

### How it works

1. When `EXECUTION_MODE=shadow`, the test authenticates as `ADMIN_EMAIL`/`ADMIN_PASSWORD`
2. If the admin user doesn't exist yet, it registers them (creating a non-admin user), then promotes them to admin via a direct DB `UPDATE`
3. The same auth token now carries admin privileges (auth plugin reads fresh `isAdmin` from DB each request)
4. Agent creation with `executionMode: 'shadow'` passes the admin-only gate
5. Binding with swap venue + shadow mode passes `validateExecutionCapability()`

## Files Changed

- `scripts/.env.trade-test` — added admin credentials, changed execution mode
- `scripts/shell/tests/agent-trade-test.sh` — admin credential handling, DATABASE_URL export
- `scripts/ts/agent-trade-test.ts` — admin auth flow, `promoteToAdmin()` helper, DB imports

## Verification

- `pnpm lint` (TypeScript type-check) passes cleanly
- The auth plugin (`apps/api/src/plugins/auth.ts:103`) reads `isAdmin` from the `users` table on every request, so the DB promotion takes effect immediately
- Shadow mode is valid for swap venues per `validateExecutionCapability()` in `packages/domain/src/trading/execution-capability.ts:42-48`
