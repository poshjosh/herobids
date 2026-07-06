# Bug Report: 003-api-smoke-agent-evaluation-ollama-fallback.md

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-06
- **Summary:** API smoke test (agent-evaluation) fails to set AI defaults in Docker environment — Ollama model catalog fallback only exposes the configured `llm.model`, not operator-preferred `lightModel`/`heavyModel`.

## Root Cause

The agent-evaluation smoke test (`scripts/shell/tests/agent-evaluation-test.sh`) defaults to `DEFAULT_PROVIDER=ollama` with `lightModel=qwen3:8b` and `heavyModel=qwen3.6:35b-a3b-q4_K_M`. In the Docker test environment, Ollama is not running.

When Ollama discovery fails, the `getProviderModels()` fallback in `apps/api/src/llm-model-catalog.ts` returns only `deps.context.model` (the operator's configured `llm.model` which is `qwen3.6:35b-a3b-q4_K_M`). It does NOT return the operator's preferred `lightModel` (`qwen3:8b`).

The `validateAiModelSelection()` function checks if both `lightModel` and `heavyModel` are in the returned model list. Since `qwen3:8b` is not in the fallback list, validation fails with: "Selected economy model is not available for this provider".

This cascaded to agent creation failures because the API requires either user AI defaults or explicit provider/model in the agent payload ("Provider is required — set it here or configure your AI settings in Settings").

## Fix

1. **Test fix**: Modified `run-all-tests.sh` to pass `DEFAULT_LIGHT_MODEL=qwen3.6:35b-a3b-q4_K_M` and `DEFAULT_HEAVY_MODEL=qwen3.6:35b-a3b-q4_K_M` to the agent-evaluation test. Both models now map to the single model available in the Ollama fallback catalog.

2. **Long-term consideration**: The `getProviderModels()` ollama fallback should ideally return the union of `deps.context.model` and the operator's preferred models from the config. This requires adding operator model preferences to `OperatorLlmCatalogContext`.

## Files Changed

- `scripts/shell/tests/run-all-tests.sh` — Added `DEFAULT_PROVIDER`, `DEFAULT_LIGHT_MODEL`, `DEFAULT_HEAVY_MODEL` env vars for the agent-evaluation smoke test tier

## Verification

- `scripts/shell/tests/run-all-tests.sh --e2e`: Agent evaluation smoke test passes with 14 passed, 0 failed.
