# Bug Report: Stale Cached SPA Bundle Replays Pre-Fix Gmail OAuth Navigation

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-18
- **Summary:** After the Gmail OAuth client fix and the Caddy routing fix were both deployed to staging, a user still saw a raw `{"error":"Missing or invalid Authorization header"}` JSON response when clicking "Connect Gmail". The browser was running a stale, pre-fix cached copy of the SPA bundle that navigated directly (`window.location.href`) to our own `/connections/oauth/gmail/authorize` GET endpoint instead of fetching an authenticated authorize URL first.

## Root Cause

`docker/nginx.conf` (served by the `web` container) set no `Cache-Control` headers at all for any file, including `index.html`. Since Vite's `index.html` is the SPA's only non-content-hashed entry point (it references the current build's hashed `/assets/*.js` bundle by name), the absence of an explicit `Cache-Control` header left it subject to browser heuristic caching. A browser that cached `index.html` before the 2026-07-17 21:21 client-side fix (commit `961d7626`, which replaced `window.location.href = \`/connections/oauth/${provider}/authorize\`` with an authenticated `POST` via `connectionsApi.beginOAuth`) kept re-running that old bundle indefinitely, even though the server had long since redeployed the fixed code.

Confirmed on the staging server via API access logs: a real request arrived as `GET /connections/oauth/gmail/authorize` with `sec-fetch-dest: document`, `sec-fetch-mode: navigate`, `sec-fetch-user: ?1`, and `referer: https://staging.openaidom.com/connections` — a genuine top-level page navigation, not a `fetch()`/XHR call. That GET route requires a JWT (not a public route) and a browser navigation cannot attach a `Bearer` token, so it returned `401 {"error":"Missing or invalid Authorization header"}`, which the browser rendered as raw JSON (consistent with a direct navigation rather than the SPA's styled `ErrorBanner`, which only renders for `fetch`-originated errors).

This is unrelated to [003](./003-gmail-oauth-connect-405-stale-caddy-config.md) (stale Caddy proxy config) — that was fixed and verified separately. This bug is entirely about the browser's own HTTP cache serving a stale JS bundle.

## Fix

Added explicit `Cache-Control` headers to `docker/nginx.conf`:
- `/assets/*` (Vite's content-hashed JS/CSS output): `Cache-Control: public, max-age=31536000, immutable` — safe to cache indefinitely since a new deploy always emits new filenames.
- Everything else (the SPA fallback route serving `index.html`): `Cache-Control: no-cache` — forces browsers to always revalidate, so a stale HTML shell referencing an old bundle is never served after a deploy.

## Files Changed

- `docker/nginx.conf`

## Verification

- Rebuilt the `web` image on the staging server (`docker compose build web`, targeted single-service build to avoid the known parallel-bake OOM/CPU-starvation risk on the Hetzner box) and recreated the `web` container.
- `docker exec herobids-web-1 nginx -t` — config syntax OK.
- `curl -I https://staging.openaidom.com/assets/<hashed>.js` → `cache-control: public, max-age=31536000, immutable`.
- `curl -I https://staging.openaidom.com/connections` → `cache-control: no-cache`.
- `/health` still returns `200` after the redeploy.
- The affected user still needs one hard-refresh (or a browser restart) to evict their already-cached stale `index.html`; all subsequent deploys will self-correct automatically since `index.html` will no longer be cached going forward.
