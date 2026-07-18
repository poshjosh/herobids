# Bug Report: Partial Agent Technical Config PATCH Rejected

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-18
- **Summary:** The agent update API rejected valid partial `technical` PATCHes before it could preserve the persisted technical configuration.

## Root Cause

`UpdateAgentSchema` reused `TechnicalConfigSchema`, which requires `filters` and validates a complete technical block. Therefore a request such as `{ "technical": { "signalBias": "mean-reverting" } }` failed at request validation with `technical.filters` missing. The handler also replaced `unifiedConfig.technical` rather than merging a partial update with the existing technical configuration.

The API-level persistence script additionally used deprecated values (`1h`, `momentum`), expected `autonomousExit` to default to `true` rather than `false`, and treated defaultable indicators as required input.

## Fix

- Added an update-specific, top-level partial technical schema.
- Merged partial technical updates with the persisted technical block and parsed the merged value through `TechnicalConfigSchema` before persistence.
- Added a regression test that updates only `signalBias` and verifies existing filters and scan settings remain intact.
- Updated the persistence verifier to use canonical technical values and assert the actual API defaults.

## Files Changed

- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/agents.test.ts`
- `scripts/ts/agent-config-persistence-test.ts`

## Verification

- `pnpm lint` passed.
- `pnpm --filter @herobids/api exec vitest run src/routes/agents.test.ts` passed: 118 tests.
- Rebuilt the API service and ran `scripts/shell/tests/agent-config-persistence-test.sh`: 25/25 checks passed.
