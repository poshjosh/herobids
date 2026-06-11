# 007 — Drizzle `notInArray` rejects `readonly` tuple

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-11
- **Summary:** `tsc --build` for `@herobids/api` failed with TS2769 because `SUPPRESSED_PROTOCOL_MESSAGE_TYPES` (declared `as const`) was passed directly to Drizzle's `notInArray()`, which requires a mutable `unknown[]`.

## Root Cause

`SUPPRESSED_PROTOCOL_MESSAGE_TYPES` is exported from `agent-activity-mapper.ts` as:

```ts
export const SUPPRESSED_PROTOCOL_MESSAGE_TYPES = [
  'agent.heartbeat',
  'agent.runtime.heartbeat',
] as const;
```

`as const` makes the array a `readonly` tuple. Drizzle's `notInArray(column, values)` overloads accept `SQLWrapper | unknown[]` — **not** `readonly unknown[]`. TypeScript's strict mode rejects the assignment because a `readonly` array is not assignable to a mutable array.

## Fix

Spread the constant into a fresh mutable array at every `notInArray` call site:

```ts
// before
notInArray(agentMessages.type, SUPPRESSED_PROTOCOL_MESSAGE_TYPES)

// after
notInArray(agentMessages.type, [...SUPPRESSED_PROTOCOL_MESSAGE_TYPES])
```

## Files Changed

- `apps/api/src/routes/agents.ts` — lines 636, 641
- `apps/api/src/routes/dashboard.ts` — line 330

## Verification

`pnpm --filter @herobids/api run build` completes with exit code 0 after the fix.

## Notes

The `as const` declaration in `agent-activity-mapper.ts` should be kept — it ensures the array is treated as a literal union type elsewhere (e.g. `isSuppressedProtocolMessageType`). The spread at call sites is the correct fix rather than removing `as const`.
