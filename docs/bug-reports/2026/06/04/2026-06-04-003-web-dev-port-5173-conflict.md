# Bug Report: Web dev stack fails when host port 5173 is already allocated

- **Status:** CLOSED
- **Severity:** Medium
- **Date:** 2026-06-04
- **Summary:** `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d` failed because the `web` service tried to bind host port `5173`, which was already in use on the developer machine.

## Root Cause

The development override hard-coded the frontend publish mapping as `5173:5173`. When Docker attempted to start the `web` container, the daemon could not reserve host port `5173` and aborted startup with `Bind for 0.0.0.0:5173 failed: port is already allocated`.

The API service in the dev stack also pointed `AUTH_FRONTEND_ORIGIN` at `http://localhost:5173`, so simply changing the web host port would have broken auth redirects unless both values were updated together.

## Fix

- Made the dev web host port configurable with `WEB_PORT` and changed the default host port to `8080` so the standard dev compose command avoids a common local conflict.
- Updated the dev API service to derive `AUTH_FRONTEND_ORIGIN` from the same `WEB_PORT` value, so redirects stay aligned when the host port changes.
- This still allows users to override the host port explicitly, for example `WEB_PORT=5173 docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d`.

## Files Changed

- `docker-compose.dev.yaml`

## Verification

- Confirmed the edited compose file interpolates `WEB_PORT` for both the `web` publish mapping and `api` frontend origin.
- Checked the fix against the reported failure mode: the default dev stack now starts without requiring host port `5173` to be free.

## Regression Tests

No automated unit test is feasible for a Docker Compose configuration change. The fix is verified by:
1. Inspecting `docker-compose.dev.yaml` to confirm `${WEB_PORT:-8080}` is used for both the `web` publish port and `AUTH_FRONTEND_ORIGIN`.
2. Manual smoke: `docker compose up -d` succeeds when port 5173 is already occupied on the host.