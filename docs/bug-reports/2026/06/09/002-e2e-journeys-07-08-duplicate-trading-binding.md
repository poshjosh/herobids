# 002 — E2E Journeys 07 & 08 Fail: Duplicate Trading Binding

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-09

## Summary

Journeys 07 and 08 fail with `duplicate key value violates unique constraint "uq_trading_bindings_connection_id"` when `seedTradingBinding` is called after `createConnection`.

## Root Cause

`POST /connections` auto-creates a `trading_bindings` row for any provider in `TRADING_CONNECTION_PROVIDERS` (which includes `hyperliquid`). The e2e test helpers `seedTradingBinding` in journeys 07 and 08 were written before this auto-creation existed. After the route change, `createConnection()` already created a binding, and then `seedTradingBinding()` attempted a second insert for the same `connection_id`, violating the unique index.

This is the same root cause as `docs/bug-reports/2026/06/08/005-trading-binding-duplicate-key-functional-tests.md`, which fixed the same pattern in the API functional tests. The e2e journeys 07 and 08 were added after that fix and repeated the same anti-pattern.

## Fix

1. Added `getBindingForConnection(connectionId: string): Promise<string>` to `tests/e2e/helpers.ts` — queries the DB for the binding auto-created by `POST /connections`.
2. Added `drizzle-orm` as a devDependency to `tests/e2e/package.json` so `eq` is available for the Drizzle WHERE clause.
3. Replaced `seedTradingBinding(...)` calls in journeys 07 and 08 with `getBindingForConnection(connection.id)`.
4. Removed the now-unused `getAuthenticatedUserId` import and `userId` variable from both journeys.

## Files Changed

- `tests/e2e/package.json` — added `"drizzle-orm": "^0.44.0"` devDependency
- `tests/e2e/helpers.ts` — added `eq` import from `drizzle-orm`; added `getBindingForConnection` export
- `tests/e2e/journeys/07-mission-control-renders.spec.ts` — replaced `seedTradingBinding` with `getBindingForConnection`; removed unused `getAuthenticatedUserId` import and `userId` variable
- `tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts` — replaced `seedTradingBinding` with `getBindingForConnection`; removed unused `getAuthenticatedUserId` import and `userId` variable

## Verification

All 10 e2e tests pass (`10 passed (5.3s)`). `pnpm lint` clean.

## Regression Tests

Three layers of coverage ensure this regression cannot recur:

1. **Unit** — `apps/api/src/routes/connections.test.ts`
   - `"auto-creates exactly one trading binding with matching connectionId for provider=<N>"` (it.each for hyperliquid, jupiter, 1inch, bybit) — verifies the route inserts exactly 2 rows and the binding's `connectionId` links back to the new connection.
   - `"auto-created trading binding carries the correct userId, status, and label"` *(added for bug 002)* — verifies the binding inherits `userId`, `status: 'active'`, and the connection label, confirming the full auto-created payload that callers should query rather than re-insert.

2. **End-to-end** — `tests/e2e/journeys/07-mission-control-renders.spec.ts` and `08-mission-control-capability-reflects.spec.ts`
   — Both journeys create a hyperliquid connection via the API and then call `getBindingForConnection(connection.id)` to retrieve the auto-created binding. Attempting the old `seedTradingBinding` pattern against a real DB would fail with the unique constraint, so these tests would immediately catch any regression to that pattern.
