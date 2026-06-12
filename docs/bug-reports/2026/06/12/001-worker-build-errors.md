# 001 — Worker build errors: unused import and type cast failures

**Date:** 2026-06-12  
**Severity:** High (blocks CI build)  
**Affected files:**
- `apps/worker/src/agent.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/tools/market-data.ts`

## Symptoms

`pnpm build` failed with three TypeScript errors in `apps/worker`:

1. `buildDiscoveryNetworkMap` was imported from `./venue-intelligence.js` but never used.
2. `marketDataConfig` (typed as `MarketDataConfig` from `@herobids/market-data`) was not assignable to `Record<string, unknown>` (the type declared on `ToolContext` in `packages/domain/src/tools.ts`).
3. `TokenInfo` was imported from `@herobids/market-data` but unused; `poolCreatedAt` property did not exist on the `TokenInfo` type.

## Root Cause

- `buildDiscoveryNetworkMap` was removed from `venue-intelligence.ts` exports but the import in `agent.ts` was not updated.
- `packages/domain/src/tools.ts` declares `marketDataConfig?: Record<string, unknown>` (a generic bag) but `apps/worker` passes the concrete `MarketDataConfig` type, which is not structurally compatible.
- `TokenInfo` was renamed/restructured and no longer includes `poolCreatedAt` as a typed property.

## Fix Applied

1. Removed `buildDiscoveryNetworkMap` from the import in `agent.ts`.
2. Applied double cast `marketDataConfig as unknown as Record<string, unknown>` in `agent.ts` and `as unknown as MarketDataConfig` in `market-data.ts` to bridge the type mismatch. Root cause in `packages/domain/src/tools.ts` left for a follow-up typed refactor.
3. Removed unused `TokenInfo` import; accessed `poolCreatedAt` via an intersection cast `(exactMatch as typeof exactMatch & { poolCreatedAt?: string }).poolCreatedAt`.
