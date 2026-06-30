# Bug Report: Evaluation Trigger Returns 404 When No Stopped Session Exists

- **Status:** SUPERSEDED by 003-evaluation-scope-resolution-400-instead-of-404.md
- **Severity:** High
- **Date:** 2026-06-30
- **Summary:** Clicking "Run Evaluation" on a running agent with no prior stopped sessions returns a generic "Could not run evaluation" error. The root cause is that `resolveScope` only looked for `status = 'stopped'` sessions, and the frontend hid the specific error message.
- **Root Cause:**
  1. `packages/db/src/agent-evaluation-repository.ts` — `resolveScope()` only searched for sessions with `status = 'stopped'`. A running agent with no completed sessions would throw `"No completed session found for agent ..."`.
  2. `apps/api/src/routes/agent-evaluations.ts` — The API returned HTTP 404 for a scope resolution failure, which is misleading (the agent and endpoint both exist; it's a validation issue).
  3. `apps/web/src/features/agents/AgentEvaluations.tsx` — The frontend displayed the generic i18n key `agents.evaluations.triggerError` ("Could not run evaluation") for any non-409 error, hiding the actual reason.
- **Fix:**
  1. **`packages/db/src/agent-evaluation-repository.ts`**: Updated `resolveScope()` to prefer stopped sessions but fall back to the currently running session if no stopped session exists. Error message updated to guide the user: `"No session found for agent {id}. Start the agent to create a session first."`
  2. **`apps/api/src/routes/agent-evaluations.ts`**: Changed scope resolution failure HTTP status from 404 to 400 (validation error, not resource not found).
  3. **`apps/web/src/features/agents/AgentEvaluations.tsx`**: Updated the error display to show the API's actual `ApiError.message` when available, falling back to the generic message only when the error is not an `ApiError` or has no message.
- **Files Changed:**
  - `packages/db/src/agent-evaluation-repository.ts`
  - `apps/api/src/routes/agent-evaluations.ts`
  - `apps/web/src/features/agents/AgentEvaluations.tsx`
- **Verification:**
  - `pnpm lint` (tsc --noEmit) passes cleanly.
  - The fix ensures that clicking "Run Evaluation" on a running agent with no stopped sessions will now evaluate the currently running session.
  - If no session exists at all, the user will see a clear message: "No session found for agent {id}. Start the agent to create a session first."
  - API returns 400 (not 404) for scope resolution failures, which is semantically correct.
