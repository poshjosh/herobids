# Bug Report: Strategy Preset YAML — ENOENT in Docker

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-03
- **Summary:** `GET /blueprints/presets` returned 500 ENOENT inside Docker; UI showed "No presets available for this style."

## Root Cause

`packages/domain/src/config/presets.ts` resolves YAML paths using `process.cwd()`:

```ts
return `${process.cwd()}/${relativePath}`;
```

Both Dockerfiles set `WORKDIR /app/apps/api` (or `…/worker`) for the runtime/build stage, so `process.cwd()` was `/app/apps/api`. The YAML files live at `/app/config/strategy-presets/` (copied from the build stage), meaning the resolved path `/app/apps/api/config/strategy-presets/economy.yaml` does not exist.

The `resolveConfigPath()` function already had an env-var escape hatch (`HEROBIDS_CONFIG_DIR`) but it was never set.

## Fix

Set `HEROBIDS_CONFIG_DIR=/app` so the loader resolves paths relative to the project root where `config/` lives.

Three files changed:

1. `apps/api/Dockerfile` — added `ENV HEROBIDS_CONFIG_DIR=/app` in the `runtime` stage.
2. `apps/worker/Dockerfile` — same addition in the `runtime` stage.
3. `docker-compose.dev.yaml` — added `HEROBIDS_CONFIG_DIR: /app` to both `api` and `worker` environment blocks (dev uses the `build` stage, which does not inherit the Dockerfile `ENV`).

## Files Changed

- `apps/api/Dockerfile`
- `apps/worker/Dockerfile`
- `docker-compose.dev.yaml`

## Verification

```bash
docker exec herobids-api-1 printenv HEROBIDS_CONFIG_DIR
# → /app

scripts/shell/tests/test-presets.sh
# → 200 with all 7 presets for each style tier
```
