# 001 — Agent update fails "Expected number, received null" when slippage field is empty

- **Status:** FIXED
- **Severity:** MEDIUM
- **Date:** 2026-08-08
- **Discovered:** Manual UX session — copying agent "thyper" from marketplace, editing, and saving
- **Environment:** local Docker Compose stack
- **Component:** `apps/web/src/features/agents/agent-payloads.ts`, `packages/domain/src/config/schema.ts`, `packages/domain/src/blueprint.ts`

## Summary

Saving an agent update when the slippage (BPS) field was left empty resulted in a Zod validation error:

```
Expected number, received null
```

The error blocked any agent save where the user had not explicitly filled in the max slippage field, including agents freshly created via blueprint instantiation (marketplace "copy").

## Root cause

**Frontend:** `buildUpdateAgentPayload()` in `agent-payloads.ts` (line 336) explicitly set `executionDefaults.slippageBps = null` when the form field was empty:

```ts
if (input.maxSlippageBps) executionDefaults.slippageBps = parseInt(input.maxSlippageBps, 10);
else executionDefaults.slippageBps = null;  // BUG: null rejected by schema
```

**Backend:** `ExecutionDefaultsSchema` in `config/schema.ts` (line 2149) defined `slippageBps` as `.optional()` but NOT `.nullable()`:

```ts
slippageBps: z.number().min(0).optional(),  // rejects null
```

The `.nullable()` on the outer `executionDefaults` object only allowed the whole object to be `null`, not individual fields. The inner `slippageBps: null` failed validation.

Note: `buildCreateAgentPayload()` did NOT have this bug — it simply omitted the key when empty.

## Fix

### Primary — Frontend

Removed the `else` branch in `buildUpdateAgentPayload()` so `slippageBps` is simply omitted when the field is empty, matching the create-path behavior:

```ts
if (input.maxSlippageBps) executionDefaults.slippageBps = parseInt(input.maxSlippageBps, 10);
// Omit slippageBps when empty (rather than sending null)
```

### Defense-in-depth — Backend schemas

1. **`ExecutionDefaultsSchema.slippageBps`** (`config/schema.ts:2149`): changed to `.nullable().optional()` — matches the existing pattern in `RiskPostureSchema` where all number fields are nullable.

2. **`ExecutionPolicySchema.takeProfitPct`** (`blueprint.ts:37`): changed to `.nullable().optional()` — same pattern, same defense-in-depth rationale.

### Related audit

`BotsPage.tsx` (bot custom config) has a similar `else null` pattern for `stopLossPct` and `takeProfitPct`, but those are gated by frontend `required` field validation and feed into `MechanicalParamsSchema` (required, not optional), so they are lower risk. Deferred.

## Verification

- `pnpm lint` (TypeScript `--noEmit`) passes cleanly.
- All downstream consumers of `slippageBps` already handle `null` via `??` or `!= null` checks — no behavioral change.
