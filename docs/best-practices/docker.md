# Docker Build Conventions

## Shared Dockerfile

All server-side services (`api`, `worker`) are built from the root `Dockerfile` using BuildKit multi-stage targets.

| Target | Used by | Purpose |
|---|---|---|
| `build-shared` | dev compose, CI | installs deps + compiles 7 shared packages once |
| `build-api` | internal | extends `build-shared`, compiles api |
| `build-worker` | internal | extends `build-shared`, compiles worker |
| `api` | production | self-contained api runtime image |
| `worker` | production | self-contained worker runtime image |

Shared packages are compiled **once** in `build-shared`. Both `api` and `worker` inherit from that stage — halving peak memory and build time on the low-RAM Hetzner server (`cx23`, 4 GB, no swap).

## Dev compose

`docker-compose.dev.yaml` uses `target: build-shared` for both `api` and `worker`. The app package itself is not compiled — `tsx/esm` runs the TypeScript source directly at runtime.

## Do not wipe build cache between deploys

`docker builder prune` must not run as part of `push.sh` or `reset.sh`. BuildKit manages its own cache size automatically. Pruning after every deploy guarantees a 30-minute cold build next time.

If a specific image needs a cache-busting rebuild (e.g. after a suspected corrupt layer per [bug 020](../bug-reports/2026/06/23/020-worker-crash-loop-wrong-workdir.md)), use:
```bash
docker compose build --no-cache api worker
```

## Other images

| Image | Dockerfile | Notes |
|---|---|---|
| `herobids-agent:latest` | `docker/Dockerfile.agent` | Built explicitly in `push.sh` before compose up |
| migrate | `docker/Dockerfile.migrate` | One-shot; no TypeScript compilation |
| web | `apps/web/Dockerfile` | Vite/React; separate build chain |
