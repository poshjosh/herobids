# Bug Report 002 — AI Model Validation Blocks Operator's Own Provider

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-10
- **Summary:** `PATCH /settings/ai-model` returned 400 when selecting the operator's own provider (`openai`) because `validateAiModelSelection` checked if the provider was in `getAvailableProviders()`, which only returns providers with explicit `LLM_API_KEY_<PROVIDER>` env vars. In test environments without per-provider keys set, the operator's provider was excluded.

## Root Cause

`getAvailableProviders(operatorProvider)` only included a provider if `resolveApiKey(provider)` returned a value (i.e., `LLM_API_KEY_OPENAI` or `LLM_API_KEY` env var was set). In the functional test environment neither was set, so `openai` (the operator provider) was not in the available list. The validation therefore rejected `openai` as a valid selection.

## Fix

Changed `validateAiModelSelection` in `llm-model-catalog.ts` to skip the provider availability check when the selected provider equals the operator provider. The 503 check in AI routes still uses `getAvailableProviders()` correctly (no change).

## Files Changed

- `apps/api/src/llm-model-catalog.ts`

## Verification

`PATCH /settings/ai-model` with `provider: 'openai'` returns 200; "503 when no provider configured" tests still pass when run without LLM API keys in the environment.
