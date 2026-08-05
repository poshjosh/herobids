# 003 — Real-time event stream fails in the web container: nginx drops WebSocket upgrade headers

- **Status:** FIXED
- **Severity:** MEDIUM
- **Date:** 2026-08-05
- **Discovered:** Manual browser UAT session (2026-08-05)
- **Environment:** local Docker Compose stack (`docker-compose.yaml` web container)
- **Component:** `docker/nginx.conf`, frontend event stream (`apps/web/src/lib/useEventStream.ts`)

## Summary

The frontend's real-time event stream (agent/bot status changes, order fills, platform alerts) could not connect when the app was served from the web container's nginx. The browser's `WebSocket` connection to `ws://localhost:5173/api/events?token=…` failed with:

```
WebSocket connection to 'ws://localhost:5173/api/events?token=…' failed:
Error during WebSocket handshake: Unexpected response code: 404
```

The connection retried in an exponential-backoff loop indefinitely, so **live UI updates silently never arrived** in the deployed web container.

## Root cause

`docker/nginx.conf` proxied `/api/` to the `api:3000` service but did **not** forward the WebSocket `Upgrade`/`Connection` headers, and used `HTTP/1.0` by default (nginx's `proxy_http_version` default is `1.0`, which does not support the `Upgrade` handshake). Without `proxy_set_header Upgrade` / `Connection`, nginx strips the upgrade request, so the API's `/events` WebSocket route never matches and nginx falls through to the SPA `location /` → `index.html`, returning 404.

Verified:

- Direct connection to the API works: `ws://localhost:3000/events?token=…` → **OPEN**.
- Through nginx before fix: `ws://localhost:5173/api/events?token=…` → **ERROR (404)**.

Production was **not** affected: `docker-compose.prod.yaml` terminates TLS at Caddy, and Caddy's `reverse_proxy` (Caddyfile.prod) performs WebSocket upgrades automatically.

## Fix

Added a `map` block (at the http context level, outside the `server` block) and forwarded the upgrade headers on the `/api/` location in `docker/nginx.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

location /api/ {
    proxy_pass http://api:3000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
}
```

Note: the `map` directive must be at the `http` context level — placing it inside the `server` block causes `nginx: [emerg] "map" directive is not allowed here` and a crash-loop.

## Verification

- After rebuild, `ws://localhost:5173/api/events?token=…` → **OPEN**.
- Reloading the app produced **zero** WebSocket connection errors in the browser console (previously one error every ~30 s during reconnection backoff).

## Impact

Local/dev Docker web container now delivers real-time updates correctly. No code change to `useEventStream.ts` or the API was required — the API's `/events` endpoint was already correct.
