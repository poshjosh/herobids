# AgentTradingActor reconciler not shadow/paper-aware

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** `AgentTradingActor.startReconciler()` runs venue-state reconciliation in shadow/paper mode, generating a false-positive `reconciliation.drift_detected` journal event every ~30 seconds per open position. The bot `TradingActor` already has the correct guard; the agent actor was missed.
- **Root Cause:** `AgentTradingActor.startReconciler()` (line 2715) lacks the early-return guard that `TradingActor.startReconciler()` has for shadow/paper execution modes. Shadow-mode positions are synthetic (never sent to the venue), so comparing local DB positions against real venue state always produces `position_mismatch` diffs — "Local has long position but venue has no position." The orphaned-position cleanup helper runs only once at startup and does not reliably close all positions.
- **Fix:** Added an early-return guard at the top of `AgentTradingActor.startReconciler()` matching the existing bot actor pattern:
  ```ts
  if (this.deps.executionMode === 'shadow' || this.deps.executionMode === 'paper') return;
  ```
- **Files Changed:**
  - `apps/worker/src/agent-trading-actor.ts` — added 5-line guard at top of `startReconciler()`
- **Verification:** `pnpm lint` passes. Confirmed by code review that the guard matches `TradingActor.startReconciler()` pattern exactly.
- **References:**
  - Plan: `docs/features/2026/07/05/001-agent-runtime-reliability/001-plan.md` (Issue 3)
  - Eval: `.ignore/eval/2026/07/07/6580df07-9d47-4b04-88b9-5e8de3a43749/01/REPORT.md`
