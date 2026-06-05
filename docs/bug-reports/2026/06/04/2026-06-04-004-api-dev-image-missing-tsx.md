# Bug Report: API dev container restarts because the runtime image does not include `tsx`

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** After restarting the dev stack with `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d`, the API container entered a restart loop with `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /app/apps/api/`.

## Root Cause

The API service was launching with a runtime-stage image that did not contain the dev toolchain. Inside the container, both `pnpm` and `tsx` were absent:

- `pnpm` was not found in the API container shell
- `require.resolve('tsx')` failed from `/app/apps/api`

The worker service uses a build-stage image that does include `pnpm` and `tsx`, which is why it starts successfully. The API service needs to be built and run from the dev/build-stage image as well; otherwise the `node --import tsx/esm src/index.ts` entrypoint cannot resolve its loader.

## Fix

- Updated the dev compose config to give the API service its own dev image tag (`herobids-api-dev`) so it does not reuse the stale runtime image tag.
- Kept the API/web origin wiring aligned with the dev host port override (`WEB_PORT`, default `8080`).
- A clean `docker compose down` followed by `docker compose up -d --build` is required to materialize the new image before the API can start successfully.

## Files Changed

- `docker-compose.dev.yaml`

## Verification

- Confirmed the dev compose config now resolves `image: herobids-api-dev` for the API service.
- Confirmed the old runtime image `herobids-api:latest` lacked `pnpm` and `tsx`.
- Confirmed the worker image contains `pnpm` and resolves `tsx` successfully.
- Confirmed a clean `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml down && docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d --build` completed successfully and started `api`, `worker`, `web`, `postgres`, and `redis`.