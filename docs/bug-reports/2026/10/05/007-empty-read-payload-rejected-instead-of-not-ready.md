# Bug 007 — Unresolved venue account sent an empty read payload that the boundary rejects

- **Status:** FIXED (code; not yet deployed)
- **Severity:** Low
- **Date:** 2026-10-05
- **Summary:** When `selectedVenueAccountResolver` was absent or returned null, `get_account_summary` / `get_risk_limits` sent `{}` and Traderton returned `validation.invalid_payload` (`venueAccountId: Required`) instead of a clear "account not ready" result.

## Evidence

Signed call from the staging worker (subject = tintel): with `venueAccountId` → success (`capital: "1000"`); with `{}` → `validation.invalid_payload`. This was a manual probe, not what the failing agent hit (see 004/005).

## Root Cause

`riskSpecReadPayload` (`apps/worker/src/tools/risk-limits.ts`) degraded to `{}`, and comments in `account.ts` and `packages/domain/src/trading/tool-contract.ts` assumed Traderton degrades gracefully. Traderton's schema requires `venueAccountId`. `adjust_risk_limits` already returned `precondition.not_ready` in the same situation.

## Fix

- `risk-limits.ts`: replaced `riskSpecReadPayload` with `resolveSelectedVenueAccountId` (null when no resolver, no ready account, or the resolver throws) and `selectedAccountUnavailable()` (`precondition.not_ready`, `fault: false`). `get_risk_limits`, `get_account_summary` and `adjust_risk_limits` all use them, so the three tools now behave the same and the boundary is not called without an account.
- Removed the now-unused `buildRiskSpecPayloadFields` / `RiskSpecPayloadFields` from `apps/worker/src/agents/decision-boundary-mapping.ts`, along with their two tests.
- Updated the outdated comments in `account.ts` and `tool-contract.ts`.

`precondition.not_ready` is a content-level code, so it does not trip the tool circuit breaker.

## Files Changed

- `apps/worker/src/tools/risk-limits.ts`
- `apps/worker/src/tools/account.ts`
- `apps/worker/src/agents/decision-boundary-mapping.ts`
- `packages/domain/src/trading/tool-contract.ts`
- `apps/worker/src/tools/account.test.ts`, `apps/worker/src/tools/risk-limits.test.ts`, `apps/worker/src/agents/decision-boundary-mapping.test.ts`

## Verification

- Both read tools: tests for no resolver / null / throwing resolver, each returning `precondition.not_ready` without calling the boundary. Existing success and failure-mapping tests now run with a resolved account.
- `pnpm lint`, `pnpm build`, worker + domain suites (4150 passed) green.
