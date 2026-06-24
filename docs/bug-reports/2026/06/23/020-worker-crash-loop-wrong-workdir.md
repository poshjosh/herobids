# Bug Report: Worker Container Crash Loop — WORKDIR Misconfigured in Docker Image

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-06-23

## Summary

The `herobids-worker` container enters an infinite restart loop (exit code 0), producing no logs. This causes all agent-trade-test runs to fail at Phase 2.5 (bot creation) because the broker never processes the `manage_bot` message. The root cause is that the worker Docker image was built only up to the `build` stage, not the full multi-stage `runtime` stage. WORKDIR remained `/app` (from the build stage) instead of `/app/apps/worker`, so `CMD ["node", "dist/index.js"]` resolved to `/app/dist/index.js` which does not exist, causing Node.js to exit with `MODULE_NOT_FOUND`.

## Symptoms

```
$ docker ps --filter name=worker
herobids-worker-1   Restarting (0) 54 seconds ago

$ docker logs herobids-worker-1
(empty — no output at all)

$ docker run --rm herobids-worker:latest pwd
/app    ← should be /app/apps/worker
```

Agent trade test fails:
```
──── Phase 2.5: Agent bot creation ────
18:54:41.240  ✓ Manage-bot message published to agent inbound stream
18:55:11.335  ✗ FATAL: Bot was not created within 30s — broker may have rejected the manage_bot message
```

## Root Cause

The worker Dockerfile (`apps/worker/Dockerfile`) is a multi-stage build:

```dockerfile
FROM node:22-alpine AS base       # WORKDIR inherited from base image
FROM base AS build                 # WORKDIR /app (set in this stage)
# ... build commands ...
FROM build AS deploy               # WORKDIR /app (inherited)
# ... deploy commands ...
FROM node:22-alpine AS runtime     # WORKDIR /app/apps/worker ← MUST be set
COPY --from=build /app/config /app/config
COPY --from=deploy /deploy/worker ./
CMD ["node", "dist/index.js"]
```

The image was only built up to the `build` stage — the `runtime` stage layers (WORKDIR `/app/apps/worker`, COPY from deploy, CMD override) were never applied. This means:
- `WORKDIR` = `/app`
- `CMD` = `["node"]` (base image default, not `["node", "dist/index.js"]`)
- The compiled JS is at `/app/apps/worker/dist/index.js` (not at `/app/dist/index.js`)

When Docker Compose runs the container, it executes `node dist/index.js` from `/app`, which fails with `MODULE_NOT_FOUND`. The process exits with code 1, and `restart: unless-stopped` immediately restarts it, creating an infinite crash loop.

### Why did the runtime stage not get built?

The Docker build cache for the runtime stage's `WORKDIR /app/apps/worker` and `COPY --from=build /app/config /app/config` steps was **stale/corrupt**. The build system used cached layers that pointed to the wrong intermediate stage. A rebuild with no cache (or with proper cache invalidation) fixes this.

## Fix

Rebuild the worker image from scratch to ensure all multi-stage layers are applied:

```bash
cd /path/to/herobids
docker build -f apps/worker/Dockerfile -t herobids-worker:latest .
```

Verify:
```bash
docker run --rm herobids-worker:latest pwd
# Should output: /app/apps/worker
```

After rebuilding, restart the compose stack:
```bash
docker compose -f docker-compose.yaml down
docker compose -f docker-compose.yaml up -d
```

### Additional cleanup

Clear any stale messages from previous failed test runs in Redis:
```bash
docker compose exec redis redis-cli DEL 'agent:inbound:<agent-id>'
```

### Additional fix: Agent Stream Consumer NOGROUP resilience

A secondary issue was found: when a subscribed Redis stream's consumer group is deleted externally (e.g. by deleting the stream key), the `AgentStreamConsumer.readLoop()` fails with `NOGROUP` for **all** streams in the batch. This blocks processing of healthy streams.

**Fix in `apps/worker/src/agents/agent-stream-consumer.ts`:** The catch handler now detects `NOGROUP` errors and recreates missing consumer groups (or unsubscribes from streams that can't be recovered), preventing one broken stream from starving all others.

## Files Changed

1. `apps/worker/src/agents/agent-stream-consumer.ts` — Added NOGROUP recovery in readLoop catch handler
2. Worker Docker image rebuilt with `docker build -f apps/worker/Dockerfile -t herobids-worker:latest .`

## Verification

1. `docker run --rm herobids-worker:latest pwd` → `/app/apps/worker` ✓
2. Worker container starts and produces log output ✓
3. Worker container stays running (not restarting) ✓
4. Agent trade test passes Phase 2.5 (bot creation): `✓ Bot created` ✓
5. Agent trade test passes full cycle: `PASS — agent opened and closed a position — full trade cycle confirmed.` ✓

## Prevention

Consider adding a healthcheck to the worker container to detect this failure mode early:
```yaml
worker:
  healthcheck:
    test: ['CMD-SHELL', 'node -e "require(\"./dist/index.js\")" || exit 1']
    interval: 10s
    timeout: 5s
    retries: 3
    start_period: 15s
```

This would cause Docker Compose to mark the worker as unhealthy (rather than silently restarting it) when the entry point is misconfigured.
