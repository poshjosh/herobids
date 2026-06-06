- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-06
- **Summary:** Two compounding bugs caused the agent to always call Anthropic's native API directly instead of OpenRouter, and fail with `provider.no_credentials` even when `LLM_PROVIDER=openrouter` and all API keys were set in `.env`.

## Symptoms (from agent container log)

```
Agent tick starting   tickCount=1
LLM call failed   code=provider.no_credentials
  message="No API key found for provider \"anthropic\""
  retryable=false
```

This occurred even with `LLM_PROVIDER=openrouter` and `LLM_API_KEY_OPENROUTER` set in `.env`.

## Root Cause

Two bugs compounded:

### Bug 1 — LLM vars not injected into the worker container

Docker Compose loads `.env` for YAML variable substitution (`${VAR}`) but does **not** automatically inject `.env` values into container processes. A variable must appear in the service's `environment:` block (or `env_file:`) to be present inside the container.

`docker-compose.yaml` declared no `LLM_*` entries in the `worker` service's `environment:` block. Therefore the worker process had no `LLM_PROVIDER`, `LLM_MODEL`, or any `LLM_API_KEY_*` set, regardless of what was in `.env`.

`DockerAgentManager.start()` conditionally forwards each key:

```ts
...(process.env['LLM_PROVIDER'] ? [`LLM_PROVIDER=${process.env['LLM_PROVIDER']}`] : []),
...(process.env['LLM_API_KEY_OPENROUTER'] ? [`LLM_API_KEY_OPENROUTER=...`] : []),
```

Since all env vars were `undefined`, none were forwarded. The agent container started with no LLM configuration.

### Bug 2 — Provider inferred from model name, ignoring `LLM_PROVIDER`

`apps/worker/src/agent.ts` contained:

```ts
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? (LLM_MODEL.startsWith('claude') ? 'anthropic' : 'openai');
```

When `LLM_PROVIDER` was absent from the container (due to Bug 1), the fallback inferred the provider from the model name. The default model is `claude-sonnet-4-5`, which starts with `claude`, so `LLM_PROVIDER` was silently forced to `'anthropic'`.

This routed to `callAnthropicProvider()` — the native Anthropic API path — which requires `LLM_API_KEY_ANTHROPIC`. That key was also absent, producing the `provider.no_credentials` error.

The inference was wrong: OpenRouter (and other proxies) support Claude models via an OpenAI-compatible endpoint. The model name is not a reliable indicator of the provider.

## Fix

### `docker-compose.yaml` — forward LLM vars from `.env` into the worker container

```yaml
AGENT_RUNTIME_MODE: docker
# LLM configuration — values come from .env (or host environment)
LLM_PROVIDER: ${LLM_PROVIDER:-}
LLM_MODEL: ${LLM_MODEL:-}
LLM_BASE_URL: ${LLM_BASE_URL:-}
LLM_API_KEY: ${LLM_API_KEY:-}
LLM_API_KEY_ANTHROPIC: ${LLM_API_KEY_ANTHROPIC:-}
LLM_API_KEY_OPENROUTER: ${LLM_API_KEY_OPENROUTER:-}
LLM_API_KEY_OPENAI: ${LLM_API_KEY_OPENAI:-}
```

The `:-` syntax makes each var optional — if absent from `.env` or host, the container receives an empty string, which is falsy and correctly skipped by `DockerAgentManager`'s conditional forwarding.

### `apps/worker/src/agent.ts` — remove model-name-based provider inference

```ts
// Before
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? (LLM_MODEL.startsWith('claude') ? 'anthropic' : 'openai');

// After
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? 'openai';
```

The default is now `'openai'`, which is the correct choice: the OpenAI-compatible path works for OpenRouter, local proxies, and OpenAI itself. Native Anthropic must be opted into explicitly via `LLM_PROVIDER=anthropic`.

## Files Changed

- `docker-compose.yaml` — added LLM env var passthrough block to `worker` service
- `apps/worker/src/agent.ts` — removed `startsWith('claude')` provider inference

## Verification

1. Rebuild worker: `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d --build worker`
2. `docker exec herobids-worker-1 env | grep LLM_` should show all keys from `.env`
3. Start the agent — agent container should show the correct vars: `docker exec herobids-agent-<id> env | grep LLM_`
4. Agent container log should progress past tick start without `LLM call failed`
5. Heartbeat transitions: `ready → busy → ready` (no `degraded`)
