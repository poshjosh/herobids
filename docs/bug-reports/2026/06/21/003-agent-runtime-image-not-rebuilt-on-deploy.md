# Bug Report: Agent Runtime Image Not Rebuilt on Production Deploy

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-06-21

## Summary

`infra/hetzner/scripts/reset.sh` rebuilds the compose services (`api`, `worker`, `web`) but never rebuilds the `herobids-agent:latest` Docker image. Every agent container spawned after a deployment runs the stale image from the previous deploy, regardless of what code was just pulled.

## Symptoms

Schema fix deployed in `0.0.1-2026.06.21-b` (commit `78d3492`) was confirmed committed and in `origin/main`. Server was redeployed to `0.0.1-2026.06.21-c` via `reset-and-run.sh`. DeepSeek 400 errors on agent tool calls continued unchanged after the redeploy:

```
errorMessage: Provider returned 400: {"error":{"message":"Invalid schema for
              function 'get_analytics': true is not of type \"number\""}}
```

The compose `worker` service (which spawns agent containers) was running new code. The agent containers it spawned used the cached `herobids-agent:latest` image — unchanged since before the fix was deployed.

## Root Cause

`reset.sh` SSH block on the server:

```bash
git fetch --all && git reset --hard origin/main
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build --remove-orphans
```

`docker compose up --build` rebuilds only images declared with `build:` in `docker-compose.yaml`. The `herobids-agent:latest` image is referenced as a plain `image:` tag in the worker service env (`AGENT_IMAGE: herobids-agent:latest`) and is built separately via `docker build -f docker/Dockerfile.agent`. It is never declared as a compose build target, so compose never rebuilds it.

The local equivalent (`scripts/shell/run/reset-and-run.sh`) calls `build-and-run.sh` which has an explicit `docker build -f docker/Dockerfile.agent -t herobids-agent:latest .` step. This step was missing from the production script.

## Fix

Added agent image build step to `reset.sh` immediately after `git pull`, before `docker compose up`:

```bash
echo "[...] Building agent runtime image (herobids-agent:latest)..."
docker build --pull -f docker/Dockerfile.agent -t herobids-agent:latest .
```

## Files Changed

- `infra/hetzner/scripts/reset.sh` — added `docker build` for agent image

## Verification

After redeploying with this fix in place, the `herobids-agent:latest` image will be rebuilt from the latest source on every `reset-and-run.sh` invocation. DeepSeek 400 schema errors should stop occurring.
