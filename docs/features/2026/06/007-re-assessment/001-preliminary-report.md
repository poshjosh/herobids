# Preliminary Report

## Prompt

Have the plans in the folder been fully implemented docs/features/2026/06/005-agent-mvp-rollout-plan/

## Response

No.

**Findings**
1. High: Step 7 runtime ownership is still a stub, so the rollout plan’s runtime-boundary requirement is not fully implemented. The launcher explicitly says production would call Docker/ECS later and currently synthesizes a container ID in memory instead of launching a real runtime: agent-runtime-launcher.ts, agent-runtime-launcher.ts. That does not satisfy the Step 7 deliverable in 001-mvp-delivery-plan.md.

2. High: The web UI still does not expose relink or delete controls, even though the plan requires users to relink and delete agents from the product surface. The detail page only wires start, stop, pause, and resume mutations/buttons: AgentDetailPage.tsx, AgentDetailPage.tsx, AgentDetailPage.tsx, AgentDetailPage.tsx. The API endpoints do exist: agents.ts, agents.ts. This leaves the Step 2 exit criterion in the plan unmet: 001-mvp-delivery-plan.md.

3. Medium: The mandatory safety-alert set is only partially wired. The platform alert service defines four required event types, including paused-by-guardrail and critical execution failure: platform-alert-service.ts, platform-alert-service.ts, platform-alert-service.ts. But the session manager currently fires only runtime failed and runtime unhealthy: agent-session-manager.ts, agent-session-manager.ts. So Step 4 is not fully realized in behavior even though the message type catalog exists.

4. Medium: Capability and sandbox policy are still mostly defined, not enforced on the production path. The broker still uses inline send_message limiting via a local constant and a per-agent clamp: agent-message-broker.ts, agent-message-broker.ts. The capability engine exists: capability-policy.ts, and the sandbox enforcer exists: sandbox-enforcer.ts, sandbox-enforcer.ts, but I did not find production instantiation of the capability engine outside tests; the concrete instantiations are in capability-sandbox.test.ts. That falls short of the Step 7 “production path” enforcement wording.

**What is implemented**
A large part of the MVP surface is now in place. The preset-backed create flow exists in the web UI: AgentsPage.tsx, AgentsPage.tsx, AgentsPage.tsx. The backend preset defaults include send_message policy: agents.ts. The send_message capability is registered: capability-policy.ts. The detail page now shows objective, recent decisions, message authorship separation, and artifacts: AgentDetailPage.tsx, AgentDetailPage.tsx, AgentDetailPage.tsx, AgentDetailPage.tsx, AgentDetailPage.tsx. The decisions and messages APIs also exist: agents.ts, agents.ts.