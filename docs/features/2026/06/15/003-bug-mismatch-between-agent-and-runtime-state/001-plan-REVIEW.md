# Review: Bug - Mismatch Between Agent And Runtime State

## Verdict

Implemented cleanly in the current branch slice.

The branch introduces status-aware runtime-session retirement in [packages/db/src/agent-repository.ts](../../../packages/db/src/agent-repository.ts), threads the same terminal status through [apps/worker/src/agents/agent-session-manager.ts](../../../apps/worker/src/agents/agent-session-manager.ts), and makes Docker die handling idempotent in [apps/worker/src/agents/docker-agent-manager.ts](../../../apps/worker/src/agents/docker-agent-manager.ts). I did not find a blocking correctness issue in this slice.

## Findings

No blocking findings in the branch-local implementation.

Residual risk remains around cross-component lifecycle regressions because the correctness contract spans broker, session manager, repository, Docker fallback handling, and API activity rendering.

## Suggested Change List

1. Low: add an integration-style regression test that exercises `session_ended` followed by a delayed Docker die event across the full lifecycle path.
   Files/functions: [apps/worker/src/agents/agent-message-broker.ts](../../../apps/worker/src/agents/agent-message-broker.ts), [apps/worker/src/agents/agent-session-manager.ts](../../../apps/worker/src/agents/agent-session-manager.ts), [apps/worker/src/agents/docker-agent-manager.ts](../../../apps/worker/src/agents/docker-agent-manager.ts).
   Change: add.
   Dependencies: none.
   Risks/Open questions: unit tests already cover the individual branches, but they do not fully lock the ordering-sensitive interaction this plan was fixing.
   Test expectation: integration test; no visual verification needed.

2. Low: expand the API activity mapping tests to explicitly assert the user-facing distinction between `stopped` and `crashed` runtime sessions.
   Files/functions: [apps/api/src/routes/agent-activity-mapper.ts](../../../apps/api/src/routes/agent-activity-mapper.ts), [apps/api/src/routes/agent-activity-mapper.test.ts](../../../apps/api/src/routes/agent-activity-mapper.test.ts).
   Change: add.
   Dependencies: none.
   Risks/Open questions: this is primarily contract hardening so a future persistence regression cannot silently turn a crash back into a graceful stop in the UI.
   Test expectation: unit test only.