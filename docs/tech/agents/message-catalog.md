# Agent Message Catalog

This document is the canonical v1 message catalog for communication between an agent runtime and a trading instance.

It derives from the ownership rules in [Agent Runtime Boundary And Message Contract](./runtime-boundary-and-message-contract.md). Recovery details live in [Recovery And Replay](./recovery-and-replay.md). Tool and sandbox policy lives in [Tool Access And Sandboxing](./tool-access-and-sandboxing.md).

## Purpose

The catalog is intentionally narrow.

- the agent proposes target-state intent
- the trading instance remains responsible for planning, risk, execution, reconciliation, journaling, and persistence
- the protocol remains valid regardless of whether the agent runtime is scheduled on `EC2`, Docker, or `ECS`
- the envelope does not assume every logical initiator is an agent

## Envelope

Every message uses the same outer envelope.

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | string | yes | Start at `v1` |
| `messageId` | string | yes | Unique per sent message |
| `correlationId` | string | yes | Groups request, status, and result messages for one logical action |
| `initiatorType` | string | yes | `agent`, `bot`, `user`, or `system` |
| `initiatorId` | string | yes | Stable logical initiator identifier |
| `originType` | string | no | Original logical cause of the broader flow when different from the current message author |
| `originId` | string | no | Stable identifier for the original logical cause of the broader flow |
| `tradingInstanceId` | string | yes | Target instance for single-instance messages |
| `type` | string | yes | Message type name from this document |
| `createdAt` | string | yes | ISO 8601 UTC timestamp |
| `payload` | object | yes | Type-specific body |
| `traceId` | string | no | Optional cross-service trace identifier |
| `sequence` | number | no | Optional per-correlation ordering hint |

Rules:

- `initiatorType` and `initiatorId` identify the logical author of the action, not necessarily the transport peer that sent the message.
- `originType` and `originId` identify the original logical cause of the broader flow when that provenance still matters.
- System-authored follow-up messages may preserve `originType` and `originId` as `agent`, `bot`, or `user` when the broader flow should remain attributable to that earlier initiator.
- Instance-originated messages that are not tied to a prior actor may use `initiatorType = system`.

## Delivery Semantics

- Delivery is at-least-once.
- Receivers must tolerate duplicate messages by `messageId`.
- Request and result matching uses `correlationId`, not arrival order.
- Unknown message types are rejected explicitly, not ignored silently.
- Invalid payloads are rejected before they reach planning or execution code.
- Lifecycle requests must be idempotent.
- A valid message may still be rejected because the decision is stale, unauthorized, unreconciled, or otherwise unsafe under explicit invariants.
- Invalid startup or operator config is outside this protocol and should fail fast before trading begins.

## Agent To Trading Instance

### `agent.decision.submit`

Purpose:
- Propose a target exposure change for one trading instance.

Maps to:
- `Decision`

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `decisionId` | string | yes | Idempotent decision identifier from the initiator side |
| `instrumentId` | string | yes | Canonical instrument identifier |
| `intent` | string | yes | `go_long`, `go_short`, `go_flat`, `increase`, `decrease` |
| `targetSize` | string | yes | Decimal string for desired final absolute size |
| `limitPrice` | string | no | Decimal string hint only |
| `contextHash` | string | no | Hash of the analyzed context |
| `rationaleSummary` | string | yes | Short user-facing explanation |
| `confidence` | number | no | `0` to `1`, advisory only |
| `artifacts` | object[] | no | Optional references to supporting artifact metadata |
| `metadata` | object | no | Extra structured, non-authoritative fields |

Rules:
- This is the only v1 message that can change exposure.
- `targetSize` describes target state, not the next order size by itself.
- V1 supports one decision for one instrument on one trading instance. Batches are out of scope.
- The worker stamps or verifies `tradingInstanceId` before converting the payload to an internal `Decision`.
- `rationaleSummary` is for UI and audit, not execution logic.
- `confidence` never bypasses risk rules.

### `agent.lifecycle.pause_request`

Purpose:
- Ask the trading instance to pause new autonomous decision intake.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `reason` | string | yes | Short machine-readable or human-readable reason |
| `requestedBy` | string | no | `agent`, `operator`, or other internal actor |
| `metadata` | object | no | Optional extra detail |

Rules:
- This requests a state transition. The trading instance remains authoritative over whether pause succeeds.
- Pausing does not imply closing positions unless another component decides that explicitly.
- Repeating the same pause request after the instance is already paused should be treated as success, not an error.

### `agent.lifecycle.stop_request`

Purpose:
- Ask the instance lifecycle controller to stop the agent-managed loop for the target instance.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `reason` | string | yes | Why stop was requested |
| `mode` | string | no | Suggested behavior such as `graceful` |
| `metadata` | object | no | Optional detail |

Rules:
- The worker decides whether this is allowed under current lifecycle rules.
- This does not give the agent direct stop authority over worker processes.
- Repeating the same stop request after the instance is already stopping or stopped should be treated as success, not an error.

### `agent.runtime.heartbeat`

Purpose:
- Let the worker know the agent runtime is alive while a session is active.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `sessionId` | string | yes | Runtime session identifier |
| `status` | string | yes | `starting`, `ready`, `busy`, `degraded` |
| `cpuPct` | number | no | Optional telemetry |
| `memoryBytes` | number | no | Optional telemetry |
| `toolActivity` | string | no | Short status description |

Rules:
- Heartbeats are operational signals only.
- Missing heartbeats may mark the runtime unhealthy, but they do not imply order failure by themselves.

### `agent.artifact.publish`

Purpose:
- Publish non-authoritative audit artifacts produced during analysis.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `artifactId` | string | yes | Stable artifact identifier |
| `artifactType` | string | yes | `tool_trace`, `web_fetch`, `code_exec_summary`, `prompt_summary`, or similar |
| `contentType` | string | yes | MIME-style content descriptor |
| `summary` | string | yes | Human-readable summary |
| `location` | object | no | Reference to stored large-body content |
| `metadata` | object | no | Optional extra fields |

Rules:
- Artifact metadata is synchronous to the decision path when present.
- Large artifact bodies should be stored asynchronously and referenced by `location`.
- Artifacts support audit and UI detail views.
- Artifacts never replace the decision payload as the authoritative market instruction.

## Trading Instance To Agent

### `instance.context.snapshot`

Purpose:
- Provide the current decision context for the target trading instance.

Maps to:
- persisted decision context shape

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `snapshotId` | string | yes | Snapshot identifier |
| `symbol` | string | yes | Market symbol |
| `price` | string | yes | Current reference price as decimal string |
| `timestamp` | string | yes | Snapshot timestamp |
| `marketData` | object | no | Additional summarized context |
| `position` | object or null | yes | Current position summary |
| `referenceMark` | object | yes | Price and source |
| `strategyParams` | object | yes | Runtime strategy configuration visible to the agent |
| `executionMode` | string | yes | `paper`, `shadow`, or `live` |
| `guardrails` | object | yes | Agent-level operational limits relevant to this session |
| `artifacts` | object[] | no | References or bounded raw slices for larger context |

Rules:
- This is a snapshot, not a grant of execution authority.
- The agent may use it for reasoning or reconnect recovery.
- V1 snapshots should carry summarized context plus bounded references or slices, not full raw windows.

### `instance.decision.accepted`

Purpose:
- Confirm that a submitted agent decision passed schema validation and entered the normal trading pipeline.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `decisionId` | string | yes | Initiator-submitted decision identifier |
| `acceptedAt` | string | yes | Timestamp |
| `normalizedDecision` | object | yes | Final decision shape after validation and stamping |

Rules:
- Acceptance means the worker will continue with planning and risk checks.
- Acceptance does not mean the decision will execute successfully.

### `instance.decision.rejected`

Purpose:
- Reject an agent decision before planning or execution.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `decisionId` | string | yes | Initiator-submitted identifier |
| `code` | string | yes | Stable rejection code |
| `message` | string | yes | Human-readable reason |
| `retryable` | boolean | yes | Whether retry makes sense |
| `details` | object | no | Validation or staleness detail |

Rules:
- Use this for malformed, unauthorized, stale, unsupported, or otherwise invalid decision submissions.
- Risk failures after planning should use guardrail or risk-specific messages instead of collapsing into this type.
- This is a runtime rejection path. It must not hide startup or operator-config safety failures that should block trading before the protocol comes up.

### `instance.plan.status`

Purpose:
- Expose planning-stage and plan-lifecycle outcomes back to the agent.

Maps to:
- `ExecutionPlan`

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `decisionId` | string | yes | Associated decision |
| `planId` | string | yes | Internal execution plan identifier |
| `status` | string | yes | `created`, `executing`, `completed`, `failed` |
| `action` | string | yes | Plan action such as `open_long` or `close` |
| `venue` | string | yes | Target venue |
| `symbol` | string | yes | Target symbol |
| `orderCount` | number | yes | Planned order count |
| `reason` | string | no | Optional failure or completion note |

Rules:
- This keeps the agent informed without exposing direct order placement control.
- `failed` here means plan lifecycle failure, not necessarily transport failure.

### `instance.execution.result`

Purpose:
- Return the trading outcome for an executed plan.

Maps to:
- `ExecutionResult`

Precondition:
- The execution plan must already be durably persisted before any venue-side effect occurs, so restart recovery can reconcile incomplete work deterministically.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `decisionId` | string | yes | Associated decision |
| `planId` | string | yes | Associated plan |
| `orders` | object[] | yes | Managed order summaries |
| `fills` | object[] | yes | Fill summaries |
| `positionAfter` | object | yes | Updated position state |
| `executionFailed` | boolean | yes | Whether the execution path failed |
| `completedAt` | string | yes | Timestamp |

Rules:
- Order and fill objects should remain summaries, not raw venue SDK payload dumps.
- This message supports the agent activity feed and detail drawer.

### `instance.guardrail.triggered`

Purpose:
- Inform the agent that orchestration or engine safety rules blocked or constrained progress.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `scope` | string | yes | `agent_guardrail` or `risk_gate` |
| `code` | string | yes | Stable code |
| `message` | string | yes | Human-readable reason |
| `decisionId` | string | no | Included when tied to a specific decision |
| `details` | object | no | Structured context |

Rules:
- Keep agent guardrails and engine risk outcomes distinguishable.
- This should remain compatible with journal event surfaces such as `risk.rejected`.

### `instance.reconciliation.notice`

Purpose:
- Inform the agent of reconciliation findings that materially affect trust in local state.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `severity` | string | yes | `info`, `warn`, `critical` |
| `eventType` | string | yes | `match`, `drift_detected`, `drift_within_threshold`, `correction` |
| `summary` | string | yes | Short explanation |
| `details` | object | no | Structured reconciliation detail |
| `occurredAt` | string | yes | Timestamp |

Rules:
- Do not stream all low-value reconciliation noise to the agent.
- Use this only for events relevant to trust, recovery, or user-facing explanation.

### `instance.status`

Purpose:
- Share lifecycle and health status for the target trading instance.

Payload fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | yes | `starting`, `running`, `paused`, `stopped`, `degraded`, `recovering` |
| `reason` | string | no | Explanation for the current state |
| `liveState` | string | no | Optional live safety state such as `armed` or `blocked` |
| `updatedAt` | string | yes | Timestamp |

Rules:
- This message supports UI health surfaces and reconnect recovery.
- It is not a substitute for detailed plan or execution messages.

## Minimal V1 Flow

1. Worker sends `instance.context.snapshot`.
2. Agent evaluates and sends `agent.decision.submit`.
3. Worker sends either `instance.decision.accepted` or `instance.decision.rejected`.
4. If accepted, worker sends `instance.plan.status` as the plan progresses.
5. Worker sends `instance.execution.result` or `instance.guardrail.triggered`.
6. Worker may additionally send `instance.status` or `instance.reconciliation.notice`.

## Explicitly Out Of Scope For V1

- multi-instance batch decisions in one message
- direct order-entry or cancellation messages
- direct venue API requests from the agent runtime
- `instance.context.snapshot.full` or equivalent unbounded raw snapshot variants
- human approval workflow messages
- billing or token-meter settlement messages
- generalized service-to-service tool protocol beyond the narrow agent boundary