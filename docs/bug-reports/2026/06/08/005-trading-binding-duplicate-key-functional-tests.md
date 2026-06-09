# 005 — Trading Binding Duplicate Key in Functional Tests

- **Status:** Closed
- **Severity:** Medium
- **Date:** 2026-06-08

## Summary

Three tests in `capability-model.functional.test.ts` failed with:

```
duplicate key value violates unique constraint "uq_trading_bindings_connection_id"
```

The errors occurred at the very first `INSERT INTO trading_bindings` in each test, with unique connection IDs, ruling out cross-test contamination.

## Root Cause

`POST /connections` (introduced in `apps/api/src/routes/connections.ts`) was updated to **automatically create a `trading_bindings` row** for any connection whose provider is in `TRADING_CONNECTION_PROVIDERS` (which includes `hyperliquid`).

The test helper `seedTradingBinding(connectionId)` was written before this auto-creation logic existed. After the route change, each test's `createConnection()` call already created a binding, and then `seedTradingBinding` attempted a second insert for the same `connection_id`, violating the unique index `uq_trading_bindings_connection_id`.

## Fix

Replaced the `seedTradingBinding` insert helper with `getBindingForConnection`, which queries the DB for the binding the connections route auto-created:

```typescript
async function getBindingForConnection(connectionId: string): Promise<string> {
  const [binding] = await ctx.db
    .select({ id: tradingBindings.id })
    .from(tradingBindings)
    .where(eq(tradingBindings.connectionId, connectionId));
  if (!binding) {
    throw new Error(`No trading binding found for connection ${connectionId} — POST /connections should have created one automatically`);
  }
  return binding.id;
}
```

Also removed the now-unused `import crypto from 'node:crypto'`.

## Files Changed

- `apps/api/src/__tests__/functional/capability-model.functional.test.ts`
  - Replaced `seedTradingBinding` helper with `getBindingForConnection`
  - Updated all 3 call-sites
  - Removed unused `crypto` import

## Verification

- `pnpm lint` passes (tsc --noEmit, no errors)
- No TypeScript errors in the modified file
- Tests require live `DATABASE_URL`/`REDIS_URL` to run; root cause is code-level and confirmed by tracing the duplicate insert path

## Regression Tests

Added to `apps/api/src/routes/connections.test.ts`:
- `auto-creates exactly one trading binding with matching connectionId for provider=hyperliquid`
- `auto-creates exactly one trading binding with matching connectionId for provider=jupiter`
- `auto-creates exactly one trading binding with matching connectionId for provider=1inch`
- `auto-creates exactly one trading binding with matching connectionId for provider=bybit`

These parameterised tests lock down the auto-creation contract: POST /connections inserts exactly two rows (connection + binding) for every trading provider. Callers must query for the binding rather than attempting a second insert.
