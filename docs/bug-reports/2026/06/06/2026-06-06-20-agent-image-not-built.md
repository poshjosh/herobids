- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-06-06
- **Summary:** After the TCP URL normalization fix (bug #19), the agent runtime correctly reaches the Docker API, but container creation fails with HTTP 404 because the `herobids-agent:latest` image has never been built on the local machine.

## Symptoms (from worker logs)

```
Docker event stream subscription started     ← Docker API reachable (bug #19 fixed)
Error: Docker container create failed: 404 {"message":"No such image: herobids-agent:latest"}
  at DockerAgentManager.start (.../docker-agent-manager.ts:130)
Stale agent start detected
Agent session start timed out
```

Agent remains in `stopped` status. No container appears in `docker ps --filter "label=herobids.role=agent"`. No Redis streams are created.

## Root Cause

`herobids-agent:latest` is a standalone Docker image defined in `docker/Dockerfile.agent`. It is **not** declared as a service in `docker-compose.yaml` or `docker-compose.dev.yaml`, so it is never built by `docker compose up --build`. On a fresh checkout or machine where it has not been manually built, the image is absent from the local Docker registry.

When the worker (via `DockerAgentManager.start`) issues a `POST /containers/create` to the Docker daemon with `Image: herobids-agent:latest`, the daemon returns:

```json
HTTP 404 {"message":"No such image: herobids-agent:latest"}
```

## Fix

Build the agent image once from the monorepo root before starting an agent:

```bash
docker build -f docker/Dockerfile.agent -t herobids-agent:latest .
```

The `Dockerfile.agent` comment at the top documents this exact command.

### Longer-term improvements (optional)

- Add an `agent` build target to a top-level `Makefile` or `pnpm build:docker` script so developers can build all images in one step.
- Add a compose health-check or pre-flight in `DockerAgentManager` that validates the image exists before attempting to create a container, surfacing a clearer error.
- Add the image build to CI so it is always present in the local dev registry after a fresh `docker compose up`.

## Files Changed

None (fix is an operational step, not a code change).

## Verification

After building the image:

1. `docker images herobids-agent` shows `herobids-agent  latest  <id>  ...`
2. Worker logs no longer show the 404 error on container create.
3. `docker ps --filter "label=herobids.role=agent"` shows the running agent container.
4. Redis key `agent:inbound:<agentId>` is created.
5. `agent_runtime_sessions.last_heartbeat_at` starts advancing.
6. Agent status transitions to `active`.
