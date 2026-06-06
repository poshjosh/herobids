- **Status:** CLOSED — superseded by bug #22 (root cause was LLM vars not forwarded + provider inferred from model name)
- **Severity:** High
- **Date:** 2026-06-06
- **Summary:** The agent container starts and heartbeats successfully, but its first (and every subsequent) LLM call fails immediately with `provider.no_credentials` because `LLM_API_KEY_ANTHROPIC` (and fallback `LLM_API_KEY`) are not set in the worker container's environment and are therefore not forwarded to the spawned agent container.

## Symptoms (from agent container log)

```
Agent runtime starting   model=claude-sonnet-4-5
Redis connected
Agent tick starting   tickCount=1
LLM call failed   code=provider.no_credentials
  message="No API key found for provider \"anthropic\""
  retryable=false
```

Heartbeat transitions: `starting → ready → busy → degraded → ready`

The agent then idles in `ready` state, sending heartbeats every 5 s, but never reasoning. The next tick fires at the default 15-minute interval (`TICK_INTERVAL_MS=900000`), at which point it will fail again for the same reason.

## Root Cause

`DockerAgentManager.start()` forwards LLM API key env vars from the worker process to the agent container:

```ts
// apps/worker/src/agents/docker-agent-manager.ts
...(process.env['LLM_API_KEY'] ? [`LLM_API_KEY=${process.env['LLM_API_KEY']}`] : []),
...(process.env['LLM_API_KEY_ANTHROPIC'] ? [`LLM_API_KEY_ANTHROPIC=${process.env['LLM_API_KEY_ANTHROPIC']}`] : []),
```

Neither `LLM_API_KEY` nor `LLM_API_KEY_ANTHROPIC` is declared in the `worker` service's `environment` block in `docker-compose.yaml`. No `.env` file populates them either. Therefore both are `undefined` in the worker process, neither conditional is truthy, and the agent container starts with no API key.

Inside the agent container, `packages/llm/src/llm-provider.ts` resolves:

```ts
const envKey = `LLM_API_KEY_${provider.toUpperCase()}`;  // LLM_API_KEY_ANTHROPIC
return process.env[envKey] ?? process.env['LLM_API_KEY'];
// → undefined → no-credentials error (retryable: false)
```

## Fix

### Option A — `.env` file (recommended for local dev)

Create or update `.env` in the project root (already gitignored):

```env
LLM_API_KEY_ANTHROPIC=sk-ant-api03-...
```

Docker Compose automatically loads `.env` from the project root. The worker service will inherit the variable and forward it to the agent container on the next start.

### Option B — shell environment

```bash
export LLM_API_KEY_ANTHROPIC=sk-ant-api03-...
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d worker
```

After setting the key, recreate the worker and restart the agent from the UI:

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d worker
```

The in-flight agent container must also be recreated (it was spawned without the key). Stop the agent from the UI, then start it again — the worker will create a new container with the key present.

## Files Changed

None (operational fix — env var must be supplied by the operator).

## Verification

1. `docker exec herobids-agent-<id> env | grep LLM_API_KEY` should show the key.
2. Agent container log should progress past `Agent tick starting` without `LLM call failed`.
3. Heartbeat transitions: `ready → busy → ready` (successful tick, no `degraded`).
4. `agent:outbound` Redis stream grows with agent-authored messages.
5. Agent status remains `active`; session `last_heartbeat_at` continues advancing.
