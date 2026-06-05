# Bug Report: Agent start failures were not surfaced and runtime crashes were not refreshed in the UI

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-04
- **Summary:** Starting an agent could fail or transition into a crashed/unhealthy runtime state without any prominent feedback on the agent detail page. The page only refreshed once after the start action, so fast runtime failures could look like a silent crash, and the pending start action still read like a normal idle button.

## Root Cause

The agent detail page was missing three pieces of feedback:

1. lifecycle mutation errors from `start`, `pause`, `resume`, and `stop` were not rendered inline
2. the main agent query did not poll after a successful start, so a fast transition to `crashed` or `unhealthy` could remain stale until manual refresh
3. the start button did not reflect the in-flight state, so the UI gave no immediate acknowledgement that the request was running

The backend route was already returning structured errors; the frontend simply did not surface them in a way an operator could notice.

## Fix

Updated `apps/web/src/features/agents/AgentDetailPage.tsx` to:

1. add inline `ErrorBanner` rendering for lifecycle mutation failures
2. poll the main agent query every 5 seconds so status changes become visible without a manual refresh
3. show a prominent banner when the agent reaches `crashed` or `unhealthy`
4. change the primary start button label to `Starting...` while the request is pending

## Files Changed

- [apps/web/src/features/agents/AgentDetailPage.tsx](../../apps/web/src/features/agents/AgentDetailPage.tsx)

## Verification

- Ran `pnpm lint`
- Result: `tsc --noEmit` completed successfully with no errors
- Confirmed the edited file has no TypeScript errors with the workspace error check
