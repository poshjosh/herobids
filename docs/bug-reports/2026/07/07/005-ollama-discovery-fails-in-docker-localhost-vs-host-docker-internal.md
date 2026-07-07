# 005 — Ollama model discovery fails in Docker: `qwen3:8b` rejected as unavailable

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** `agent-trade-test.sh` fails at agent creation with `400 {"error":"validation_error","details":[{"code":"custom","path":["lightModel"],"message":"Selected economy model is not available for this provider"}]}` when using `ollama` as the LLM provider with `lightModel: qwen3:8b`.

## Root Cause

`config/providers.yaml` set `ollama.baseUrl: http://localhost:11434/v1`. Inside Docker (where the API container runs), `localhost` resolves to the container itself — not the host — so the Ollama `/api/tags` discovery request fails.

`getProviderModels` prefers `providerConfig.baseUrl` (from `providers.yaml`) over `deps.context.baseUrl` (from `config/default.yaml`, which correctly uses `host.docker.internal`):

```typescript
const effectiveBaseUrl = providerConfig.baseUrl ?? deps.context.baseUrl;
```

When discovery fails, the code falls back to returning only `[deps.context.model]` (`qwen3.6:35b-a3b-q4_K_M`). The test sends `lightModel: qwen3:8b`, which is not in that single-model list → validation rejects it.

`config/default.yaml` already had the correct comment and URL:
```yaml
baseUrl: http://host.docker.internal:11434/v1  # Ollama: use host.docker.internal, NOT localhost inside Docker
```

But `providers.yaml` was never updated to match.

## Fix

Updated `config/providers.yaml` Ollama `baseUrl` from `http://localhost:11434/v1` to `http://host.docker.internal:11434/v1`.

`host.docker.internal` resolves to `127.0.0.1` on macOS even outside Docker containers (Docker Desktop provides this DNS entry), so it works in both native and containerised environments.

## Files Changed

- `config/providers.yaml`

## Verification

After rebuilding the API container, a `POST /agents` call with `provider: ollama`, `lightModel: qwen3:8b` no longer returns a `validation_error` — it proceeds to the admin permission check, confirming model discovery now succeeds.
