# 026 — Safe Ollama Model Discovery Via `/api/tags`

Enable Ollama as a first-class AI provider in the API catalog and settings UI by
discovering local models dynamically from the operator-configured Ollama base
URL. The implementation must be safe against bad URL assumptions, transient
local-runtime failures, and accidental probing of non-Ollama endpoints.

---

## Background

Today the stack has a split-brain LLM provider model:

- Runtime LLM calls already support local providers without an API key when
  `llm.baseUrl` is explicitly set.
- The API model catalog only considers providers "available" when it sees
  `LLM_API_KEY*` env vars.
- The shared provider registry does not yet treat `ollama` as a valid provider
  for model-selection purposes.
- The frontend disables the provider selector whenever `/ai/available-models`
  returns no providers, so the current API behavior makes the settings control
  look non-responsive.

This mismatch is most visible in local Docker development, where the operator
config already points `llm.provider` at `ollama` and `llm.baseUrl` at
`http://host.docker.internal:11434/v1`, but the catalog path still returns 503.

---

## Problem Statement

Ollama model discovery cannot be implemented safely by blindly calling
`/api/tags` against the raw `llm.baseUrl` string.

The current `llm.baseUrl` is defined as an OpenAI-compatible chat base, and for
Ollama it is typically configured with a trailing `/v1` path:

```yaml
llm:
  provider: ollama
  model: qwen3-coder:30b
  baseUrl: http://host.docker.internal:11434/v1
```

But Ollama model enumeration is a native endpoint at:

```text
GET /api/tags
```

That means discovery must:

- treat `llm.baseUrl` as a base URL that may end in `/v1`
- derive the native catalog endpoint from that base URL
- only do so when the provider is explicitly `ollama`
- avoid probing arbitrary non-Ollama endpoints just because a base URL exists

---

## Goals

### In scope

- Make `ollama` appear as an available provider when the operator config is
  explicitly set to `ollama` and the platform has a usable base URL.
- Discover Ollama models dynamically from `/api/tags`.
- Keep the existing frontend contract for `/ai/available-models` if possible so
  the current UI unblocks automatically.
- Preserve strict validation for user-selected provider/model combinations.
- Fail loudly in logs without degrading the API into a misleading
  "no provider configured" state when the provider is configured but discovery
  is temporarily unavailable.

### Out of scope

- Generic autodiscovery for all OpenAI-compatible providers.
- User-supplied discovery URLs.
- Background sync or persistent storage of discovered model catalogs.
- Reworking the frontend response contract unless the UI explicitly needs
  provider health metadata later.

---

## Safety Review

### 1. Gate discovery on explicit provider identity

The safest rule is:

- only call `/api/tags` when the operator-configured provider is `ollama`
- never infer Ollama from model names
- never infer Ollama from the presence of a base URL alone

This avoids SSRF-shaped behavior where the API starts probing arbitrary
OpenAI-compatible gateways or proxies with Ollama-native paths.

### 2. Normalize `llm.baseUrl` instead of concatenating strings

`llm.baseUrl` is currently an arbitrary string, not a URL-validated config
field. Discovery code must parse and normalize it before use.

Recommended normalization:

1. Parse the configured value with `new URL(...)`.
2. Reject non-`http:` and non-`https:` schemes.
3. Remove any trailing slash from the path.
4. If the path ends with `/v1`, strip exactly that terminal segment.
5. Preserve any path prefix before `/v1`.
6. Append `/api/tags`.
7. Drop query string and hash.

Examples:

- `http://host.docker.internal:11434/v1` → `http://host.docker.internal:11434/api/tags`
- `http://host.docker.internal:11434/v1/` → `http://host.docker.internal:11434/api/tags`
- `https://proxy.example.com/ollama/v1` → `https://proxy.example.com/ollama/api/tags`
- `http://localhost:11434` → `http://localhost:11434/api/tags`

Do not derive the catalog URL with string replacement alone.

### 3. Treat discovery as operator-configured I/O, not user-controlled I/O

The fetch target must come only from resolved operator config. No API request,
user preference, or agent payload may influence the discovery URL.

### 4. Discovery must not block the UI for full LLM timeout windows

The existing `llm.timeoutMs` is sized for generation requests, not settings-page
catalog fetches. A settings page hanging for 60 seconds on a dead local Ollama
instance is too expensive.

Discovery should use a short dedicated timeout and a short-lived in-memory cache.

### 5. Discovery failure should degrade to a safe fallback model set

If `ollama` is the operator provider and discovery fails, the API should still
consider the provider configured. Returning 503 is misleading in that case.

Safe fallback behavior:

- expose `ollama` as available
- return at least the operator-configured `llm.model`
- merge that configured model into the discovered set if discovery succeeds but
  does not include it
- log a warning when discovery fails or when configured and discovered model
  sets disagree

This keeps the UI usable, preserves the existing configured model, and avoids a
false "no provider configured" result.

### 6. Keep validation strict for dynamic models

The current shared validation is static-list based. For Ollama, model validity
must come from the discovered model set, not from a hard-coded array.

The safe approach is not to weaken validation globally. Instead:

- keep static validation for static providers
- add explicit dynamic-provider validation using the runtime-discovered catalog
  for `ollama`

---

## Recommended Design

## A. Introduce explicit provider catalog behavior metadata

Replace the current implicit "static list for every provider" assumption with an
explicit provider catalog mode.

Example domain shape:

```ts
type LlmProviderCatalogMode = 'static' | 'dynamic';

interface LlmProviderMetadata {
  catalogMode: LlmProviderCatalogMode;
  staticModels: string[];
}
```

Recommended provider metadata:

- `openai`, `anthropic`, `openrouter`, `together`, `fireworks`, `mistral`,
  `cohere`, `google`: `catalogMode = 'static'`
- `ollama`: `catalogMode = 'dynamic'`

This preserves zero-I/O domain knowledge while making `ollama` a known provider
without pretending its models are static.

## B. Add an API-local Ollama catalog client

Create a focused API helper, for example:

```text
apps/api/src/ollama-model-discovery.ts
```

Responsibilities:

- resolve the Ollama catalog URL from `llm.baseUrl`
- fetch `/api/tags` with a short timeout
- validate the response payload with Zod
- normalize model names into `string[]`
- dedupe and sort results
- cache results for a short TTL

Do not mix this logic into route handlers.

Suggested API:

```ts
interface OllamaDiscoveryResult {
  ok: true;
  models: string[];
  source: 'dynamic' | 'fallback';
} | {
  ok: false;
  error: {
    code: 'catalog.invalid_base_url' | 'catalog.timeout' | 'catalog.network_error' | 'catalog.invalid_response';
    message: string;
  };
}

async function discoverOllamaModels(config: {
  baseUrl?: string;
  configuredModel: string;
  timeoutMs: number;
  cacheTtlMs: number;
}): Promise<OllamaDiscoveryResult>
```

## C. Refactor the API catalog functions around resolved operator config

Current signatures are too narrow because they only accept `operatorProvider`.
The catalog logic needs both provider identity and base URL context.

Recommended direction:

```ts
interface OperatorLlmCatalogContext {
  provider: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
}
```

Refactor:

- `getAvailableProviders(...)` to accept the operator context
- `getProviderModels(...)` to become async and accept the operator context
- `validateAiModelSelection(...)` to accept optional discovered models for
  dynamic providers

## D. Keep `/ai/available-models` response shape stable

Preferred first implementation:

```json
{
  "providers": [
    {
      "provider": "ollama",
      "models": ["qwen3-coder:30b", "deepseek-r1:latest"]
    }
  ]
}
```

No frontend change is required if the route returns the same structure.

If discovery fails, return:

```json
{
  "providers": [
    {
      "provider": "ollama",
      "models": ["qwen3-coder:30b"]
    }
  ]
}
```

Optional later extension if the UI needs it:

- `source: 'dynamic' | 'fallback'`
- `warningCode?: string`

That metadata should be added only if there is a concrete UI requirement.

---

## Proposed Config Additions

Add dedicated catalog settings under `llm`:

```yaml
llm:
  catalogTimeoutMs: 3000
  catalogCacheTtlMs: 15000
```

Rationale:

- discovery timeout should be much shorter than generation timeout
- cache TTL should be short enough for local model changes to appear quickly
- these are operator-tunable timeouts/TTLs and therefore belong in config

These fields should live in:

- `packages/domain/src/config/schema.ts`
- `config/default.yaml`

No env overrides are needed initially unless an operational need appears.

---

## Implementation Plan

## Phase 1 — Shared provider metadata

- [ ] Add `ollama` to the known provider set in
      `packages/domain/src/models/llm-models.ts`.
- [ ] Introduce explicit provider metadata so `ollama` can be a known provider
      with dynamic catalog behavior rather than a fake static list.
- [ ] Refactor shared helpers so static providers still use compile-time model
      lists without change.

## Phase 2 — Operator config surface

- [ ] Add `llm.catalogTimeoutMs` and `llm.catalogCacheTtlMs` to
      `packages/domain/src/config/schema.ts` with sane defaults.
- [ ] Document both fields in `config/default.yaml`.
- [ ] Keep `llm.baseUrl` semantics unchanged: it remains the operator-configured
      chat base URL used by runtime calls.

## Phase 3 — Ollama discovery client

- [ ] Create `apps/api/src/ollama-model-discovery.ts`.
- [ ] Implement safe base URL normalization from chat base to catalog base.
- [ ] Implement `/api/tags` fetch with:
      - `AbortController`
      - short timeout
      - `redirect: 'error'`
      - Zod response validation
      - dedupe + sort normalization
- [ ] Add an in-memory TTL cache keyed by normalized catalog URL.
- [ ] Ensure the client never throws to callers; return structured results.

## Phase 4 — API catalog refactor

- [ ] Refactor `apps/api/src/llm-model-catalog.ts` to accept full operator LLM
      context instead of just `operatorProvider`.
- [ ] Make `getAvailableProviders(...)` treat operator `ollama` with a usable
      base URL as available even without API keys.
- [ ] Make `getProviderModels(...)` async so it can return dynamic Ollama models.
- [ ] Merge the operator-configured `llm.model` into the returned Ollama model
      set as a safety fallback.
- [ ] Preserve current behavior for static providers and API-key-gated hosted
      providers.

## Phase 5 — Selection validation

- [ ] Refactor API model-selection validation so `ollama` selections are
      validated against discovered models instead of a hard-coded static list.
- [ ] Keep static validation unchanged for non-dynamic providers.
- [ ] Ensure persisted existing selections do not disappear purely because local
      discovery is temporarily unavailable.

## Phase 6 — Route integration

- [ ] Update `apps/api/src/routes/ai.ts` so `/ai/available-models` awaits async
      provider model resolution.
- [ ] Remove the false 503 path for configured Ollama + temporary discovery
      failure.
- [ ] Keep 503 only for genuinely unconfigured AI platforms.

## Phase 7 — Test coverage

- [ ] Add unit tests for base URL normalization:
      - `/v1`
      - `/v1/`
      - no `/v1`
      - prefixed paths like `/ollama/v1`
- [ ] Add unit tests for discovery response normalization and invalid payloads.
- [ ] Add API route tests for:
      - `ollama` operator provider with base URL and no API key
      - successful `/api/tags` discovery
      - discovery timeout/network failure with fallback to configured model
      - non-Ollama providers preserving current behavior
- [ ] Add validation tests for dynamic Ollama model selection.

## Phase 8 — Documentation

- [ ] Update config comments to make it explicit that Dockerized local Ollama
      should use `http://host.docker.internal:11434/v1` rather than container
      localhost.
- [ ] Document that `/api/tags` discovery is Ollama-specific and not a generic
      OpenAI-compatible capability.

---

## File-Level Change Map

Expected primary touch points:

- `packages/domain/src/models/llm-models.ts`
- `packages/domain/src/config/schema.ts`
- `config/default.yaml`
- `config/development.yaml` (comment-only if needed)
- `apps/api/src/llm-model-catalog.ts`
- `apps/api/src/ollama-model-discovery.ts` (new)
- `apps/api/src/routes/ai.ts`
- `apps/api/src/routes/ai.test.ts`
- optional dedicated unit tests for the new discovery client

The frontend should not need code changes if the API response shape remains
stable.

---

## Risks And Mitigations

### Risk: probing the wrong endpoint

Mitigation:

- only run dynamic discovery for explicit `provider === 'ollama'`
- derive catalog URL through `URL` parsing and normalization
- reject invalid schemes and redirects

### Risk: local Ollama outages make the settings page unusable

Mitigation:

- short timeout
- short-lived cache
- fallback to configured model
- do not translate discovery outage into `no_ai_provider`

### Risk: weakening validation too far

Mitigation:

- preserve strict static validation for non-dynamic providers
- validate Ollama models against discovered catalog results
- keep operator-configured model as an explicit fallback, not an unrestricted
  wildcard

### Risk: UI stalls due to repeated network calls

Mitigation:

- in-memory TTL cache per API process
- short timeout
- route-level reuse when multiple providers are listed in one response

### Risk: model drift between API instances

Mitigation:

- accept per-process cache as sufficient for local dev and small deployments
- do not introduce Redis-backed catalog state unless drift becomes operationally
  relevant

---

## Validation Checklist

Implementation is complete when all of the following are true:

- [ ] With `llm.provider=ollama` and `llm.baseUrl=http://host.docker.internal:11434/v1`,
      `/ai/available-models` returns `ollama` without requiring any `LLM_API_KEY*`.
- [ ] The response includes pulled local models from `/api/tags`.
- [ ] If `/api/tags` is temporarily unavailable, the response still includes
      `ollama` and at least the configured `llm.model`.
- [ ] The settings page provider select becomes enabled.
- [ ] Selecting an Ollama model persists successfully when the model exists in
      the discovered or fallback set.
- [ ] Selecting a non-existent Ollama model is rejected with a clear validation
      error.
- [ ] Hosted providers retain their current behavior.
- [ ] `pnpm lint` passes.
- [ ] Narrow API tests covering Ollama discovery pass.

---

## Recommended Rollout Order

1. Land shared provider metadata and config additions.
2. Land the isolated discovery client with unit tests.
3. Refactor the API catalog route to use dynamic discovery and fallback.
4. Land validation updates.
5. Verify locally in Docker with a real Ollama instance and at least two pulled
   models.

This sequencing keeps the risky network behavior isolated and testable before it
changes settings-page behavior.
