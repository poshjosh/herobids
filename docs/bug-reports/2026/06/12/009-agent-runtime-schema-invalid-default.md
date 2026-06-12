# 009 — AgentRuntimeConfigSchema invalid `.default({})` causes build failure

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-12
- **Summary:** `pnpm build` failed in `@herobids/domain` with a TypeScript overload mismatch on `AgentRuntimeConfigSchema.default({})`.

## Root Cause

`AgentRuntimeConfigSchema` contains a `defaultBudgets` sub-object whose fields (`maxHistoryMessages`, `maxRecentToolMessages`, `maxToolResultChars`, `maxVisibleToolSchemas`, `maxContextBlockChars`) have no `.default()` values — they are intentionally required and must be supplied via `config/default.yaml`.

At the top-level config schema (line 623 of `packages/domain/src/config/schema.ts`), the field was declared as:

```ts
agentRuntime: AgentRuntimeConfigSchema.default({}),
```

Zod's `.default({})` requires that `{}` be a valid input for the schema. Because `defaultBudgets` is required with no field defaults, `{}` does not satisfy the input type, producing:

```
TS2769: No overload matches this call.
  Argument of type '{}' is not assignable to parameter of type
  '{ defaultBudgets: { maxHistoryMessages: number; ... }; ... }'
```

The `defaultBudgets` fields were likely made required (removing their per-field `.default()`) in a prior commit without updating the `.default({})` call at the usage site.

## Fix

Removed `.default({})` from the `agentRuntime` field, making it a required field in the top-level schema. `config/default.yaml` always provides this block, so no runtime regression occurs. The existing test `'throws when agentRuntime.defaultBudgets is missing'` continues to pass.

```diff
- agentRuntime: AgentRuntimeConfigSchema.default({}),
+ agentRuntime: AgentRuntimeConfigSchema,
```

## Files Changed

- `packages/domain/src/config/schema.ts` — line 623

## Verification

`pnpm --filter @herobids/domain run build` exits 0 with no TypeScript errors.
