# 004-worker-unused-import-market-data-config

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-18
- **Summary:** Docker build fails on `worker` target because `MarketDataConfig` is imported as a type but never used in `apps/worker/src/index.ts`.

## Root Cause

`apps/worker/src/index.ts` imported `type MarketDataConfig` from `@herobids/market-data` but the type was never referenced in any type annotation. The worker's `tsconfig.json` extends `tsconfig.base.json` which sets `noUnusedLocals: true`. The Docker build runs `tsc --build` for the worker package, which enforces this.

Note: root-level `pnpm lint` (`tsc --noEmit`) does NOT catch this because the worker is a project reference and not part of the root's compilation scope.

## Fix

Removed `type MarketDataConfig, ` from the import declaration on line 48.

```ts
// Before
import { ..., type MarketDataConfig, type RedisEvalClient, type TokenInfo } from '@herobids/market-data';

// After
import { ..., type RedisEvalClient, type TokenInfo } from '@herobids/market-data';
```

## Files Changed

- `apps/worker/src/index.ts` — line 48: removed unused `type MarketDataConfig` import

## Verification

```bash
pnpm --filter @herobids/worker run build
# tsc --build — clean, exit 0
```
