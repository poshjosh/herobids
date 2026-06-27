- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-27
- **Summary:** Worker Docker build fails with `Property 'providersYaml' does not exist on type 'AgentConfig'` — the agent container cannot build.
- **Root Cause:** The `AgentConfig` interface in `apps/worker/src/agent.ts` (defined locally) was missing the `providersYaml` property. The worker's `agent-session-manager.ts` correctly passes `providersYaml` inside the `AGENT_CONFIG` JSON env var (line 363-365), but the agent's local interface declaration never added it, causing `tsc` to reject the access at line 783 during Docker build.
- **Fix:**
  1. Added `type ProvidersYaml` to the `@herobids/domain` import in `apps/worker/src/agent.ts`.
  2. Added `providersYaml?: ProvidersYaml` to the `AgentConfig` interface.
  3. Removed the now-unnecessary inline `as import('@herobids/domain').ProvidersYaml | undefined` type assertion at line 783.
- **Files Changed:**
  - `apps/worker/src/agent.ts` — added `ProvidersYaml` import, added field to `AgentConfig`, cleaned up inline type assertion.
- **Verification:** `pnpm lint` (tsc --noEmit) passes clean with no errors.
