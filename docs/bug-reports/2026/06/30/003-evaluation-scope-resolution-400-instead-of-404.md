# Bug Report: Evaluation Scope Resolution Returns 400 Instead of 404 When Agent Has No Sessions

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-30
- **Summary:** `POST /agents/:id/evaluations` with `latestSession` scope returns HTTP 400 (`scope_resolution_failed`) when the agent has no completed sessions. The test expects HTTP 404 since the requested resource (a completed session) does not exist — the request itself is well-formed.
- **Root Cause:**
  1. `packages/db/src/agent-evaluation-repository.ts` — `resolveScope()` throws a generic `Error` when no stopped session exists for `latestSession` scope.
  2. `apps/api/src/routes/agent-evaluations.ts` — The catch block returns HTTP 400 for ALL scope resolution errors, even when the underlying cause is simply that no session exists (a "not found" condition, not a malformed request).
  3. Bug report `002-evaluation-trigger-404-no-stopped-session.md` previously changed the status from 404 to 400 as a "fix", but this was semantically wrong: the endpoint and agent both exist; only the evaluation target (a stopped session) is missing. The test script correctly expected 404.
- **Fix:**
  1. **`packages/db/src/agent-evaluation-repository.ts`**: Introduced `NoSessionForScopeError` (extends `Error`) thrown specifically when no session exists. Exported it from `packages/db/src/index.ts`.
  2. **`apps/api/src/routes/agent-evaluations.ts`**: Updated the scope resolution catch block to check `instanceof NoSessionForScopeError` and return HTTP 404 (`no_session_found`) for that case. Generic errors still return HTTP 400 for true validation failures.
  3. **`apps/api/src/routes/agent-evaluations.test.ts`**: Added a test case for `NoSessionForScopeError` → HTTP 404, and renamed the existing test to clarify it covers generic errors → HTTP 400.
- **Files Changed:**
  - `packages/db/src/agent-evaluation-repository.ts`
  - `packages/db/src/index.ts`
  - `apps/api/src/routes/agent-evaluations.ts`
  - `apps/api/src/routes/agent-evaluations.test.ts`
- **Verification:**
  - `pnpm lint` (tsc --noEmit) passes.
  - `pnpm vitest run packages/db/src/agent-evaluation-repository.test.ts` — 8/8 pass.
  - `pnpm vitest run apps/api/src/routes/agent-evaluations.test.ts` — 3/3 pass.
  - The fix resolves both shell test failures: `latestSession on agent with no sessions` (now 404) and `Non-trading agent evaluation` (now 404).
