- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-06
- **Summary:** Agent runtime containers fail to launch in Docker mode when `DOCKER_HOST` uses the `tcp://` scheme. Every Docker API call fails with `fetch failed: getaddrinfo ENOTFOUND tcp`, so agents time out in `starting` and are marked `stopped`.

## Symptoms (from worker logs)

```
Agent runtime launcher initialized   mode=docker
Docker event stream subscription started
fetch failed: getaddrinfo ENOTFOUND tcp   (repeats every 5 s)
Failed to launch starting session         sessionId=a3f5f5b7... agentId=403819ea...
Stale agent start detected
Agent session start timed out
```

The two consecutive platform messages written to `agent_outbound_messages`:

```
Critical Execution Failure — Agent session launch failed — the runtime could not be started.
Runtime Failed — Agent runtime failed to start — the runtime did not connect within the expected window.
```

Agent status returns to `stopped`. No container with the `herobids.role=agent` label appears in `docker ps`. No Redis streams are created for the agent.

## Root Cause

`DockerAgentManager` normalises `DOCKER_HOST` in its constructor:

```ts
this.dockerApiBase = _config.dockerHost.startsWith('http')
  ? _config.dockerHost
  : `http://${_config.dockerHost}`;
```

When the compose environment provides `DOCKER_HOST=tcp://docker-proxy:2375` the value does not start with `http`, so the constructor produces:

```
http://tcp://docker-proxy:2375
```

Undici then attempts a DNS lookup for the hostname `tcp`, which fails with `ENOTFOUND tcp`. Every subsequent Docker API call — event stream, container create, container inspect — hits the same unresolvable host. The agent runtime can never start.

## Environment

- Deployment: local docker compose dev (`docker compose -f docker-compose.yaml -f docker-compose.dev.yaml`)
- Worker env: `DOCKER_HOST=tcp://docker-proxy:2375` (set by `docker-compose.yaml`)
- Worker env: `AGENT_RUNTIME_MODE=docker`
- `docker-proxy` service (`tecnativa/docker-socket-proxy`) listens on port `2375` inside the compose network

## Affected Code

`apps/worker/src/agents/docker-agent-manager.ts` — constructor, `dockerApiBase` derivation.

## Fix

Replace the URL normalization logic to handle both `tcp://` and bare-host forms:

```ts
const rawHost = _config.dockerHost;
this.dockerApiBase = rawHost.startsWith('http')
  ? rawHost
  : rawHost.startsWith('tcp://')
    ? rawHost.replace(/^tcp:\/\//, 'http://')
    : `http://${rawHost}`;
```

Alternatively, change the compose `DOCKER_HOST` value to use the `http://` scheme directly:

```yaml
DOCKER_HOST: http://docker-proxy:2375
```

The Docker socket proxy accepts HTTP requests on port 2375 regardless of scheme label; `http://` is the correct form for a plain TCP proxy endpoint.

## Verification

After applying either fix:

1. `docker logs herobids-worker-1` should show no `fetch failed: getaddrinfo ENOTFOUND tcp` errors.
2. Starting the agent triggers container creation: `docker ps --filter "label=herobids.role=agent"` shows `herobids-agent-<id>`.
3. Redis key `agent:inbound:<id>` is created and `XINFO GROUPS` returns the `agent-broker` consumer group.
4. `agent_runtime_sessions.last_heartbeat_at` begins advancing.
5. Agent status transitions to `active`.

## Files Changed

- `apps/worker/src/agents/docker-agent-manager.ts` (constructor URL normalization), or
- `docker-compose.yaml` (`worker` service `DOCKER_HOST` env var)
