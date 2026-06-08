# MVP Delivery Plan

This document is the canonical implementation plan for the agent MVP.

It replaces the earlier split between MVP framing and delivery ordering.

Use this document when the question is:

"What is the clearest implementation order for the quickest credible agent MVP in the current repo?"

## Canonical Inputs

Treat these as the main inputs:

- [Vision](../../../../vision.md)
- [Design Decisions](../../../../features/2026/05/initial/003-design-decisions.md)
- [Phase 5 Outline](../../../../features/2026/05/initial/019-phase-5-outline.md)
- [Agent Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)
- [ADR 001: Actor-Neutral Agent Protocol](../../../../tech/adrs/2026/06/001-actor-neutral-agent-protocol.md)
- [ADR 002: Redis Streams Agent Transport](../../../../tech/adrs/2026/06/002-redis-streams-agent-transport.md)
- [ADR 003: Single-Container Agent Code Execution](../../../../tech/adrs/2026/06/003-single-container-agent-code-execution.md)
- [Canonical Step 6 Completion Track](./002-canonical-step-6-completion-track.md)

## Product Positioning

The long-term vision is broad.

The current repo is narrower and should ship a credible trading-agent MVP first.

That MVP must be:

1. self-serve enough to feel like a real agent product
2. narrow enough to ship quickly against the current codebase
3. honest about where execution authority still lives

## One-Line MVP

An authenticated user creates a trading agent, links it to one trading instance, chooses one preset, gives it a goal and communication preferences, monitors it from the UI, receives agent-authored Telegram updates through a brokered `send_message` tool, and can start, pause, stop, relink, or delete the agent.

## User Story

1. user signs in
2. user creates one agent with:
	- name
	- goal
	- linked trading instance
	- one preset
3. UI shows:
	- status
	- latest heartbeat
	- linked instance
	- recent decisions
	- recent alerts or failures
	- objective progress and outcome summary
4. Telegram delivers:
	- the fixed mandatory critical safety-alert set
	- messages initiated by agents via `send_message`
	- any broader configurable non-critical system alerts are a later concern, not an MVP requirement
5. user can start, pause, stop, relink, and delete the agent

## Preset Model

A preset is the MVP's user-facing create-time abstraction.

It is not a promise that the backend must persist a first-class permanent `agent type` taxonomy.

For the MVP, a preset should resolve server-side into a bounded bundle of defaults such as:

1. default objective framing or starter instructions
2. default communication behavior
3. bounded capability or policy defaults appropriate for that preset

User-visible skill composition, skill deselection, and marketplace behavior are out of scope for the MVP create flow.

## Current Confirmed Baseline

The following already exist and should be treated as the starting point:

1. auth and per-user ownership patterns
2. agent CRUD, linking, runtime sessions, message ledger, and artifact metadata persistence
3. Redis Streams-based agent protocol transport
4. engine-owned decision intake reuse for agent-submitted decisions
5. a minimal agent UI for create, inspect, start, pause, resume, sessions, activity, and artifacts
6. lifecycle and decision-context integrity hardening from the prior patch plan
7. outbound Telegram infrastructure for platform-generated alerts

## MVP Scope

### In Scope

1. authenticated users owning agents and trading instances
2. a minimal create-agent flow with one preset
3. one agent linked to one active trading instance at a time
4. brokered outbound `send_message` for agent-authored user updates
5. a very small mandatory set of platform-authored safety alerts
6. health, progress, communication, and lifecycle visibility in the UI
7. start, pause, resume, stop, relink, and delete controls

### Hard Rules

1. `send_message` is outbound only in the MVP
2. `send_message` is always available in the MVP and is not disabled by user notification configuration
3. mandatory platform safety alerts are not configurable in the MVP
4. decision submission remains the only market-affecting capability
5. the create flow stays minimal; advanced controls belong in detail or settings surfaces
6. the user-facing preset is a bounded defaults bundle, not a full user-facing skills system

### Out Of Scope

1. unrestricted conversational Telegram control
2. a generalized skills marketplace
3. user-visible skill composition and deselection during MVP agent creation
4. a user-facing tool catalog editor
5. many-to-many orchestration between agents and multiple active instances
6. user-configurable disabling of mandatory safety alerts
7. full canonical Step 6 completion before MVP ship

## Communication Model

### Agent-authored communication

Primary mechanism:

- brokered `send_message`

Characteristics:

- outbound only
- audited
- rate-limited
- tied to agent and session identity
- targeted through platform-owned destination binding
- always available in the MVP, not controlled by a user-facing enable or disable switch
- configurable in cadence and style through agent instructions, not through a broad notification-product surface

### Platform-authored communication

Primary mechanism:

- mandatory safety alerts

Characteristics:

- tiny fixed set
- platform-authored, never impersonating the agent
- non-configurable in the MVP
- reserved for critical trust or safety events

Optional additional non-critical system alerts may become configurable later, but are not required for the MVP.

### Mandatory safety-alert set

1. runtime unhealthy or heartbeat lost beyond threshold
2. runtime failed to start or crashed
3. agent paused or stopped by a guardrail or platform safety rule
4. critical execution or reconciliation failure that leaves operator attention required

## Ordered Implementation Plan

Ship these steps in order.

### Step 1: Freeze The MVP Contract

Goal:
Lock the scope before broader Step 6 completion work continues.

Decisions to lock:

1. MVP is self-serve agent creation plus monitoring, not a chat-native agent platform
2. one preset is part of the create flow
3. `send_message` is included as a brokered outbound tool and is not a user-disabled notification option
4. the safety-alert set stays platform-authored and non-configurable
5. optional additional non-critical system alerts are post-MVP
6. unrestricted Telegram conversation stays out of scope

Exit criterion:

There is one canonical MVP contract and delivery order.

### Step 2: Stabilize The Existing Agent Core

Goal:
Make the current API, worker lifecycle, and UI baseline dependable enough for MVP rollout.

Primary files:

- `apps/api/src/routes/agents.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agents/agent-runtime-launcher.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/AgentDetailPage.tsx`

Deliverables:

1. finish remaining active-session and stop-path integration issues
2. expose stable runtime-health states to the UI
3. keep the create flow minimal while adding one preset selection
4. make the detail page the main operational surface

Exit criterion:

Users can create preset-backed agents and start, inspect, pause, resume, stop, relink, and delete them with trustworthy state shown in the UI.

### Step 3: Add Telegram Identity Binding And Authorship Separation

Goal:
Turn Telegram from an operator-only alert sink into a user-linked communication destination.

Primary files:

- `packages/domain/src/config/schema.ts`
- `apps/worker/src/alerting/`
- `apps/api/src/routes/agents.ts`
- relevant persistence surfaces in `packages/db/src/schema/`

Deliverables:

1. define user or agent binding to a Telegram destination
2. keep the existing platform alert path intact
3. separate platform-authored and agent-authored message records
4. ensure audit history can distinguish both authorship paths

Design constraint:

Do not reuse operator alert-routing config as the long-term user messaging model.

Exit criterion:

The platform can resolve the correct user destination and distinguish who authored each outbound message.

### Step 4: Lock Mandatory Safety Alerts As Platform Policy

Goal:
Preserve trust by making the minimum safety-alert layer fixed platform behavior.

Primary files:

- `apps/worker/src/alerting/alert-policy.ts`
- `apps/worker/src/alerting/alert-dispatcher.ts`
- related alerting docs and config surfaces

Deliverables:

1. define the exact fixed alert set
2. implement it as platform policy, not agent preference
3. make message authorship explicit in content and audit
4. keep user-routing and operator-routing concerns separate where needed
5. do not introduce MVP user-facing configuration for optional non-critical system alerts

Hard rule:

The user cannot disable this minimum safety set in the MVP.

Exit criterion:

Critical trust and safety events always reach the user even if the agent never calls `send_message`.

### Step 5: Add Brokered `send_message`

Goal:
Ship the narrow agentic communication primitive required for the MVP.

Primary files:

- `packages/domain/src/agent-protocol.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/capability-policy.ts`
- `apps/worker/src/agents/sandbox-enforcer.ts`
- `docs/tech/agents/message-catalog.md`

Deliverables:

1. explicit brokered tool semantics for `send_message`
2. capability checks and rate limits on the production path
3. audit metadata for each sent message
4. a platform-owned recipient-resolution path from user or agent binding
5. no direct runtime bypass around the broker
6. no MVP user-facing toggle that disables agent use of `send_message`

Suggested v1 contract:

1. platform resolves the recipient target
2. message body is bounded in size
3. optional short subject or category is allowed
4. optional reason or context reference is allowed

Exit criterion:

An agent can send outbound user updates through a real brokered capability with audit and limits.

### Step 6: Expand The UI Into A Real Agent Surface

Goal:
Make the product understandable from the UI without bloating the create flow.

Primary files:

- `apps/web/src/features/agents/AgentDetailPage.tsx`
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/lib/api-client.ts`
- `apps/api/src/routes/agents.ts`

Deliverables:

1. clear runtime-health and recent-failure visibility
2. recent agent-authored messages separated from platform safety alerts
3. recent decisions and outcomes
4. a simple progress summary toward the goal
5. latest heartbeat visibility
6. artifact and activity drill-downs that stay detail-page scoped

Exit criterion:

The user can understand what the agent is doing, how it is performing, what it has communicated, and whether it is healthy.

### Step 7: Strengthen Runtime Truth And Tool Safety For Rollout

Goal:
Reach MVP-grade trust for isolated runtime behavior and brokered tooling, then continue into full canonical Step 6 completion as needed.

Primary files:

- `apps/worker/src/agents/agent-runtime-launcher.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agents/capability-policy.ts`
- `apps/worker/src/agents/sandbox-enforcer.ts`
- `apps/worker/src/index.ts`

Deliverables required for MVP rollout:

1. move beyond placeholder runtime semantics toward real runtime ownership
2. enforce capability and sandbox policy on the production path for enabled capabilities
3. verify replay and reconnect behavior around message delivery and accepted decisions
4. keep execution authority entirely inside the trading-instance boundary

Follow-on completion track:

- use [002-canonical-step-6-completion-track.md](./002-canonical-step-6-completion-track.md) for the remaining broader autonomous-tooling and artifact-body work required to mark canonical Step 6 fully done

Exit criterion:

The MVP can roll out without pretending a weak runtime boundary is sufficient.

## MVP Acceptance Criteria

Do not call the MVP done until all of the following are true:

1. a user can authenticate and own agents and instances
2. a user can create an agent through a simple flow that includes one preset
3. a user can start, pause, resume, stop, relink, and delete the agent
4. the agent can send brokered outbound user updates through `send_message`
5. the platform sends the fixed non-configurable safety-alert set
6. the UI shows health, latest heartbeat, recent activity, recent communications, and simple progress toward objective
7. all market-affecting behavior still flows through the existing engine-owned execution path

## Recommended Follow-On After MVP

After the MVP is live and trustworthy, the next candidates are:

1. constrained inbound Telegram commands or conversation
2. richer presets or user-visible skill composition
3. broader user-configurable alert preferences beyond the fixed safety-alert layer
4. budget and communication preferences as first-class controls
5. the remaining canonical Step 6 completion work in [002-canonical-step-6-completion-track.md](./002-canonical-step-6-completion-track.md)