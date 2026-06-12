# 011 — `AgentRuntimePolicySchema` missing `catalog` field causes schema tests to fail

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-12
- **Summary:** Two tests in `packages/domain/src/config/schema.test.ts` failed with `Cannot read properties of undefined (reading 'locality')` because the `AgentRuntimePolicySchema` override of `llm` did not include `catalog`.

## Root Cause

`AgentRuntimePolicySchema` extends `AgentRuntimeConfigSchema` and overrides the `llm` field. The override was:
```ts
llm: z.object({
  retry: LlmRetryConfigSchema.default({}),
  scout: LlmScoutConfigSchema.default({}),
  thinking: LlmThinkingConfigSchema.default({}),
}).default({}),
```
`LlmCatalogConfigSchema` (which includes `locality` with default `'auto'`) was omitted from the override, so `result.data.llm.catalog` was `undefined` at runtime.

## Fix

Added `catalog: LlmCatalogConfigSchema.default({})` to the `AgentRuntimePolicySchema` `llm` override.

```diff
  llm: z.object({
+   catalog: LlmCatalogConfigSchema.default({}),
    retry: LlmRetryConfigSchema.default({}),
    scout: LlmScoutConfigSchema.default({}),
    thinking: LlmThinkingConfigSchema.default({}),
  }).default({}),
```

## Files Changed

- `packages/domain/src/config/schema.ts`

## Verification

All `AgentRuntimePolicySchema` schema tests pass.
