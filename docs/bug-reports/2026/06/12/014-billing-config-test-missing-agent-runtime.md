# 014 — `billing-config.test.ts` `baseConfig` missing `agentRuntime` causes schema validation failure

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-12
- **Summary:** The test "allows mock provider with no credentials" in `apps/api/src/billing/billing-config.test.ts` failed because `AppConfigSchema` now requires `agentRuntime` (with required `defaultBudgets` fields) but the test's `baseConfig` fixture did not include it.

## Root Cause

`AppConfigSchema` has `agentRuntime: AgentRuntimeConfigSchema` which requires a `defaultBudgets` object. After the schema was updated to make `agentRuntime` a required field (bug 009 — see `docs/bug-reports/2026/06/12/009-agent-runtime-schema-invalid-default.md`), the `baseConfig` in the billing cross-validation tests was not updated, causing all `AppConfigSchema.safeParse(...)` calls in that describe block to fail with `agentRuntime: Required`.

## Fix

Added `agentRuntime.defaultBudgets` with minimal valid values to the `baseConfig` fixture.

## Files Changed

- `apps/api/src/billing/billing-config.test.ts`

## Verification

All 12 billing config tests pass.
