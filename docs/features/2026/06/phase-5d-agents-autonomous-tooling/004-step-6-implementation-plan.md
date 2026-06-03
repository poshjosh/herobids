# Step 6 Implementation Plan

Implement Step 6 of [Phase 5 Outline](../../../../features/2026/05/initial/019-phase-5-outline.md): agents and autonomous tool use.

## Canonical Inputs

Use these as the source of truth for Step 6:

- [Vision](../../../../vision.md)
- [Design Decisions](../../../../features/2026/05/initial/003-design-decisions.md)
- [ADR 001: Actor-Neutral Agent Protocol](../../../../tech/adrs/2026/06/001-actor-neutral-agent-protocol.md)
- [ADR 002: Redis Streams Agent Transport](../../../../tech/adrs/2026/06/002-redis-streams-agent-transport.md)
- [ADR 003: Single-Container Agent Code Execution](../../../../tech/adrs/2026/06/003-single-container-agent-code-execution.md)
- [Agent Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)

Important: where [Design Decisions](../../../../features/2026/05/initial/003-design-decisions.md) conflicts with the newer docs under [docs/tech/agents](../../../../tech/agents/), the newer agent docs win. The main practical difference is network policy: the canonical Step 6 stance is open internet egress from the sandbox with hard runtime controls, not destination allowlists for general web research.

## Why Step 6 Can Reuse The Current System

The repo already has the hard parts of the trading side in place:

- `Decision -> ExecutionPlan -> ExecutionResult` is already a first-class pipeline in `packages/domain`, `packages/engine`, and `packages/db`.
- Write-ahead persistence exists before venue side effects in [packages/engine/src/trading-cycle.ts](../../../../../packages/engine/src/trading-cycle.ts).
- Rehydration and incomplete-plan recovery already exist in [apps/worker/src/trading-actor.ts](../../../../../apps/worker/src/trading-actor.ts) and [apps/worker/src/runtime.ts](../../../../../apps/worker/src/runtime.ts).
- User auth, ownership checks, plan gates, dashboard activity, and instance read models already exist in `apps/api` and `apps/web`.

That means Step 6 should not invent a parallel execution stack. The agent runtime should become a new producer of strategic intent that feeds the existing engine-owned pipeline.

## Recommended V1 Product Shape

Use the smallest model that matches the new boundary without rewriting the whole product:

1. Add a first-class `Agent` entity owned by `User`.
2. Treat the existing `trading_instance` as the execution unit the agent can drive.
3. Reserve `Bot` as a future actor type, but do not implement bot CRUD, bot sessions, or bot runtime behavior in Step 6.
4. Allow one agent to link to one or more trading instances in the data model.
5. Run one agent session against one trading instance at a time in the first release, even if the schema allows more than one link.

This keeps the product agent-first while preserving a clean path for bots later. The current `trading_instances` table already represents the execution-owned runtime unit, so Step 6 should not introduce a separate `bots` table or bot runtime path yet. If a later product phase needs bots as a user-visible object, add that as a follow-on migration instead of front-loading it into Step 6.

## Explicit V1 Goals

Step 6 should deliver all of the following:

1. An isolated agent runtime with no direct venue credentials, no direct DB writes, and no direct execution authority.
2. A versioned, duplicate-safe agent-to-instance message contract matching the canonical docs.
3. An instance-owned decision intake path that validates, persists, plans, risk-checks, executes, and journals agent proposals using the same path as existing strategies.
4. Tool-mediated agent capabilities with server-side enforcement, audit, revocation, and bounded artifacts.
5. Recovery behavior for runtime heartbeat loss, worker death, reconnect, and bounded replay.
6. A simple user-facing agent surface for create, link, pause, inspect, and troubleshoot.

## Explicit V1 Non-Goals

Do not fold these into the first Step 6 delivery:

1. Batch multi-instrument decisions.
2. Direct order-entry or order-cancel messages in the agent contract.
3. Manual approval workflows.
4. A generalized tool marketplace.
5. Full agent-to-many-instances concurrent orchestration inside one runtime session.
6. A separate standalone `bots` product model unless a later requirement makes it unavoidable.

## Recommended Plan

### Phase 0: Freeze The Remaining Decisions That Actually Block Implementation

Goal:
Pick the remaining implementation choices that affect schema, transport, sandbox, and UI wording.

Required decisions:

1. Identity model: user owns agents; bots are reserved for future use; agents link to existing trading instances; no separate first-release `bots` table.
2. Session model: one runtime session targets one trading instance at a time in v1.
3. Artifact storage: Postgres metadata plus object storage for large bodies, with retention classes on the metadata record.
4. Code execution boundary: one separate container per agent runtime, with code execution inside that container as a restricted local subprocess or sandbox; no second code-execution container in v1.
5. Open egress guardrails: conservative, configurable budgets for requests, concurrency, wall-clock time, output size, storage, and kill-switch behavior.
6. Durable transport: Redis Streams in v1 for the canonical protocol path, with `messageId` dedupe and bounded replay; not bare pub/sub.

Deliverables:

- update the canonical agent docs under [docs/tech/agents](../../../../tech/agents/) with the final decisions above
- trim [003-open-questions.md](./003-open-questions.md)
- write one short implementation ADR for transport choice and one for execution-sandbox choice

Exit criterion:
No remaining open question should force a schema rewrite or transport rewrite after implementation starts.

### Phase 1: Refactor The Engine Boundary So Agent Decisions Reuse The Existing Pipeline

Goal:
Separate strategy evaluation from decision execution so an agent, a server-controlled strategy, or a future manual flow can all submit a `Decision` through one engine-owned path.

Target surfaces:

- [packages/engine/src/trading-cycle.ts](../../../../../packages/engine/src/trading-cycle.ts)
- [packages/domain/src/models/decision.ts](../../../../../packages/domain/src/models/decision.ts)
- [packages/engine/src/journal.ts](../../../../../packages/engine/src/journal.ts)

Implementation tasks:

1. Split the current trading cycle into:
   - context snapshot generation
   - optional strategy evaluation
   - decision intake and execution pipeline
2. Add an engine-facing function such as `submitDecisionForExecution(...)` that performs:
   - decision normalization and stamping
   - decision persistence
   - context persistence
   - plan creation
   - risk checks
   - execution
   - journal writes
3. Keep the current strategy loop as a caller of that new function.
4. Add actor metadata so decisions can be attributed to `agent`, `bot`, `user`, or `system` without changing execution authority, using `actorType` / `actorId` at the protocol boundary and local terminology elsewhere when that is clearer.

Why this phase comes first:
Without this refactor, agent work will drift into a second execution path and eventually fork risk, audit, and recovery behavior.

Exit criterion:
There is one reusable decision-ingestion path for both existing strategies and future agent submissions.

### Phase 2: Add The Agent Protocol, Durable Message Ledger, And Read Models

Goal:
Make the agent protocol durable, duplicate-safe, and queryable.

Recommended new persistence surfaces:

1. `agents`
   - `id`, `user_id`, `name`, `goal`, `status`, `pause_state`, `tool_policy`, `model_policy`, timestamps
2. `agent_instance_links`
   - `agent_id`, `trading_instance_id`, link status, timestamps
3. `agent_runtime_sessions`
   - `id`, `agent_id`, `trading_instance_id`, runtime status, last heartbeat, resource telemetry, started/stopped timestamps
4. `agent_messages`
   - raw envelope metadata for dedupe, correlation, replay cursoring, and diagnostics
   - store canonical actor/provenance fields here, not agent-only assumptions
5. `agent_artifacts`
   - metadata rows plus object-storage reference for large bodies

Recommended reuse:

- keep `decisions`, `execution_plans`, `journal_events`, and `decision_contexts` as the authoritative trading-side audit path
- do not overload `llm_decision_artifacts` for generic autonomous-agent artifacts

Target packages:

- `packages/db/src/schema`
- `packages/db/src/repositories.ts`
- `packages/db/src/journal-pg.ts`

Important rule:
The message ledger is not the trading source of truth. It exists to support protocol semantics, dedupe, replay, and runtime diagnostics. Trading truth remains in the existing decision, plan, fill, position, reconciliation, and journal tables.

Exit criterion:
The system can persist and replay protocol traffic without weakening the existing engine-owned audit trail.

### Phase 3: Implement The Worker-Side Agent Broker And Runtime Orchestrator

Goal:
Run isolated agent sessions as a worker concern, not as part of the trading engine.

Recommended package location:

- `apps/worker/src/agents/`

Main components:

1. `AgentRuntimeLauncher`
   - launches, stops, and kills sandboxed runtimes
   - hides whether the runtime is local Docker, ECS, or another sandbox
2. `AgentSessionManager`
   - owns session lifecycle, heartbeats, cleanup, and reconnect policy
3. `AgentMessageBroker`
   - validates envelopes
   - enforces capability grants
   - handles dedupe and correlation
4. `AgentDecisionHandler`
   - translates `agent.decision.submit` into the engine decision-ingestion path from Phase 1
5. `InstanceEventPublisher`
   - emits `instance.context.snapshot`, `instance.decision.accepted`, `instance.decision.rejected`, `instance.plan.status`, `instance.execution.result`, `instance.guardrail.triggered`, and material `instance.reconciliation.notice`

Transport recommendation:

- use Redis Streams for the canonical protocol path
- do not use bare Redis pub/sub for the canonical message path because it does not provide durable replay or consumer recovery semantics

Integration points:

- [apps/worker/src/runtime.ts](../../../../../apps/worker/src/runtime.ts)
- [apps/worker/src/trading-actor.ts](../../../../../apps/worker/src/trading-actor.ts)
- existing lease and crash-handling logic in [apps/worker/src/instance-lease.ts](../../../../../apps/worker/src/instance-lease.ts)

Exit criterion:
An isolated runtime can connect, receive a bounded context snapshot, submit a decision, and receive lifecycle feedback without direct access to execution internals.

### Phase 4: Implement Tooling, Capability Grants, And Sandbox Enforcement

Goal:
Enable autonomous tool use without collapsing the trust boundary.

Implementation requirements:

1. Capability grants are issued by the platform and enforced server-side.
2. Brokered operations remain mandatory for:
   - decision submission
   - secret-backed calls
   - internal app data reads governed by tenancy
   - artifact persistence
   - durable writes
3. Direct sandbox access is allowed only for open-internet read and research tasks within hard budgets.
4. Code execution ships behind a stricter boundary than the main runtime.
5. All tool invocations and significant direct egress activity produce auditable summaries.

Recommended v1 guardrails:

1. max concurrent outbound requests per session
2. per-session request budget per minute
3. hard timeout per tool run
4. max response size and download size
5. max temporary storage
6. max process count
7. operator kill switch at agent and global levels

Why this phase cannot be deferred too far:
The first Step 6 release includes autonomous tooling, so the enforcement path must exist before the agent UI is exposed broadly.

Exit criterion:
The runtime can research and use approved tools, but any attempt to access secrets, mutate internal state, or bypass the broker fails closed and is audit-visible.

### Phase 5: Expose Agent APIs And Product Ownership Rules

Goal:
Make agents a user-owned product object in the API without breaking current instance ownership behavior.

New API areas:

1. agent CRUD
2. agent-to-instance linking
3. pause and resume
4. session status and heartbeat health
5. agent activity and artifact summary views
6. decision-detail and guardrail-detail views scoped by user ownership

Ownership rules:

1. user owns agents
2. user owns trading instances
3. an agent may only link to trading instances owned by the same user
4. agent runtime messages are rejected if the link is missing, paused, stale, or unauthorized

Integration points:

- auth plugin and request ownership patterns already used in `apps/api`
- plan guards in [apps/api/src/plan-guards.ts](../../../../../apps/api/src/plan-guards.ts)
- current instance routes in [apps/api/src/routes/instances.ts](../../../../../apps/api/src/routes/instances.ts)

Recommended billing and plan posture:

- add plan limits for `maxAgents`, `agentRuntimeEnabled`, and later budget fields
- keep cost-metering hooks separate from the first protocol implementation so billing can evolve without rewriting the runtime boundary

Exit criterion:
The API can create, link, pause, inspect, and authorize agents as first-class user resources.

### Phase 6: Simplify The Frontend Around Actual Agents, Not Just Trading Instances

Goal:
Add the minimum UI needed to make Step 6 usable without forcing a full IA rewrite.

Important current-state issue:
The current web app already labels trading instances as agents. That is acceptable for the pre-Step-6 world, but Step 6 needs a real agent object. The UI must stop conflating the isolated reasoning runtime with the execution unit.

Recommended UI approach:

1. keep the creation flow simple: one agent form, one primary goal, one linked trading instance in the first release
2. expose advanced options behind a secondary panel rather than in the main create flow
3. keep the existing activity-first dashboard structure
4. add an agent detail view that shows:
   - linked instance
   - session health
   - latest context snapshot time
   - recent decisions
   - recent guardrails and reconciliation notices
   - artifact summaries

Recommended UI sequence:

1. introduce new `Agents` routes and API client methods
2. rename the current instance-management surface to `Instances` or `Execution Units` where needed
3. preserve the mission-control summary cards, but back them with real agent read models

Exit criterion:
Users can create an agent in one short flow and understand the difference between the agent runtime and the linked trading instance.

### Phase 7: Recovery, Replay, And Failure Semantics

Goal:
Make failures boring and explainable.

Implementation tasks:

1. heartbeat timeout marks the runtime unhealthy and stops trusting new agent input
2. already-accepted decisions continue through the existing engine path
3. reconnect sends:
   - latest instance status
   - fresh context snapshot
   - bounded replay of high-value missed events
4. duplicate handling is enforced by `messageId` and `decisionId`
5. stale or unauthorized decisions are rejected with stable codes before planning or execution

Reuse:

- leverage the current worker crash recovery and incomplete-plan reconciliation model
- do not invent a second recovery model for agent-driven decisions

Exit criterion:
An agent runtime crash, worker crash, reconnect, or duplicate delivery does not produce ambiguous trading authority or ambiguous audit state.

### Phase 8: Test The Contract, Not Just The Happy Path

Goal:
Prove the boundary works under failure, duplication, and abuse.

Required test groups:

1. schema-validation tests for every protocol message
2. dedupe tests for repeated `messageId` and repeated `decisionId`
3. ownership tests for cross-user link or message attempts
4. heartbeat-loss tests
5. worker-crash recovery tests after decision acceptance but before terminal execution records
6. sandbox-policy tests for disallowed tool calls and secret access attempts
7. API and UI tests for pause, reconnect, and activity views

Recommended acceptance scenario:

1. create user and agent
2. link one trading instance
3. start session
4. deliver context snapshot
5. submit one valid decision
6. observe accepted, plan, execution, and result events
7. kill the runtime
8. verify no new agent decisions are trusted until health returns
9. reconnect and receive bounded replay

Exit criterion:
The main safety properties in the canonical docs are covered by automated tests rather than only by documentation.

## Recommended Delivery Sequence

Ship Step 6 in four increments instead of one large merge:

1. Engine refactor plus protocol schemas plus DB groundwork.
2. Worker broker plus durable transport plus context snapshot and decision submission.
3. Sandbox, tool policy, heartbeat, replay, and artifact path.
4. Agent API and UI surfaces, followed by rollout behind a feature flag.

This order keeps the riskiest architectural work ahead of UI churn and makes the rollout reversible.

## Fallback Plan If Code Execution Isolation Slips

If the stricter execution sandbox is not ready on time, do not block the whole Step 6 release. Ship a narrower cut first:

1. isolated runtime
2. message contract
3. context snapshots
4. decision submission
5. web research and brokered read tools only
6. code execution disabled behind a feature flag

Then add code execution as Step 6b once the stricter sandbox has passed policy and recovery testing.

This is preferable to shipping unconstrained code execution in the main runtime.

## Concrete First Build Slice

The first implementation slice should be:

1. refactor the engine so externally submitted decisions reuse the current decision-to-execution path
2. add protocol schemas and a durable inbound decision handler
3. add minimal `agents`, `agent_instance_links`, and `agent_runtime_sessions` tables
4. expose one API flow to create an agent and link exactly one trading instance
5. run one agent session with heartbeat, context snapshot, one decision submission, and accepted or rejected feedback

That slice is small enough to test end-to-end and large enough to prove the boundary.

## Assumptions Used In This Plan

1. `trading_instances` remain the engine-owned execution unit in the first Step 6 release.
2. Real agent sessions are first-class product objects and should no longer be conflated with trading instances in the UI.
3. The first user-facing create-agent flow should stay minimal rather than expose every runtime or tool setting up front.
4. Billing hooks should be added in a way that does not change the protocol or trust boundary.