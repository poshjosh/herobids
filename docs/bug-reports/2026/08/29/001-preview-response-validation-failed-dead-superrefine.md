# Bug Report: "Preview response validation failed" when using marketplace agents

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-29
- **Environment:** local development (docker compose)

## Summary

Clicking "Use this agent" on any intelligence-mode agent in the marketplace returns a 500 error: "Preview response validation failed". The bug affects all agents with `capabilityMode: 'intelligence'` that lack an explicit `intelligence` or `technical` block in their blueprint revision payload.

## Observed Behavior

1. User opens the Agents page, clicks the Marketplace tab.
2. Two published blueprints appear (`skills-sh-tester`, `tintel`).
3. Clicking the copy/use icon on either triggers `POST /blueprints/:id/instantiate/preview`.
4. The API returns HTTP 500:

```json
{
  "error": "internal_error",
  "message": "Preview response validation failed",
  "details": [
    {
      "code": "custom",
      "message": "At least one of \"technical\" or \"intelligence\" must be configured",
      "path": ["rawPayload"]
    }
  ]
}
```

## Root Cause

The `agentSuperRefine` function (shared by `BlueprintRevisionPayloadSchema` and `UnifiedAgentConfigSchema`) enforces an invariant that at least one of `technical` or `intelligence` must be present:

```ts
if (!data.technical && !data.intelligence) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'At least one of "technical" or "intelligence" must be configured',
  });
}
```

This invariant is incorrect. Intelligence-mode agents do not require an `intelligence` config block to function. The `IntelligenceConfigSchema` contains only optional model overrides (`provider`, `lightModel`, `heavyModel`, `maxTokens`, `wakeIntervalMs`). Intelligence agents are driven by their prompt, model policy, and skills — none of which live in the `intelligence` block.

The chain that produces the invalid payload:

1. `resolveUnifiedConfig()` in `agent-create-normalization.ts` never stamps an `intelligence` key onto `unifiedConfig` — it only handles `technical`, `capabilityMode`, etc.
2. `projectAgentToBlueprintPayload()` reads `intelligence` from `agent.unifiedConfig` and gets `undefined`, which JSONB drops.
3. The stored `blueprint_revisions.payload` has neither `technical` nor `intelligence`.
4. The preview endpoint validates the response against `BlueprintInstantiatePreviewResponseSchema`, which includes `rawPayload: BlueprintRevisionPayloadSchema` with the `superRefine` — validation fails.

Verified against live DB: all 3 intelligence-mode agents (`tintel`, `skills-sh-tester`, `security-auditor`) have neither `technical` nor `intelligence` in their stored `unifiedConfig`, and they all run correctly at runtime.

The invariant is also redundant for `capabilityMode: 'hybrid'` — the more specific check ("technical is required when capabilityMode is hybrid") already covers that case.

## Fix

Remove the dead "at least one of technical or intelligence" check from:

1. `agentSuperRefine()` in `packages/domain/src/blueprint.ts`
2. `UnifiedAgentConfigSchema.superRefine()` in `packages/domain/src/config/schema.ts`

The remaining checks (hybrid requires technical, intelligence must not set hybridMode) are correct and stay.

## Files Changed

- `packages/domain/src/blueprint.ts` — remove dead invariant from `agentSuperRefine`
- `packages/domain/src/config/schema.ts` — remove dead invariant from `UnifiedAgentConfigSchema.superRefine`
- `packages/domain/src/config/schema.test.ts` — update affected tests

## Verification

- `pnpm lint` passes
- `pnpm test` passes (affected tests updated)
- `POST /blueprints/:id/instantiate/preview` returns 200 for both marketplace blueprints
