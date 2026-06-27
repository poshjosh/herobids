# Bug Report: Worker Crash — Missing `config/providers.yaml` in Docker Container

**Bug ID:** 004-worker-missing-providers-yaml-path
**Severity:** Critical
**Date:** 2026-06-27
**Status:** FIXED

## Summary

The worker process crashes on startup inside the Docker container with `ENOENT: no such file or directory, open 'config/providers.yaml'`. The worker becomes stuck in a crash loop because `restart: unless-stopped` keeps restarting it.

## Root Cause

In `apps/worker/src/index.ts`, the providers config was loaded with a bare relative path:

```ts
const providersYaml = loadProvidersConfig('config/providers.yaml');
```

This resolves relative to the CWD, which in the Docker container is `/app/apps/worker` (set by `WORKDIR` in the Dockerfile). The resolved path `/app/apps/worker/config/providers.yaml` does not exist — the Dockerfile correctly copies config files to `/app/config/`, not `/app/apps/worker/config/`.

The API (`apps/api/src/index.ts`) already handled this correctly by resolving the path from the module's own directory using `fileURLToPath(import.meta.url)` + `../../../config`. The worker had the same path resolution logic in its own `config.ts` for loading `default.yaml`, but this logic was not exported or reused for `providers.yaml`.

## Fix

1. **`apps/worker/src/config.ts`** — Exported the existing `MONOREPO_CONFIG_DIR` constant so it can be reused by `index.ts`.
2. **`apps/worker/src/index.ts`** — Added `import { resolve } from 'node:path'` and imported `MONOREPO_CONFIG_DIR` from `./config.js`. Changed the providers config load to use the resolved path:
   ```ts
   const providersYaml = loadProvidersConfig(resolve(MONOREPO_CONFIG_DIR, 'providers.yaml'));
   ```

## Files Changed

- `apps/worker/src/config.ts` — changed `const MONOREPO_CONFIG_DIR` → `export const MONOREPO_CONFIG_DIR`
- `apps/worker/src/index.ts` — added `resolve` import from `node:path`, imported `MONOREPO_CONFIG_DIR`, resolved providers.yaml path

## Verification

- `pnpm lint` (tsc --noEmit) passes clean with no errors
- The resolved path logic is identical to what the API uses and what `config.ts` already uses for `default.yaml`
