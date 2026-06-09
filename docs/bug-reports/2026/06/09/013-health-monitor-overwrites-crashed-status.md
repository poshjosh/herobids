# 013 — Health monitor overwrites "crashed" agent status with "stopped"

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** After an agent container crashed unexpectedly, the `AgentHealthMonitor` cleanup loop called `runtimeLauncher.stop(sessionId)` which (in docker mode) called `dockerManager.stop(agentId)` which set `agents.status = 'stopped'`, overwriting the `'crashed'` status that `onContainerDie` had already written.
- **Root Cause:** `AgentHealthMonitor.checkHealth()` used `runtimeLauncher.stop()` to clean up in-memory handles for sessions that were no longer active in the DB. The intent was only to remove the in-memory state, but `stop()` in docker mode also writes `status='stopped'` to the DB — overwriting the `'crashed'` status written moments earlier by `onContainerDie`.
- **Fix:**
  1. Added `removeHandle(sessionId)` method to `AgentRuntimeLauncher` that clears the in-memory handle and heartbeat timer without touching Docker or the DB.
  2. Changed the health monitor's cleanup loop to call `removeHandle` instead of `stop`, so a crashed agent's DB status is preserved.
- **Files Changed:**
  - `apps/worker/src/agents/agent-runtime-launcher.ts`
  - `apps/worker/src/agents/agent-health-monitor.ts`
- **Verification:** `pnpm lint` passes. After rebuild + restart, crashed agent shows `status='crashed'` in DB and the crashed banner renders on the agent detail page (UAT AG-10).
