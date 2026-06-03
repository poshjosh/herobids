# Canonical Step 6 Completion Track

This document defines what still remains after the MVP-first plan if the goal is to mark canonical Step 6 fully complete.

It replaces the earlier split between the remaining-implementation plan and delivery slices.

Use this document when the question is:

"What still blocks us from honestly calling canonical Step 6 done after the MVP path is set?"

## Canonical Inputs

Treat these as the main inputs:

- [Phase 5 Outline](../../../../features/2026/05/initial/019-phase-5-outline.md)
- [Step 6 Implementation Plan](../001-phase-5d-agents-autonomous-tooling/004-step-6-implementation-plan.md)
- [MVP Delivery Plan](./001-mvp-delivery-plan.md)
- [Agent Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)
- [ADR 002: Redis Streams Agent Transport](../../../../tech/adrs/2026/06/002-redis-streams-agent-transport.md)
- [ADR 003: Single-Container Agent Code Execution](../../../../tech/adrs/2026/06/003-single-container-agent-code-execution.md)

## Confirmed Baseline

Treat the following as already landed baseline rather than fresh design territory:

1. agent CRUD, linking, runtime sessions, message ledger, and artifact metadata persistence
2. engine-owned decision intake reuse for agent-submitted decisions
3. Redis Streams-based inbound and outbound protocol transport
4. basic agent UI for create, inspect, start, pause, resume, sessions, activity, and artifacts
5. lifecycle truth and decision-context integrity hardening from the prior patch plan
6. the MVP path centered on brokered `send_message` and fixed safety alerts

## Remaining Gaps That Still Block Canonical Step 6

### 1. Real runtime isolation is still incomplete

The launcher abstraction exists, but the live behavior still needs a real durable container-backed boundary rather than placeholder semantics.

### 2. Broader autonomous tool use is not complete end to end

The canonical Step 6 scope is larger than the MVP `send_message` path.

It still needs explicit support for broader tool activity such as `web_fetch`, `code_execute`, and `artifact_publish` under the approved runtime boundary.

### 3. Capability and sandbox enforcement must become runtime authority

Policy and sandbox code must actively govern runtime behavior on the production path, not merely describe the intended security model.

### 4. Artifact body storage and retrieval remain incomplete

Metadata exists, but large-body persistence and retrieval still need an explicit bounded storage path.

### 5. The operational surface still needs final completion

The MVP UI surface is sufficient for rollout, but canonical Step 6 still requires clearer exposure of tool activity, policy state, and failure explanations.

## Ordered Completion Slices

Ship these in order.

Do not start broader autonomous-tooling work before the runtime boundary and enforcement path are real enough to constrain it.

### Slice 1: Real Runtime Launch Boundary

Goal:
Replace placeholder runtime behavior with a real container-backed agent runtime while preserving the existing launcher abstraction.

Primary files:

- `apps/worker/src/agents/agent-runtime-launcher.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/config.ts`
- `packages/domain/src/config/schema.ts`
- `config/default.yaml`

Deliverables:

1. operator config for agent runtime image, scratch storage, resource limits, wall-clock limits, and kill-switch behavior
2. Docker-backed launch, stop, and kill implementation behind `AgentRuntimeLauncher`
3. minimal runtime environment contract with no raw venue credentials, host control, or full operator-config blob
4. stable launch-failure classification and logging
5. shutdown ordering that tears down tracked runtimes predictably

Acceptance checks:

1. starting a session launches a real container
2. first heartbeat still controls the `starting -> running` transition
3. stop and kill semantics affect real container state, not only in-memory state
4. failed launch returns the agent to a retryable non-running state

### Slice 2: Runtime Enforcement On The Hot Path

Goal:
Make capability policy and sandbox limits active runtime controls rather than passive helper modules.

Primary files:

- `apps/worker/src/agents/capability-policy.ts`
- `apps/worker/src/agents/sandbox-enforcer.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `packages/db/src/agent-repository.ts`
- `apps/api/src/routes/agents.ts`

Deliverables:

1. effective-policy resolver from operator defaults plus per-agent overrides
2. sandbox session registration and cleanup tied to runtime-session lifecycle
3. real recording of capability start and end on the production path
4. stable denial and violation codes surfaced into audit and activity views
5. global and per-agent kill-switch support

Acceptance checks:

1. disabled capabilities fail closed
2. rate and concurrency limits trigger under real session activity
3. policy changes affect newly started sessions deterministically
4. violations are visible through persisted audit state

### Slice 3: Explicit Broader Tool Execution Contract

Goal:
Add the broader autonomous-tooling contract instead of relying on decision submission, `send_message`, and artifact publishing alone.

Primary files:

- `packages/domain/src/agent-protocol.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/capability-policy.ts`
- `apps/worker/src/agents/sandbox-enforcer.ts`
- `docs/tech/agents/message-catalog.md`

Deliverables:

1. explicit brokered tool invocation semantics for broader brokered tools if they cross the protocol boundary
2. worker-side handling path for brokered capabilities
3. direct-tool path for sandboxed web research
4. restricted subprocess path for code execution inside the agent container
5. bounded tool-result summaries suitable for persistence and UI display

Recommended v1 broader capability scope:

1. `web_fetch`
2. `code_execute`
3. `artifact_publish`

Hard rules:

1. decision submission remains the only market-affecting capability
2. no direct venue API capability is exposed to the runtime
3. no secret-backed internal write path bypasses the broker

Acceptance checks:

1. the agent can perform one successful web fetch within limits
2. the agent can perform one successful restricted code execution within limits
3. denied tool calls are audit-visible and do not execute speculatively

### Slice 4: Artifact Body Storage And Retrieval

Goal:
Complete the large-artifact path so tool traces and code-execution outputs have a bounded persistence model.

Primary files:

- `packages/db/src/schema/agent-artifacts.ts`
- `packages/db/src/agent-repository.ts`
- `apps/api/src/routes/agents.ts`
- `apps/web/src/features/agents/AgentDetailPage.tsx`
- operator config for artifact storage

Deliverables:

1. artifact body-storage abstraction
2. upload and fetch path for large artifact bodies
3. retention-aware delete and expiry behavior
4. metadata-first API responses with explicit artifact-detail fetch
5. UI drill-down for selected artifact details

Acceptance checks:

1. large artifact bodies are not stored inline in operational DB records
2. metadata and body can be retrieved separately
3. retention class affects expiry and cleanup behavior predictably

### Slice 5: Operator Surface Completion

Goal:
Expose the remaining runtime and tooling state without expanding the create-agent flow.

Primary files:

- `apps/api/src/routes/agents.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/AgentDetailPage.tsx`
- `apps/web/src/lib/api-client.ts`

Deliverables:

1. recent tool-activity read model or endpoint
2. recent policy-violation and runtime-failure summaries
3. effective tool-policy visibility in agent detail
4. clearer runtime-state labeling for unhealthy, killed, timed out, and paused states

UX rule:

Keep the create-agent flow minimal. Runtime and tool controls belong in details or settings, not in the initial modal.

Acceptance checks:

1. agent creation remains short
2. operators can diagnose runtime and tooling failures from the detail page
3. activity surfaces distinguish decisions, messages, tool activity, and policy failures

### Slice 6: Hardening And Release Validation

Goal:
Prove the completed boundary under failure, replay, and abuse.

Primary areas:

- worker agent-runtime integration tests
- protocol and policy tests
- artifact-storage tests
- narrow UI tests for runtime and activity surfaces

Required scenarios:

1. runtime launch failure
2. heartbeat timeout after a live container launch
3. denied capability invocation
4. sandbox limit breach
5. reconnect plus bounded replay after missed events
6. artifact retrieval after tool use
7. accepted decision continuity through runtime failure

Release gate:

Do not mark canonical Step 6 done until this slice passes.

## Fallback Release Slice

If the broader tool path slips but the runtime boundary is solid, a narrower truthful release is still acceptable:

1. complete Slice 1 and Slice 2
2. keep decision submission, lifecycle, heartbeat, replay, and artifact metadata
3. keep broader capabilities such as `web_fetch` and `code_execute` disabled by effective policy
4. present the release as an MVP or agent-runtime rollout, not full canonical Step 6 completion

This fallback preserves honest runtime semantics without overstating autonomous-tooling maturity.