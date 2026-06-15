# Review: Graceful Agent Deployment - Zero/Low Downtime

## Verdict

Partially implemented.

The worker now uses Docker stop semantics in [apps/worker/src/agents/docker-agent-manager.ts](../../../apps/worker/src/agents/docker-agent-manager.ts) and the agent runtime registers a unified SIGTERM/SIGINT shutdown path in [apps/worker/src/agent.ts](../../../apps/worker/src/agent.ts). But the agent-side shutdown is still immediate rather than graceful: it clears timers, publishes `session_ended`, quits Redis, and calls `process.exit(0)` without waiting for in-flight tick, LLM, or tool work to drain.

## Findings

1. High: SIGTERM handling still does not drain in-flight work.
   [apps/worker/src/agent.ts](../../../apps/worker/src/agent.ts) now has `shutdown(reason)`, but that function does not wait for the active tick or any in-flight operation to complete within a bounded timeout. The plan's Phase 1 requirement was to stop accepting new work, wait briefly for existing work, then exit cleanly. Exiting immediately weakens the safety goal around duplicate decisions and partial work.

2. Medium: the worker-side stop timeout is present but not aligned with the plan's stated drain window.
   [apps/worker/src/agents/docker-agent-manager.ts](../../../apps/worker/src/agents/docker-agent-manager.ts) uses `?t=10`, while the plan text discusses a longer bounded drain window and orchestration coordination around it. The current implementation has the right mechanism but not an explicit, documented contract for how long the runtime is expected to drain.

## Suggested Change List

1. High: modify [apps/worker/src/agent.ts](../../../apps/worker/src/agent.ts) `shutdown()` so it stops scheduling new work, waits for any active tick/tool loop to finish, and enforces a hard drain timeout before `process.exit(0)`.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: confirm which operations are allowed to finish during drain versus which must be aborted, especially around trade submission and market-data refresh.
   Test expectation: integration-test SIGTERM during an active tick; unit-test shutdown idempotency; no visual verification needed.

2. Medium: modify [apps/worker/src/agents/docker-agent-manager.ts](../../../apps/worker/src/agents/docker-agent-manager.ts) and any deployment notes so the Docker stop timeout matches the agent drain budget and is explained as a contract.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: if the timeout is too short, the runtime will still be SIGKILLed mid-drain; if too long, rolling deploys stall unnecessarily.
   Test expectation: integration test around stop timing; operational verification in a dev deploy.

3. Medium: add focused tests proving graceful stop does not produce duplicate crash handling or double-submit behavior when SIGTERM lands during a live runtime tick.
   Files/functions: [apps/worker/src/agent.ts](../../../apps/worker/src/agent.ts), [apps/worker/src/agents/docker-agent-manager.ts](../../../apps/worker/src/agents/docker-agent-manager.ts), [apps/worker/src/agents/agent-session-manager.ts](../../../apps/worker/src/agents/agent-session-manager.ts).
   Change: add.
   Dependencies: step 1.
   Risks/Open questions: the branch already improved status alignment, so this test should specifically guard the deploy-time handoff behavior rather than re-testing the terminal-state fix.
   Test expectation: integration test; no visual verification needed.