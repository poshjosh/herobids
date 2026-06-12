# Agent Protocol Activity Feed Recovery

## Status

`draft`

## Purpose

Restore the agent activity feed so it reflects meaningful runtime behavior instead of showing only session lifecycle rows, and do so using the existing protocol pipeline rather than inventing a parallel observability path.

This plan implements all previously recommended work:

1. Standardize activity mapping on canonical protocol constants.
2. Add curated runtime activity protocol events.
3. Register those events in the protocol catalog and broker.
4. Persist activity payloads so feed rows can show useful detail.
5. Instrument the runtime at operator-meaningful milestones.
6. Extend the feed contract for the new event families.
7. Add focused tests across protocol, broker, mapper, and route layers.

## Scope

### In scope

1. Fix stale protocol-name usage in activity mapping and tests.
2. Add new audit-style runtime activity message types for tick, scout, LLM, and tool milestones.
3. Persist protocol payload JSON for `agent_messages`.
4. Update the worker runtime to publish the new activity events into the existing inbound stream.
5. Update the broker to validate, persist, and accept the new event types.
6. Extend API feed typing and mapping to classify and render the new events.
7. Add database migration, repository wiring, and focused regression tests.
8. Keep heartbeat suppression intact.

### Out of scope

1. Do not mirror every container log line into the protocol.
2. Do not redesign Redis stream topology, consumer groups, or message transport direction.
3. Do not move activity feed storage into a separate table in this pass.
4. Do not redesign the UI in this plan beyond any API shape changes required to expose richer rows.
5. Do not add broad analytics or long-term reporting semantics beyond the activity feed use case.

## Problem Statement

The current activity feed is functionally empty for active agents.

1. `agent_runtime_sessions` contributes only lifecycle rows such as session started.
2. `agent_outbound_messages` and `agent_artifacts` are often empty for normal runs.
3. `agent_messages` is nearly empty after heartbeat suppression because the runtime core publishes only `agent.runtime.heartbeat` and `agent.runtime.session_ended` from `apps/worker/src/agent.ts`.
4. The mapper still contains stale literal protocol names that do not match the canonical constants used elsewhere in the system.
5. `agent_messages` does not persist payload JSON, so even accepted protocol rows cannot be rendered with enough detail.

As a result, the existing feed pipeline is structurally present but operationally underfed and partially out of sync with the protocol catalog.

## Target End State

After this plan lands:

1. Active agents emit a small, curated set of runtime activity events into the existing inbound protocol stream.
2. The broker accepts and persists those events with payload JSON.
3. The activity feed route returns meaningful rows for tick flow, scout decisions, LLM dispatch/completion, and tool execution.
4. The mapper uses canonical protocol constants instead of stale literal names.
5. Heartbeats remain suppressed.
6. The feed provides enough detail to answer basic operator questions such as:
   - Why did this tick skip?
   - Did scout hold or escalate?
   - Which model phase ran?
   - Which tool was called and what happened?

## Design Principles

1. Reuse the existing agent protocol path: runtime -> Redis inbound stream -> consumer -> broker -> `agent_messages` -> API mapper.
2. Prefer curated audit milestones over log mirroring.
3. Persist bounded, structured payloads rather than raw unbounded execution blobs.
4. Standardize on canonical constants from `packages/domain/src/agent-protocol.ts`.
5. Keep business-side effects and observability events separate; most new events are persist-only.
6. Preserve current behavior by default except for newly visible activity rows.

## Proposed Event Set

Add the following canonical message types under the agent activity/audit surface:

1. `agent.tick.started`
2. `agent.tick.skipped`
3. `agent.scout.held`
4. `agent.scout.escalated`
5. `agent.llm.dispatch`
6. `agent.llm.completed`
7. `agent.tool.call`
8. `agent.tool.result`

### Payload intent

These payloads should be small, typed, and operator-readable.

1. `agent.tick.started`
   - `tickId`
   - `trigger`
   - `positionSide`
   - `hasWakeSignal`
2. `agent.tick.skipped`
   - `tickId`
   - `reason`
   - `gate`
   - `trigger`
   - `positionSide`
3. `agent.scout.held`
   - `tickId`
   - `reason`
   - `summary`
4. `agent.scout.escalated`
   - `tickId`
   - `reason`
   - `summary`
5. `agent.llm.dispatch`
   - `tickId`
   - `phase` (`scout` or `judge`)
   - `model`
   - `maxTurns`
6. `agent.llm.completed`
   - `tickId`
   - `phase`
   - `model`
   - `turnsUsed`
   - `finishReason`
   - `usage` summary if available
7. `agent.tool.call`
   - `tickId`
   - `phase`
   - `toolName`
   - `correlationId`
8. `agent.tool.result`
   - `tickId`
   - `phase`
   - `toolName`
   - `status`
   - `correlationId`
   - bounded `summary`

## Files Expected To Change

### Worker runtime and broker

1. `apps/worker/src/agent.ts`
2. `apps/worker/src/structured-tool-loop.ts`
3. `apps/worker/src/agents/agent-message-broker.ts`
4. `apps/worker/src/agents/agent-protocol.test.ts`

### Domain protocol and config typing

1. `packages/domain/src/agent-protocol.ts`

### Database and repository

1. `packages/db/src/schema/agent-messages.ts`
2. `packages/db/src/agent-repository.ts`
3. `packages/db/drizzle/...` migration and journal files generated via Drizzle

### API mapping and feed contract

1. `apps/api/src/routes/agent-activity-mapper.ts`
2. `apps/api/src/routes/agent-activity-mapper.test.ts`
3. `apps/api/src/routes/agent-activity-types.ts`
4. `apps/api/src/routes/agents.ts` if route typing or selected fields need adjustment

## Implementation Plan

### Slice 1 — Canonicalize protocol naming in the activity mapper

#### Goal

Eliminate stale literal protocol names so feed classification matches the actual protocol catalog.

#### Tasks

1. Replace stale literals in `apps/api/src/routes/agent-activity-mapper.ts` with canonical constants imported from `packages/domain/src/agent-protocol.ts`.
2. Specifically correct mappings for:
   - `agent.send_message` -> `agent.message.send`
   - `platform.decision.accepted` -> `instance.decision.accepted`
   - `platform.tool_result` -> `instance.tool.result`
   - `platform.context_snapshot` -> `instance.context.snapshot`
3. Update `apps/api/src/routes/agent-activity-mapper.test.ts` fixtures to use canonical names.
4. Remove any duplicated literal fallback branches that would permit future drift.

#### Validation

1. Mapper tests pass using canonical constants only.
2. No stale `platform.*` or `agent.send_message` literals remain in the mapper/test path.

#### Exit criteria

- Feed classification is aligned with the protocol catalog before any new runtime events are added.

---

### Slice 2 — Add payload persistence to `agent_messages`

#### Goal

Persist structured protocol payloads so feed rows can display meaningful detail instead of generic labels.

#### Tasks

1. Add a nullable `payload` JSONB column to `packages/db/src/schema/agent-messages.ts`.
2. Generate a Drizzle migration and journal update using `drizzle-kit generate`.
3. Extend the repository insert input type to include `payload`.
4. Update `insertMessage()` in `packages/db/src/agent-repository.ts` to store `payload`.
5. Confirm read paths used by the feed route select the payload field.
6. Keep the payload nullable for backward compatibility with existing rows.

#### Validation

1. Migration applies cleanly.
2. Repository tests or focused DB tests verify payload round-trips.
3. Existing reads of old rows continue to work when `payload` is `null`.

#### Exit criteria

- Protocol rows can carry structured detail into the feed.

---

### Slice 3 — Register new runtime activity message types in the protocol catalog

#### Goal

Define the new event types once, with typed payload schemas and canonical constants.

#### Tasks

1. Add new message constants for the eight runtime activity events in `packages/domain/src/agent-protocol.ts`.
2. Add Zod payload schemas for each event.
3. Add each schema to `MESSAGE_PAYLOAD_SCHEMAS`.
4. Keep field names descriptive and bounded.
5. Avoid embedding raw prompt text, full tool args, or unbounded model output in payloads.

#### Validation

1. Protocol tests assert the new types are accepted by the schema registry.
2. Invalid payloads fail validation.

#### Exit criteria

- The broker can validate the new audit events.

---

### Slice 4 — Teach the broker to accept and persist the new audit events

#### Goal

Make new runtime activity messages flow through the existing consumer/broker pipeline without side effects.

#### Tasks

1. Update `apps/worker/src/agents/agent-message-broker.ts` to classify the new event types as accepted audit events.
2. Persist them through the standard `agent_messages` path with payload included.
3. Mark them `processed` without requiring downstream business actions.
4. Preserve rejection behavior for truly unknown message types.

#### Validation

1. Add focused broker tests that ingest a new audit event and assert:
   - schema validation passes
   - payload is persisted
   - status becomes `processed`
2. Add a negative test for an unknown type that should still be rejected.

#### Exit criteria

- New audit events survive the broker and land in `agent_messages`.

---

### Slice 5 — Add a small runtime activity publisher surface

#### Goal

Give `apps/worker/src/agent.ts` and the structured loop a clean, minimal way to emit activity events without duplicating envelope-building code.

#### Tasks

1. Extract or add a helper that publishes typed runtime activity messages through the existing `publishToInbound` path.
2. Ensure the helper fills common envelope fields consistently:
   - `messageId`
   - `correlationId`
   - `agentId`
   - `actorType`
   - `actorId`
   - `type`
   - `payload`
3. Thread `tickId` and phase context where needed so related rows can be correlated.
4. Keep heartbeats and session-ended behavior unchanged.

#### Validation

1. Add focused tests for helper envelope composition if the helper is extracted.
2. Confirm no existing runtime publications regress.

#### Exit criteria

- Runtime instrumentation can emit protocol events without scattering envelope logic across the file.

---

### Slice 6 — Instrument agent runtime milestones

#### Goal

Publish the curated activity events at the points that matter for operator understanding.

#### Instrumentation points

1. Tick start before major branch work begins.
2. Tick skip immediately before returning from a skip branch.
3. Scout hold when scout decides not to escalate.
4. Scout escalate when scout decides the judge should run.
5. Scout LLM dispatch before invoking the scout loop.
6. Scout LLM completion after the scout loop returns.
7. Judge LLM dispatch before invoking the judge loop.
8. Judge LLM completion after the judge loop returns.
9. Tool call before executing each tool.
10. Tool result after execution returns or fails.

#### Tasks

1. Add `tickId` generation or reuse an existing per-tick correlation value.
2. Capture skip reason and gate name from the current tick-gate decision points.
3. Capture scout hold/escalation reasons from the current scout result path.
4. Instrument `runStructuredToolLoop` or its call sites so phase/model/turn usage is emitted.
5. Instrument tool execution where the actual tool name and result status are known.
6. Ensure emitted payloads are summarized and bounded.

#### Validation

1. Add unit tests or focused integration tests around representative tick paths:
   - skipped tick
   - scout hold
   - scout escalate + judge run
   - tool call + result
2. Confirm emitted event count is reasonable and does not flood the feed with low-value rows.

#### Exit criteria

- A normal active session produces meaningful feed rows without requiring business tools like artifact publication.

---

### Slice 7 — Extend feed typing and mapping for the new event families

#### Goal

Expose the new runtime activity rows through a stable, explicit feed contract.

#### Tasks

1. Extend `apps/api/src/routes/agent-activity-types.ts` with explicit event types for new tick, scout, llm, and tool entries.
2. Update `apps/api/src/routes/agent-activity-mapper.ts` to:
   - classify the new events
   - map payload details into user-facing summaries and metadata
   - continue suppressing heartbeats
3. Ensure payload-null older rows degrade gracefully.
4. Keep presentation logic deterministic and compact.

#### Validation

1. Mapper tests cover each new event family.
2. Route tests verify mixed sources still merge and sort correctly.
3. Older rows without payload still render safely.

#### Exit criteria

- API consumers receive useful typed activity rows for the new events.

---

### Slice 8 — End-to-end route verification

#### Goal

Prove the pipeline works from runtime emission through feed retrieval.

#### Tasks

1. Add an integration-style test that inserts or simulates runtime audit messages and verifies `/agents/:id/activity-feed` returns them.
2. Verify heartbeat-only runs still suppress heartbeats.
3. Verify runtime session rows still appear alongside protocol rows.
4. Verify sort order across `agent_messages`, runtime sessions, outbound messages, and artifacts remains coherent.

#### Validation

1. Focused route test passes.
2. No regressions in current feed behavior for existing event types.

#### Exit criteria

- The anomaly is reproducibly fixed in automated tests.

## Data Model Notes

### `agent_messages.payload`

Recommended shape:

1. Store the validated message payload as JSONB.
2. Keep the full typed payload for audit events, but ensure the payload schema itself is bounded.
3. Do not store raw prompt bodies, chain-of-thought, or large opaque tool responses.
4. Prefer summary fields over raw execution blobs.

### Backfill strategy

1. No historical backfill is required.
2. Existing rows with `payload = null` remain valid and must render gracefully.
3. Feed usefulness improves forward from deployment.

## Testing Plan

### Unit and focused tests

1. Protocol schema tests for new event types and invalid payload rejection.
2. Broker tests for accepted audit-event persistence and unknown-type rejection.
3. Mapper tests for canonical-name fixes and new event-family rendering.
4. Runtime tests for representative instrumentation points.

### Integration tests

1. Feed route returns runtime audit rows plus session rows.
2. Heartbeats remain suppressed.
3. Old rows without payload still render.

### Validation commands

1. `pnpm lint`
2. Focused vitest commands for worker, API, and DB slices touched by this work.
3. If migration tooling is involved, run the relevant Drizzle generation and migration validation command for this repo.

## Rollout Strategy

1. Land canonical-name cleanup first so existing mapping is correct.
2. Land payload persistence and migration second.
3. Land protocol/broker/runtime instrumentation third.
4. Land mapper/feed rendering for new events fourth.
5. Verify on a live or paper agent session that the feed now shows runtime progression without artifact or outbound-message activity.

This ordering reduces ambiguity during rollout because the database and protocol surfaces settle before runtime emission volume increases.

## Risks And Mitigations

1. Risk: event volume becomes noisy.
   Mitigation: keep the event set small, avoid per-log mirroring, and summarize payloads.

2. Risk: payloads grow too large.
   Mitigation: use bounded schemas and store summaries rather than raw outputs.

3. Risk: protocol drift reappears through literal strings.
   Mitigation: import canonical constants in mapper/tests instead of duplicating strings.

4. Risk: old rows without payload break mapper assumptions.
   Mitigation: treat payload as nullable everywhere and add regression tests.

5. Risk: broker changes accidentally alter business-event handling.
   Mitigation: keep new audit-event branches persist-only and regression-test existing protocol types.

## Open Questions

### 1. Should runtime activity events live in `agent_messages` or a separate activity table?

Recommended answer: keep them in `agent_messages` for this feature.

Why:

1. The feed already reads `agent_messages`.
2. The Redis consumer and broker pipeline already exist.
3. The anomaly is caused by underuse of the existing path, not by the wrong table.
4. A separate table adds migration, routing, and query complexity without solving the current problem better.

### 2. Should we store full raw tool outputs and model responses in payload JSON?

Recommended answer: no. Store bounded summaries only.

Why:

1. Raw outputs are often large and noisy.
2. The feed needs operational clarity, not full execution replay.
3. Large payloads increase storage and query cost.
4. Some raw content may be unsuitable for routine operator display.

### 3. Should every skipped tick generate a feed row?

Recommended answer: yes, but only through one curated `agent.tick.skipped` event with compact reason fields.

Why:

1. Skip reasons are one of the main operator questions this feed should answer.
2. A single summarized skip event is high value and still bounded.
3. Heartbeat suppression already removes the main source of low-value noise.

### 4. Should the new protocol constants be grouped under existing message families or a new audit family?

Recommended answer: add a dedicated runtime activity family in `agent-protocol.ts`, but keep the transport and persistence path shared.

Why:

1. The events are observability/audit milestones, not business requests.
2. A dedicated family makes intent obvious and reduces accidental coupling with tool or instance messages.
3. Shared transport still keeps implementation simple.

### 5. Should old stale mapper literals remain as compatibility aliases?

Recommended answer: no.

Why:

1. These names are internal protocol drift, not a public API guarantee.
2. Keeping aliases increases future ambiguity.
3. Backward compatibility is not a constraint here unless explicitly requested.

## Decision Log

1. Reuse the existing inbound protocol pipeline instead of creating a parallel activity event channel.
2. Add payload persistence to `agent_messages` instead of inventing a second event storage path.
3. Treat the new runtime events as persist-only audit events in the broker.
4. Use canonical constants everywhere in mapper and tests.
5. Optimize for operator-readable feed rows, not exhaustive runtime transcript capture.