# 008 — Strategy: LlmResponse type not exported from llm-provider

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** `packages/strategy` build failed because `LlmResponse` was not re-exported from `./llm-provider.ts` but was used in `./llm.ts`.
- **Root Cause:** `packages/strategy/src/llm-provider.ts` re-exported `LlmProviderConfig` and `LlmResult` from `@herobids/llm` but omitted `LlmResponse`, which is required by `llm.ts` at line 5.
- **Fix:** Added `LlmResponse` to the re-export in `packages/strategy/src/llm-provider.ts`.
- **Files Changed:**
  - `packages/strategy/src/llm-provider.ts`
- **Verification:** `pnpm build` completes without errors.
