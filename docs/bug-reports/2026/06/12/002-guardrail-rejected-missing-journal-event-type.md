# 002 — `'guardrail.rejected'` missing from `JournalEventType` union

**Date:** 2026-06-12  
**Severity:** High (blocks CI build)  
**Affected files:**
- `packages/engine/src/journal.ts`

## Symptoms

`pnpm build` failed with a TypeScript error in `apps/worker/src/agent.ts`:

```
Type '"guardrail.rejected"' is not assignable to type 'JournalEventType'
```

## Root Cause

A new guardrail rejection event was emitted in the agent runtime but the corresponding string literal `'guardrail.rejected'` was never added to the `JournalEventType` union in `packages/engine/src/journal.ts`.

## Fix Applied

Added `| 'guardrail.rejected'` to the `JournalEventType` union in `packages/engine/src/journal.ts`.
