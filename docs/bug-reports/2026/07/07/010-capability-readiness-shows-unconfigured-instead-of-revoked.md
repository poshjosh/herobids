# Bug Report — 010: Capability readiness shows 'unconfigured' instead of 'revoked' after connection is revoked

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** When a trading connection was soft-deleted (`DELETE /connections/:id`), the capability readiness endpoint and aggregate readiness endpoint both returned `state: 'unconfigured'` instead of `state: 'revoked'`.

## Root Cause

Both the trading capability readiness endpoint (`GET /agents/:id/capabilities/trading/readiness`) and the aggregate capabilities endpoint (`GET /agents/:id/capabilities/readiness`) filtered `agent_connections` to `grantStatus === 'active'` only.

When a connection is soft-deleted, two things happen:
1. `connections.status` is set to `'revoked'`
2. `agent_connections.status` is set to `'revoked'`

After revocation, no `active` rows existed, so the endpoints returned `deriveReadiness(undefined)` → `state: 'unconfigured'` — as if no connection was ever configured.

The `deriveReadiness` function already handles the `'revoked'` case correctly when given a row; the bug was that revoked rows were discarded before `deriveReadiness` was called.

**Important distinction**: Two different revocation scenarios exist:
- `DELETE /connections/:id` (soft delete) → `connectionStatus: 'revoked'` → should show `'revoked'`
- `PATCH /agents/:id { connectionIds: [] }` (remove grant) → `grantStatus: 'revoked'`, `connectionStatus: 'active'` → should show `'unconfigured'` (user simply un-configured the agent)

The fix correctly distinguishes these two cases by falling back to `connectionStatus === 'revoked'` rows only.

## Fix

### `apps/api/src/routes/capabilities/trading.ts`

The trading readiness endpoint now:
1. Uses active rows if any exist
2. Falls back to `connectionStatus === 'revoked'` rows (not grant-revoked rows) to surface `'revoked'`
3. Returns `'unconfigured'` if neither active nor connection-revoked rows exist

### `apps/api/src/routes/capabilities/index.ts`

The aggregate capabilities endpoint now:
1. Queries ALL `agent_connections` rows for the agent (not just active ones)
2. For each capability family, prefers active rows; falls back to `connectionStatus === 'revoked'` rows
3. Shows `'unconfigured'` when the only revoked rows are grant-revoked (not connection-revoked)

## Files Changed

- `apps/api/src/routes/capabilities/trading.ts`
- `apps/api/src/routes/capabilities/index.ts`

## Verification

- Functional test `capability-model.functional.test.ts > marks capability readiness revoked when the underlying connection is revoked` now passes
- All three capability lifecycle scenarios verified:
  - No connection assigned → `'unconfigured'` ✅
  - Active connection → `'ready'` ✅
  - Grant removed via PATCH → `'unconfigured'` ✅
  - Connection soft-deleted → `'revoked'` ✅
- Full test suite (`scripts/shell/tests/run-all-tests.sh --e2e`) passes
