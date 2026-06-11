- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-11
- **Summary:** `scripts/shell/run/build-and-run.sh` failed during `pnpm build` because agent route updates passed a database `executionMode` value typed as `string | null` into a helper that only accepted the stricter execution-mode union.

## Root Cause

The shared route helper `resolveExecutionModeForSkills` accepted `currentExecutionMode` as `'paper' | 'shadow' | 'live' | null | undefined`, but the database row shape exposed `agent.executionMode` as `string | null`. PATCH and PUT agent routes forwarded that DB value directly into the helper, so TypeScript rejected the call sites even though the runtime data was expected to be one of the same three values.

## Fix

Updated `apps/api/src/routes/agent-config-helpers.ts` to normalize execution-mode strings inside the helper boundary:

- the helper now accepts persisted `string | null` values for `currentExecutionMode`
- valid values are narrowed to the allowed execution-mode union
- unexpected persisted strings are treated as `null` instead of leaking an invalid mode into route update payloads

This keeps the call sites simple and makes the shared helper robust against the looser DB typing.

## Files Changed

- `apps/api/src/routes/agent-config-helpers.ts`
- `docs/bug-reports/2026/06/11/004-agent-execution-mode-type-mismatch.md`

## Verification

- `pnpm --filter @herobids/api build`
- `pnpm build`
- `pnpm lint`
- `scripts/shell/run/build-and-run.sh` completed successfully, including Docker image builds and `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d --build`