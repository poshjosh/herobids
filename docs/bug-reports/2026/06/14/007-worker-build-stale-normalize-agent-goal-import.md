# Bug Report: Worker Build Blocked By Stale normalizeAgentGoal Import

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** `scripts/shell/run/build-and-run.sh` failed at the `pnpm build` step because `apps/worker/src/runtime-composition.ts` imported `normalizeAgentGoal` without using it.

## Root Cause

`apps/worker/src/runtime-composition.ts` kept a stale value import for `normalizeAgentGoal` after the file stopped calling that helper. With `noUnusedLocals` enabled under the repo's strict TypeScript settings, the worker package build failed with `TS6133` and stopped the root build.

## Fix

Removed `normalizeAgentGoal` from the `@herobids/domain` import in `apps/worker/src/runtime-composition.ts`, leaving only the still-used `formatAgentGoalLiteralBlock` import.

## Files Changed

- `apps/worker/src/runtime-composition.ts`

## Verification

- `pnpm --filter @herobids/worker build`
- `pnpm lint`
- `pnpm exec vitest run apps/worker/src/runtime-composition.test.ts`
- `pnpm build`