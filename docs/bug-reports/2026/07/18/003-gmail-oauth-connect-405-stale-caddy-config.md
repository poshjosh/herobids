# Bug Report: Gmail Connect Returns HTTP 405 Due To Stale Caddy Config On Staging

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-18
- **Summary:** On staging, clicking "Add connection" → Gmail → "Connect agent to platform" failed with `HTTP 405`. The `POST /connections/oauth/gmail/authorize` request was being answered by the web SPA's nginx (which rejects POST) instead of the API, because the running `caddy` container was serving a stale, pre-fix proxy configuration.

## Root Cause

Commit `8bc5d5eb` ("feat(infra): add Caddy routing for connections OAuth flow", 2026-07-17) added a `handle /connections/oauth/* { reverse_proxy api:3000 }` block to `Caddyfile.staging` / `Caddyfile.prod`. That change was correctly pulled to the staging server (`git log` on the server showed the commit, and the on-disk `Caddyfile.staging` already contained the block).

However, the deploy path used (`maintenance-restart.sh`, invoked via `maintenance-restart-from-local.sh --env staging`) only runs `docker compose up -d --build --remove-orphans`. Docker Compose decides whether to recreate a container by diffing the *declared* service config (image, env, ports, volumes list) — it has no visibility into the *contents* of a bind-mounted file. Since `Caddyfile.staging` is bind-mounted (`./Caddyfile.staging:/etc/caddy/Caddyfile:ro`) and the `caddy` service's compose definition itself never changed, Compose never recreated/restarted the `caddy` container. The container had been running for 36+ hours (since before the fix commit), silently serving the old config where `/connections/oauth/*` fell through to the catch-all `handle { reverse_proxy web:80 }`.

As a result, the SPA's authenticated `POST /connections/oauth/gmail/authorize` request was routed to the web container's nginx, which returns `405 Not Allowed` for POST on its static/SPA-fallback config — surfaced to the user as a generic `HTTP 405` (identifiable by the `nginx/1.27.5` signature in the raw HTML error body, vs. Fastify's JSON error format).

Note: `push.sh` already contains a `docker compose ... restart caddy` step with a comment describing exactly this class of bug — but `maintenance-restart.sh` (a separate deploy/restart script also used in normal operation) did not, which is the actual gap that let this regression reach staging.

## Fix

- Added a `docker compose ... restart caddy` step to `maintenance-restart.sh`, immediately after the api/worker/web restart step, matching the existing safeguard already present in `push.sh`.
- Added the same `restart caddy` step to the rollback path (`rollback_on_failure`) so a rollback to a previous revision also re-syncs the proxy config.
- Restarted `caddy` on the staging server directly to apply the already-correct on-disk config and unblock the live issue immediately.

## Files Changed

- `infra/hetzner/scripts/maintenance-restart.sh`

## Verification

- `bash -n infra/hetzner/scripts/maintenance-restart.sh` — syntax OK.
- On the staging server: `docker exec herobids-caddy-1 cat /etc/caddy/Caddyfile` now shows the `/connections/oauth/*` block (previously missing).
- `curl -sk -i -X POST --resolve staging.openaidom.com:443:127.0.0.1 https://staging.openaidom.com/connections/oauth/gmail/authorize` now returns `401 Missing or invalid Authorization header` (Fastify JSON error) instead of `405 Not Allowed` (nginx HTML error) — confirming the request now reaches the API.
