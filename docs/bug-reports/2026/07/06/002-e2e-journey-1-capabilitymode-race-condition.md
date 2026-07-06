# Bug Report: 002-e2e-journey-1-capabilitymode-race-condition.md

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-06
- **Summary:** E2E Journey 1 times out after clicking "Create AI agent" — agent creation silently fails due to capabilityMode race condition sending empty prompt to API.

## Root Cause

A race condition in `AgentsPage.tsx` caused agent creation to fail silently:

1. The `IntentState` initial value sets `capabilityMode: 'technical'`.
2. A `useEffect` derives the correct `capabilityMode` from skill selection and `technicalPreFilterEnabled` — either `'both'` (when trading skills are selected and technical filter is enabled) or `'intelligence'` (otherwise). The value `'technical'` is **never a valid steady state**.
3. When the E2E test selects a non-trading preset (`'general'` → `'custom'` with no skills), the effect should update `capabilityMode` from `'technical'` to `'intelligence'`. But the effect runs asynchronously after render.
4. If the user clicks "Review →" and "Create AI agent" before the effect commits, the form payload sends `prompt: ''` (because `includeIntelligence = false` when `capabilityMode === 'technical'`) and no `technical` config.
5. The API rejects with: "prompt is required when no technical config is provided" (Zod `superRefine` in CreateAgentSchema).
6. The mutation had **no `onError` handler**, so the form stayed on the review step indefinitely with no user feedback. The E2E test timed out waiting for navigation.

## Fix

1. **Root cause fix**: Changed `capabilityMode` initial state from `'technical'` to `'intelligence'` in `AgentsPage.tsx`. Since the useEffect only ever derives `'both'` or `'intelligence'`, `'technical'` was always a transient invalid state. The effect still updates to `'both'` when trading skills are selected with technical pre-filter enabled.

2. **Error handling**: Added `onError` handler to the `useMutation` call to surface API errors to the user via the form's error state.

3. **Test resilience**: Added a `page.waitForTimeout(300)` in the E2E helper `createAgent()` after preset/skill changes, giving React effects time to commit before form submission.

## Files Changed

- `apps/web/src/features/agents/AgentsPage.tsx` — Changed initial `capabilityMode` from `'technical'` to `'intelligence'`; added `onError` handler to mutation
- `tests/e2e/helpers.ts` — Added `waitForTimeout(300)` after preset/skill changes in `createAgent()`

## Verification

- `scripts/shell/tests/run-all-tests.sh --e2e`: E2E Journey 1 passes (780ms). Agent evaluation smoke test also passes.
- `pnpm lint`: No type errors.
