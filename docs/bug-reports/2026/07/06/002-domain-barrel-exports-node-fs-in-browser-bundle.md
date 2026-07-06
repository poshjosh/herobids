# 002 — Domain barrel exports pull node:fs into browser bundle

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-06
- **Summary:** `pnpm build` failed because Vite's browser build pulled `node:fs` into the web bundle via domain package barrel exports. The domain package's `config/index.ts` re-exported Node-specific functions (`loadProvidersConfig`, `loadPresets`, `getPreset`, `listPresets`, `resetPresetCache`) that imported `readFileSync` from `node:fs`. Even though the web app never imported these functions, Rollup's tree-shaking couldn't eliminate them because they shared the same barrel module as browser-safe exports (`SWAP_VENUES`, `ProviderDefinition`, etc.) that the web app DID use.
- **Root Cause:** The `packages/domain` package barrel-exported Node-specific file I/O functions through `config/index.ts`. When the web app imported any export from this barrel (e.g., `SWAP_VENUES`), Rollup loaded the entire `config/index.ts` module, which transitively imported `load-providers.js` and `presets.js` — both of which used `readFileSync` from `node:fs` at module scope.
- **Fix:**
  1. Removed `loadProvidersConfig` from `config/index.ts` barrel; moved to dedicated subpath `@herobids/domain/config/load-providers`
  2. Split `presets.ts` into browser-safe (`agentStyleToPresetStyle`, `applyPresetToAgent`, types/schemas) and Node-specific (`loadPresets`, `getPreset`, `listPresets`, `resetPresetCache`) — the latter now in `presets-loader.ts` with subpath `@herobids/domain/config/presets-loader`
  3. Updated all server-side imports (api, worker, scripts) to use the new subpaths
  4. Added vitest aliases for subpath resolution (order matters: specific subpaths before general `@herobids/domain`)
  5. Fixed `presets.test.ts` to import browser-safe functions directly (no cache reset needed)
  6. Added `pnpm --filter @herobids/domain run build` to `apps/web/Dockerfile` (dist files were excluded by `.dockerignore`)
  7. Fixed ccxt `Market` type issues in `bybit.ts` and `hyperliquid.ts` (`Object.values(markets)` returns `(Market | undefined)[]`)
  8. Fixed `hlAdapter`/`bybitAdapter` possibly-undefined errors in worker `index.ts` by capturing adapters in const closures
  9. Removed unused `DecisionIntakeDeps` import from `agent-intake-resolver.ts`
- **Files Changed:**
  - `packages/domain/package.json` — added `sideEffects: false`, subpath exports for load-providers and presets-loader
  - `packages/domain/src/config/index.ts` — removed Node-specific re-exports
  - `packages/domain/src/config/presets.ts` — split out loader functions; now browser-safe only
  - `packages/domain/src/config/presets-loader.ts` — new file with Node-specific preset loading
  - `packages/domain/src/config/presets.test.ts` — updated imports for split modules
  - `apps/api/src/index.ts` — updated import path for `loadProvidersConfig`
  - `apps/api/src/routes/agents.ts` — updated import path for `getPreset`
  - `apps/api/src/routes/blueprints.ts` — updated import path for `listPresets`, `getPreset`
  - `apps/api/src/__tests__/functional/helpers.ts` — updated import path
  - `apps/worker/src/index.ts` — updated import path; fixed adapter closure captures
  - `apps/worker/src/agents/agent-intake-resolver.ts` — removed unused import
  - `apps/web/Dockerfile` — added domain build step before web build
  - `vitest.config.ts` — added subpath aliases (specific before general)
  - `packages/venues/src/bybit.ts` — fixed Market type filter
  - `packages/venues/src/hyperliquid.ts` — fixed Market type filter
  - `scripts/ts/seed-usage-rate-card.ts` — updated import path
- **Verification:** `pnpm build` passes, `pnpm lint` passes, agent Docker image builds, unit tests (3787 passed, 162 skipped), integration tests (130 passed), functional tests (all passed), API smoke tests (runtime-policy: 29/29, strategy-presets: 21/21). E2E tests: 13/24 passed, 4 failures pre-existing (signup timeout + bot modal strict locator), 7 skipped. Agent-evaluation smoke: 3/6 — pre-existing model config issue.
