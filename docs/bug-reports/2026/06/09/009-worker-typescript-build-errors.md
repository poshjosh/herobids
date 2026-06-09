# 009 — Worker: Multiple TypeScript build errors

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** `apps/worker` build had several TypeScript errors: unused imports, optional-property closures not narrowed, possibly-undefined constants, and `Map.get` result not checked before use.
- **Root Cause:**
  1. `index.ts` imported `HyperliquidPublicStream` and `BybitPublicStream` but didn't use them directly (they are used via `public-stream-routing.ts`).
  2. `public-stream-routing.ts`: TypeScript doesn't narrow optional properties accessed through closures — `hyperliquidVenueConfig.wsUrl` was type `string | undefined` inside a `() =>` arrow, even though the `if` guard had already checked it in the outer scope.
  3. `tools/code.ts`: `_runtimePolicy.defaultTimeoutMs` and `defaultMaxOutputBytes` are `number | undefined` so the nullish-coalesce fallbacks needed numeric defaults.
  4. `tools/market-data.ts`: `priceResults.get(key)` returns `T | undefined`, which must be checked before accessing `.ok`.
- **Fix:** 
  - Removed unused stream class imports from `index.ts`.
  - Captured optional URL values into `const` variables before the arrow function in `public-stream-routing.ts`.
  - Added numeric fallbacks (`30_000` / `1_048_576`) for the code tool limits.
  - Added `!result ||` guard in `market-data.ts`.
- **Files Changed:**
  - `apps/worker/src/index.ts`
  - `apps/worker/src/public-stream-routing.ts`
  - `apps/worker/src/tools/code.ts`
  - `apps/worker/src/tools/market-data.ts`
- **Verification:** `pnpm build` and `pnpm lint` complete without errors.
