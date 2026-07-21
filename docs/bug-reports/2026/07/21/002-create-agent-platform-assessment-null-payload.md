# Bug Report: Agent creation always fails — `platformAssessment: null` sent on every create request

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-07-21
- **Summary:** `buildCreateAgentPayload()` unconditionally sent `platformAssessment: null` on every agent-creation request; `CreateAgentSchema` only accepts an object or `undefined` (no `.nullable()`), so every UI-driven agent creation was rejected by the API with a Zod validation error, blocking all new agent creation.

## Root Cause

`buildCreateAgentPayload()` (`apps/web/src/features/agents/agent-payloads.ts`) included:

```ts
platformAssessment: buildPlatformAssessmentPayload(input.platformAssessmentEnabled, input.platformAssessmentReviewIntervalHours),
```

as an unconditional object property, unlike every other optional field in the same function, which is spread in conditionally (e.g. `...(input.costPreset ? { costPreset: input.costPreset } : {})`). `buildPlatformAssessmentPayload()` returns `null` whenever `platformAssessmentEnabled` is falsy — the default for every agent that doesn't opt into platform preset assessment.

`CreateAgentSchema` in `apps/api/src/routes/agents.ts` declares:

```ts
platformAssessment: z.object({
  enabled: z.boolean().optional(),
  reviewIntervalMs: z.number().int().positive().optional(),
}).optional(),
```

— `.optional()` only, no `.nullable()` (unlike `UpdateAgentSchema`'s equivalent field, which is correctly `.nullable().optional()` since updates need to be able to explicitly clear the setting). Create has nothing to "clear," so the API never expected `null` there.

Every UI-driven agent creation therefore sent a payload the API rejected with `"Expected object, received null"` on the `platformAssessment` field, surfaced to the user as a generic form error and no navigation to the agent detail page — observed as Playwright `page.waitForURL` timeouts in `createAgent()` across 4 E2E specs (Journeys 1, 4, 13, 16).

## Fix

Compute `buildPlatformAssessmentPayload(...)` once and spread it into the payload only when non-null, matching the established pattern used by every other optional field in `buildCreateAgentPayload()`:

```ts
const platformAssessment = buildPlatformAssessmentPayload(input.platformAssessmentEnabled, input.platformAssessmentReviewIntervalHours);
// ...
...(platformAssessment ? { platformAssessment } : {}),
```

Updated the function's return-type annotation for `platformAssessment` from `{ enabled?: boolean; reviewIntervalMs?: number } | null` to `{ enabled?: boolean; reviewIntervalMs?: number }` (create payloads never send `null` for this field — only present-with-object or absent).

`buildUpdateAgentPayload()` is unaffected — its `platformAssessment` field is intentionally `| null` (an explicit update semantic) and the corresponding `UpdateAgentSchema` already accepts `.nullable()`.

## Files Changed

- `apps/web/src/features/agents/agent-payloads.ts` — `buildCreateAgentPayload()` now omits `platformAssessment` instead of sending `null`.
- `apps/web/src/features/agents/agent-payloads.test.ts` — added 4 regression tests (`buildCreateAgentPayload — platformAssessment` describe block) covering: omitted when disabled/unset, omitted when explicitly `false`, included as an object when enabled with a review interval, included without `reviewIntervalMs` when hours is unset.

## Verification

- `pnpm --filter @herobids/web exec vitest run src/features/agents/agent-payloads.test.ts` — 41/41 pass (including the 4 new regression tests).
- `pnpm lint` passes.
- Root cause directly explains all 4 E2E failures reported (Journeys 1, 4, 13, 16 — every spec calling the shared `createAgent()` helper without enabling platform assessment). Re-running the full E2E suite is the remaining verification step.
