# 001 — Platform assessor LLM credential check blocks ollama (no API key required)

- **Status:** FIXED
- **Severity:** HIGH
- **Date:** 2026-08-26
- **Discovered:** During agent evaluation session (thyper `f8cf467a`, tintel `06e1bc73`). The `assess_strategy_preset` tool triggered two `market_assessment_runs` for SOL and ETH, both failed with `provider.no_credentials`. 98% of strategy preset reviews were blocked with outcome `blocked_by_no_credit_indication`.
- **Environment:** local (docker compose), development
- **Component:** `packages/llm/src/llm-provider.ts`

## Summary

The platform assessor's LLM call fails with `"No API key found for provider "ollama""` when the operator configures ollama as the platform assessor LLM provider. Ollama is a local provider that does not require an API key.

The credential guard in `callOpenAiCompatibleProvider()` checks `!apiKey && !config.baseUrl` before allowing a request. For ollama, `resolveApiKey('ollama')` correctly returns `undefined` (no `LLM_API_KEY_OLLAMA` env var). The issue is that `config.baseUrl` only reflects an explicit `baseUrl` on the specific `LlmProviderConfig` object — it does not consider the provider registry (`providersBaseUrlMap`) which already contains ollama's base URL from `providers.yaml`.

The resolved base URL is correctly computed on the line above the guard (`config.baseUrl ?? resolveBaseUrl(config.provider, config.providersBaseUrlMap)`), but the guard ignores it.

## Root Cause

In `packages/llm/src/llm-provider.ts`, `callOpenAiCompatibleProvider()`:

```typescript
const baseUrl = config.baseUrl ?? resolveBaseUrl(config.provider, config.providersBaseUrlMap);
const apiKey = resolveApiKey(config.provider);

// Local providers (e.g. Ollama) don't need an API key when baseUrl is explicitly set.
if (!apiKey && !config.baseUrl) {   // <-- BUG: only checks config.baseUrl, not resolved baseUrl
  return { ok: false, error: { code: 'provider.no_credentials', ... } };
}
```

Three conditions converge:

1. **`config.baseUrl` is undefined:** The platform assessor's `LlmProviderConfig` is built in `assessor-factory.ts` with `baseUrl: llmConfig?.baseUrl`. The operator config (`platformAssessor.llm`) does not set `baseUrl` (it's optional in the schema), relying on the provider registry to resolve it.
2. **`resolveApiKey('ollama')` returns undefined:** No `LLM_API_KEY_OLLAMA` env var — ollama doesn't need one.
3. **`providersBaseUrlMap` has ollama:** `providers.yaml` registers `ollama: { baseUrl: http://host.docker.internal:11434/v1 }`, so `resolveBaseUrl()` would return the correct URL. But the guard doesn't check this path.

The guard's existing comment says "Local providers don't need an API key when baseUrl is explicitly set" — but it only considers the narrowest definition of "explicitly set" (`config.baseUrl`), missing the provider registry which is equally explicit.

## Impact

- All `market_assessment_runs` triggered by agents using ollama as the platform LLM fail immediately.
- Strategy preset reviews degrade: 98% blocked with `blocked_by_no_credit_indication` (because the assessment that would provide credit indication fails).
- Agents in `hybrid`/`scanner_gated` mode with `platformAssessment.enabled: true` lose the ability to get LLM-ranked preset recommendations.
- Affects any deployment using ollama as the platform assessor provider — primarily development environments.

## Fix

Combined approach:

1. **Code fix (Option B):** In `callOpenAiCompatibleProvider()`, extend the credential guard to also trust the operator's provider registry. If the provider exists in `providersBaseUrlMap`, the operator has explicitly declared it available — skip the API key check.
2. **Config fix (Option A):** In `config/development.yaml`, add `baseUrl` to `platformAssessor.llm` as belt-and-suspenders for the dev environment. Not added to `default.yaml` because deep merge would leak the ollama URL into staging/production configs that use different providers.

### Code change

**File:** `packages/llm/src/llm-provider.ts`

```typescript
// Before:
if (!apiKey && !config.baseUrl) {

// After:
if (!apiKey && !config.baseUrl && !config.providersBaseUrlMap?.[config.provider]) {
```

### Config change

**File:** `config/development.yaml`

```yaml
platformAssessor:
  llm:
    baseUrl: http://host.docker.internal:11434/v1
```

## References

- Evaluation report: `.ignore/eval/2026/08/26/REPORT.md`
- Credential guard: `packages/llm/src/llm-provider.ts` → `callOpenAiCompatibleProvider()` line ~251
- Assessor factory: `apps/worker/src/market-intelligence/assessor-factory.ts` → `createPlatformAssessor()` line ~127
- Platform assessor LLM config schema: `packages/domain/src/config/schema.ts` → `PlatformAssessmentLlmConfigSchema`
- Provider registry: `config/providers.yaml`
- Failed assessment runs: `market_assessment_runs` table, IDs `31286513-...` and `c46d0abb-...`

## Resolution

**Fixed on:** 2026-08-26

### Changes

1. **`packages/llm/src/llm-provider.ts`** — Extended the credential guard in `callOpenAiCompatibleProvider()` to also trust the operator's provider registry. The condition now checks `providersBaseUrlMap` in addition to `config.baseUrl`, so any provider registered in `providers.yaml` passes without an API key:
   ```typescript
   // Before:
   if (!apiKey && !config.baseUrl) {
   // After:
   if (!apiKey && !config.baseUrl && !config.providersBaseUrlMap?.[config.provider]) {
   ```

2. **`config/development.yaml`** — Added explicit `baseUrl` under `platformAssessor.llm` as belt-and-suspenders for the dev environment. Not added to `default.yaml` to avoid deep-merge leaking the ollama URL into staging/production.
   ```yaml
   platformAssessor:
     llm:
       baseUrl: http://host.docker.internal:11434/v1
   ```

### Verification

- `pnpm lint` passes.
