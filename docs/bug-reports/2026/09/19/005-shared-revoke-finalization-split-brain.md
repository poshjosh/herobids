# Bug Report: Shared Revoke Finalization Split-Brain

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-19
- **Summary:** A shared connection revoke could restore a local grant after its corresponding remote trading profile had already been finalized and cleared.

## Root Cause

Shared connection revocation staged every affected profile operation, then finalized them sequentially. If an earlier finalization succeeded and a later one failed, the catch block tried to compensate every staged operation. Traderton finalization deletes the earlier operation's rollback preimage, so that compensation could not restore the remote profile while the route still restored all local grants.

## Fix

The route now separates failures before finalization from failures during finalization. Staging failures still compensate and restore local state. Once finalization begins, local and remote revokes remain committed; the failed child stays in the durable `finalizing` outbox state and saga recovery retries only its cleanup. The request returns an error until that cleanup is retried, but it never exposes an active local grant for a cleared remote profile.

## Files Changed

- `apps/api/src/routes/connections.ts`
- `apps/api/src/routes/connections.test.ts`
- `apps/api/src/agents/trading-profile-reconciliation-saga.test.ts`

## Verification

- Focused connection-route regression covers first-child finalize success followed by second-child failure and asserts both local grants remain revoked.
- Focused saga coverage verifies `finalizing` outbox recovery completes the deferred cleanup.
- API and Traderton strict typechecks and repository lint pass.