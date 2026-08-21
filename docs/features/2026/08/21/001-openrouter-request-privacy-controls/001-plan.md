# Plan: OpenRouter Request Privacy Controls

**Feature:** 000-openrouter-request-privacy-controls
**Date:** 2026-08-20
**Status:** Draft

## Summary

Add explicit OpenRouter request-side privacy controls to the shared LLM client so OpenAIdom does not rely only on account-level OpenRouter dashboard settings when routing prompts through the OpenRouter gateway.

This plan addresses implementation item No. 1 from the Google Limited Use follow-up:

- set OpenRouter `provider` controls like `data_collection: "deny"`, `zdr: true`, `only`, `order`, or `allow_fallbacks: false` in `packages/llm/src/llm-provider.ts`

Operator note: the account-level OpenRouter privacy setting (item No. 2) was already enabled outside the repo on 2026-08-20. This feature adds a second, application-level enforcement layer.

## Goals

- Add request-level OpenRouter privacy controls to the shared LLM path used by API and worker code.
- Enforce `data_collection: "deny"` and `zdr: true` for OpenRouter requests by default.
- Make the controls explicit, typed, and operator-configurable rather than hardcoded ad hoc in request assembly.
- Keep the initial rollout narrow enough to avoid unnecessary reliability regressions.
- Add tests that prove the OpenRouter request body includes the expected `provider` object only for OpenRouter calls.

## Non-Goals

- Reworking non-OpenRouter providers.
- Introducing a UI for configuring OpenRouter routing/privacy controls in this feature.
- Enforcing strict downstream provider allowlists (`only`) or deterministic routing (`order`) in v1.
- Disabling OpenRouter fallbacks by default.
- Changing Gmail scopes or Gmail tool behavior.

## Current State (verified in code)

### Shared LLM client

`packages/llm/src/llm-provider.ts` builds the OpenAI-compatible request body with:

- `model`
- `messages`
- `max_tokens`
- `temperature`
- optional `tools`
- optional `tool_choice`
- optional unified `reasoning`
- `cache_control: { type: 'ephemeral' }` for OpenRouter only

Today it does **not** send an OpenRouter `provider` object at all.

### Confirmed call sites

The shared `callLlmProvider()` path is used by both API and worker flows, including:

- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/ai.ts`
- `apps/worker/src/market-intelligence/assessor-factory.ts`
- agent/runtime call sites through the worker runtime

This means a single change in `packages/llm/src/llm-provider.ts` can cover most application LLM traffic.

### Confirmed configured OpenRouter-backed models

Current config shows OpenRouter is the live gateway in staging and production:

- `config/staging.yaml`
- `config/production.yaml`

Configured downstream models currently include:

- `deepseek/deepseek-v4-pro`
- `deepseek/deepseek-v4-flash`
- `anthropic/claude-fable-5`

### External OpenRouter capabilities relevant to this feature

OpenRouter supports request-level provider controls including:

- `data_collection`
- `zdr`
- `allow_fallbacks`
- `only`
- `order`
- `ignore`
- `require_parameters`

Those controls are not yet represented in the repo's LLM provider config types.

## Product/Architecture Decision

Implement OpenRouter privacy controls in two layers:

1. **Operator-configured defaults in repo config**
   - The resolved app config should be able to carry OpenRouter provider controls.
   - The shared LLM client should map those controls into OpenRouter request payloads.

2. **Safe v1 defaults**
   - `data_collection: "deny"`
   - `zdr: true`
   - do not set `only`, `order`, or `allow_fallbacks: false` by default

Rationale:

- `data_collection: "deny"` and `zdr: true` directly address the Google compliance concern.
- `only`, `order`, and `allow_fallbacks: false` are more operationally risky because they narrow OpenRouter routing and can reduce resilience or silently break particular model paths.
- The application should not rely solely on dashboard state for a compliance-sensitive guarantee when the request API supports explicit enforcement.

## Proposed Config Shape

Extend the shared LLM provider config with an OpenRouter-specific nested object.

Illustrative shape:

```ts
interface OpenRouterProviderControls {
  dataCollection?: 'allow' | 'deny';
  zdr?: boolean;
  allowFallbacks?: boolean;
  only?: string[];
  order?: string[];
}

interface LlmProviderConfig {
  provider: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  baseUrl?: string;
  providersBaseUrlMap?: Record<string, string>;
  thinking?: {
    lightBudgetTokens: number;
    deepBudgetTokens: number;
  };
  openRouterProviderControls?: OpenRouterProviderControls;
}
```

Wire format mapping for OpenRouter requests:

```json
{
  "provider": {
    "data_collection": "deny",
    "zdr": true,
    "allow_fallbacks": true,
    "only": ["..."],
    "order": ["..."]
  }
}
```

Only defined fields should be emitted.

## Detailed Plan

### 1. Add typed OpenRouter provider controls at the LLM boundary — DONE

Files:

- `packages/llm/src/llm-provider.ts`
- `packages/llm/src/index.ts`
- any affected shared tests

Changes:

- Introduce a new exported type for OpenRouter request controls.
- Extend `LlmProviderConfig` with an optional `openRouterProviderControls` field.
- Keep the field optional so non-OpenRouter providers and existing call sites remain source-compatible.

### 2. Add operator config support for OpenRouter request controls — DONE

Files:

- `packages/domain/src/config/schema.ts`
- any config exports/index files under `packages/domain/src/config/`
- `config/default.yaml`
- `apps/api/src/config.ts` and `apps/worker/src/config.ts` only if additional env/config mapping is needed
- config tests

Changes:

- Add a nested config block under the LLM config for OpenRouter controls.
- Provide safe defaults in operator config:

```yaml
llm:
  openRouterProviderControls:
    dataCollection: deny
    zdr: true
```

- Keep `allowFallbacks`, `only`, and `order` unset by default.
- Validate shape with Zod.
- Ensure config resolution still follows the repo rule: one resolved typed config object, no side-channel env reads in request assembly.

### 3. Thread the controls into all `callLlmProvider()` call sites — PENDING

Files:

- API call sites that construct `LlmProviderConfig`
- worker call sites that construct `LlmProviderConfig`
- any helper/factory functions that centralize LLM config

Likely touchpoints:

- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/ai.ts`
- `apps/worker/src/market-intelligence/assessor-factory.ts`
- worker runtime paths that build the agent LLM config

Changes:

- When building `LlmProviderConfig`, include `openRouterProviderControls` from resolved operator config.
- Avoid duplicating literals at call sites.
- Prefer one small shared helper if many call sites require the same mapping.

### 4. Emit OpenRouter `provider` controls in the request body — PENDING

Files:

- `packages/llm/src/llm-provider.ts`
- `packages/llm/src/llm-provider.test.ts`

Changes:

- In the OpenRouter branch of `callOpenAiCompatibleProvider()`, build `requestBody.provider` from `config.openRouterProviderControls`.
- Continue sending `cache_control` unchanged.
- Map camelCase config fields to the snake_case OpenRouter wire format:
  - `dataCollection` -> `data_collection`
  - `allowFallbacks` -> `allow_fallbacks`
- Emit nothing when no controls are set.
- Do not send the `provider` object for non-OpenRouter requests.

### 5. Test the new request-shape behavior — PENDING

Files:

- `packages/llm/src/llm-provider.test.ts`
- any config tests in domain/api/worker config suites

Add coverage for:

- OpenRouter request includes `provider.data_collection = "deny"` and `provider.zdr = true`.
- OpenRouter request omits undefined fields.
- Non-OpenRouter requests do not include a `provider` object from this feature.
- Existing OpenRouter `cache_control` behavior still works.
- Existing reasoning/tool-call behavior remains intact.

### 6. Document the operator-level semantics — PENDING

Files:

- `docs/best-practices/llm-providers.md`
- optionally `docs/best-practices/configuration.md` if that is the clearer home for the config snippet

Changes:

- Document that OpenRouter account-wide privacy settings remain recommended, but application requests also enforce their own privacy/routing controls.
- Document the initial supported fields and the default rollout stance:
  - enforce `dataCollection: deny`
  - enforce `zdr: true`
  - do not default `only`, `order`, or `allowFallbacks: false`

## Validation Plan

Run at minimum:

- focused unit tests for `packages/llm/src/llm-provider.test.ts`
- config/schema tests covering the new field
- `pnpm lint`

If available after implementation, add a targeted live smoke check against staging that confirms OpenRouter still accepts the configured DeepSeek and Anthropic-backed models with the new request body.

## Rollout Strategy

### Phase 1

Ship request-level:

- `data_collection: "deny"`
- `zdr: true`

with no request-level provider allowlist and fallbacks still enabled.

### Phase 2

After live verification, decide whether Google-facing documentation should also disclose any explicit allowlist of downstream OpenRouter providers.

### Phase 3 (optional hardening)

Only if needed, add support for tighter controls such as:

- `only`
- `order`
- `allow_fallbacks: false`

This phase should happen only after confirming which OpenRouter downstream endpoints fully support the required models, reasoning modes, and tool-calling paths.

## Risks

- Some OpenRouter-backed model/provider combinations may reject or narrow routing when `zdr: true` is enforced.
- Adding strict `only` or `order` too early could reduce availability and break fallback behavior.
- If controls are introduced as hardcoded request literals instead of typed config, later platform-owned LLM paths may drift.

## Open Questions

1. Should platform-owned non-Gmail LLM traffic also always inherit the same strict OpenRouter privacy controls, or should there be a dedicated stricter path only for Google Workspace-adjacent workloads?
2. Do we want a separate config block for Gmail-adjacent/Workspace-adjacent AI traffic later, or is one global OpenRouter privacy policy sufficient for now?
3. After staged validation, do we want to pin `only` to a smaller approved downstream provider list for the configured models?

## Recommended Implementation Order

1. Type + schema support.
2. Default config values.
3. Thread config into `LlmProviderConfig` construction.
4. Emit the OpenRouter `provider` object.
5. Add unit tests.
6. Run lint + targeted tests.
7. Validate configured staging/production models still work.
