# Bug Report: Backtesting Package Exports Point to TypeScript Source Instead of Compiled Output

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-05-31
- **Discovered:** Stage C runner — API crashed on startup with `ERR_MODULE_NOT_FOUND`
- **Summary:** `packages/backtesting/package.json` used `"main": "./src/index.ts"` instead of proper `exports` pointing to `./dist/`. Node.js resolved imports to the TypeScript source, which contains `.js` extension imports that don't exist in `src/`, causing a fatal module resolution error at runtime.

## Symptoms

API process crashed immediately on startup:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/Users/.../packages/backtesting/src/simulated-clock.js'
  imported from /Users/.../packages/backtesting/src/index.ts
```

Any app importing `@herobids/backtesting` would fail.

## Root Cause

`packages/backtesting/package.json` had:

```json
{
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
```

This worked during `tsc` compilation (which resolves `.js` extensions to `.ts` files), but at runtime Node.js followed `main` to `src/index.ts`, encountered `export { SimulatedClock } from './simulated-clock.js'`, and looked for a literal `simulated-clock.js` file in `src/` — which doesn't exist (only `.ts` files there).

All other packages in the monorepo use the correct pattern with `exports` pointing to `dist/`.

## Fix

Replaced `main`/`types` with proper conditional exports:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  }
}
```

## Impact

- Blocked all runtime usage of the backtesting package (API, worker)
- Build (`tsc`) still passed — this was a runtime-only failure
- Likely introduced when the backtesting package was initially created without matching the pattern of other packages

## Prevention

- Add a smoke test that imports each workspace package at runtime (not just type-checks)
- Or enforce `exports` field presence in a lint rule for all `packages/*/package.json`
