# Bug: Mismatch Between Agent And Runtime State

## Status

`draft`

## Purpose

Fix the lifecycle inconsistency where an agent can be marked `crashed` while its runtime session is persisted as `stopped`, causing the API and activity feed to describe an abnormal shutdown as graceful.

This plan also addresses the related duplicate-crash-handling risk where an abnormal but orderly self-shutdown can be classified once from `agent.runtime.session_ended` and again when the delayed Docker die event arrives.

## Problem Summary

The current runtime lifecycle model mixes two different notions of terminal state:

- **Agent state**: high-level lifecycle status on `agents.status`
- **Runtime session state**: per-container lifecycle status on `agent_runtime_sessions.status`

Today, those two layers can diverge.

### Current behaviour

1. The runtime shuts down through [apps/worker/src/agent.ts](apps/worker/src/agent.ts#L1191) and publishes `agent.runtime.session_ended` with a `reasonCode`.
2. The message broker in [apps/worker/src/agents/agent-message-broker.ts](apps/worker/src/agents/agent-message-broker.ts#L263) maps that reason code to agent status:
   - planned reasons -> `stopped`
   - anything else -> `crashed`
3. The same broker path then calls `retireActiveSessions()`.
4. [packages/db/src/agent-repository.ts](packages/db/src/agent-repository.ts#L259) implements `retireActiveSessions()` by always marking active runtime sessions as `stopped`.
5. The activity feed mapper in [apps/api/src/routes/agent-activity-mapper.ts](apps/api/src/routes/agent-activity-mapper.ts#L315) interprets `session.status === 'stopped'` as a graceful shutdown.

So for an abnormal self-shutdown such as `tool.failed`, the system currently records:

- agent status = `crashed`
- runtime session status = `stopped`
- activity feed = "Session stopped" / "Agent runtime shut down gracefully"

That is the mismatch.

## Why This Matters

### 1. UI and reporting become misleading

The API can show a crashed agent while the session timeline presents a graceful stop. This confuses operators and makes incident reports harder to trust.

### 2. Terminal-state semantics are inconsistent

The database schema already supports both `stopped` and `crashed` on runtime sessions, but the common retirement helper erases that distinction.

### 3. Delayed Docker events can duplicate crash handling

The Docker die handler in [apps/worker/src/agents/docker-agent-manager.ts](apps/worker/src/agents/docker-agent-manager.ts#L323) skips only when the current agent status is `stopped`.

If the broker already classified an abnormal self-shutdown as `crashed`, a later Docker die event will still run crash handling again, even though the abnormal termination was already recorded. That can duplicate alerts, logs, and side effects.

## Goals

After this work:

- Agent status and runtime session status represent the same terminal outcome.
- Graceful stops remain `stopped` at both levels.
- Abnormal runtime termination becomes `crashed` at both levels.
- Activity feed entries match the actual terminal state.
- Docker die handling is idempotent when shutdown has already been fully recorded.

## Non-Goals

- Reworking all agent lifecycle states
- Changing public API schemas
- Changing how the agent decides whether a shutdown reason is planned vs unplanned
- Reworking Docker event streaming itself

## Root Cause

The root cause is that the repository helper `retireActiveSessions()` encodes only one terminal outcome: `stopped`.

That helper is currently used in two places with different semantics:

1. Graceful/voluntary shutdown handling
2. Unexpected container death / abnormal shutdown handling

Those two paths should not share the same terminal-state write.

## Plan

### Workstream 1. Introduce status-aware runtime-session retirement

#### Goal

Allow runtime session terminal status to be written as either `stopped` or `crashed`, depending on the shutdown path.

#### Changes

In [packages/db/src/agent-repository.ts](packages/db/src/agent-repository.ts#L259):

1. Keep `retireActiveSessions()` only if it remains a thin convenience wrapper for the graceful case.
2. Add a new explicit helper, for example:

```ts
retireActiveSessionsWithStatus(agentId: string, status: 'stopped' | 'crashed', stoppedAt?: Date)
```

This helper should:

- update all active/non-terminal sessions for the agent
- set `status` to the requested terminal status
- set `stoppedAt`

#### Rationale

The persistence layer should preserve terminal-state intent instead of collapsing all terminal transitions into `stopped`.

### Workstream 2. Use status-aware session retirement in broker session-ended handling

#### Goal

Keep agent status and runtime session status aligned when the runtime self-reports its own shutdown.

#### Changes

In [apps/worker/src/agents/agent-message-broker.ts](apps/worker/src/agents/agent-message-broker.ts#L263):

1. Keep the existing `plannedReasonCodes` classification unless product wants to expand that list separately.
2. After computing:

```ts
const status = plannedReasonCodes.has(payload.reasonCode ?? '') ? 'stopped' : 'crashed';
```

use the new repository helper to retire runtime sessions with the same terminal status.

Expected behaviour:

- `SIGTERM`, `SIGINT`, `pause_requested`, `stop_requested`, `wall_clock_expired` -> agent `stopped`, session `stopped`
- `tool.failed` and similar abnormal reasons -> agent `crashed`, session `crashed`

#### Rationale

If the runtime says it ended abnormally, the runtime session should not be persisted as graceful.

### Workstream 3. Use status-aware session retirement in Docker die handling

#### Goal

Ensure container-death handling records runtime sessions as `crashed`, not `stopped`.

#### Changes

In [apps/worker/src/agents/docker-agent-manager.ts](apps/worker/src/agents/docker-agent-manager.ts#L330):

replace the current call to `retireActiveSessions(agentId)` with the status-aware crashed variant.

Expected behaviour on unexpected container death:

- agent status -> `crashed`
- active runtime sessions -> `crashed`
- activity feed -> crash/failure event, not graceful stop

### Workstream 4. Make crash handling idempotent after already-recorded abnormal termination

#### Goal

Avoid duplicate crash alerts and duplicate terminal processing when an abnormal shutdown has already been recorded before the Docker die event arrives.

#### Changes

In [apps/worker/src/agents/docker-agent-manager.ts](apps/worker/src/agents/docker-agent-manager.ts#L323), expand the guard beyond only `currentAgent?.status === 'stopped'`.

Recommended idempotency checks:

1. If the current agent status is already `crashed` **and** there is no active runtime session left, skip duplicate crash handling.
2. If needed, inspect the latest runtime session for the agent and skip if it is already terminal (`stopped` or `crashed`) and the active session has already been retired.

Possible shape:

```ts
const currentAgent = await this.agentRepo.getAgent(agentId);
const activeSession = await this.agentRepo.getActiveSession(agentId);
if ((currentAgent?.status === 'stopped' || currentAgent?.status === 'crashed') && !activeSession) {
  logger.info({ agentId, reason }, 'Agent container exit already recorded — skipping duplicate terminal handling');
  return;
}
```

The exact condition should use the repository methods already available, or add a small helper if needed.

#### Rationale

A delayed Docker event should not re-fire crash handling when the abnormal termination was already recorded by the broker.

### Workstream 5. Fix activity-feed semantics

#### Goal

Make the activity timeline describe the runtime session accurately.

#### Changes

In [apps/api/src/routes/agent-activity-mapper.ts](apps/api/src/routes/agent-activity-mapper.ts#L292):

1. Keep `session.status === 'crashed'` mapped to a critical runtime failure entry.
2. Keep `session.status === 'stopped'` mapped to a graceful stop entry.
3. No behavioural change is needed here if workstreams 1–3 are done correctly.
4. Validate the existing event types and titles while touching the mapper:
   - `runtime.failed` for crashed sessions is correct
   - `runtime.started` used for stopped sessions looks suspicious; evaluate whether that event type should instead be `runtime.stopped`

#### Rationale

The mapper is mostly correct already. The real fix is to feed it correct session status.

### Workstream 6. Tighten comments and lifecycle documentation in code

#### Goal

Prevent future regressions by making the intended contract obvious.

#### Changes

Update comments in:

- [apps/worker/src/agents/agent-message-broker.ts](apps/worker/src/agents/agent-message-broker.ts#L263)
- [apps/worker/src/agents/docker-agent-manager.ts](apps/worker/src/agents/docker-agent-manager.ts#L318)
- [packages/db/src/agent-repository.ts](packages/db/src/agent-repository.ts#L259)

Clarify:

- `stopped` means graceful/planned terminal state
- `crashed` means abnormal terminal state
- session retirement helpers must preserve that distinction
- Docker die handling is a fallback detector and must be idempotent when broker/session-ended handling already recorded the terminal outcome

## Tests

### Repository tests

Add or update tests for [packages/db/src/agent-repository.ts](packages/db/src/agent-repository.ts):

1. retiring active sessions with `stopped` marks them `stopped`
2. retiring active sessions with `crashed` marks them `crashed`
3. already-terminal sessions are not changed

### Broker tests

Add or update tests for `agent.runtime.session_ended` handling:

1. `reasonCode = SIGTERM` -> agent `stopped`, session `stopped`
2. `reasonCode = tool.failed` -> agent `crashed`, session `crashed`
3. `reasonCode = wall_clock_expired` -> confirm expected product behaviour (currently planned -> `stopped`)

### Docker manager tests

Add or update tests for `onContainerDie()`:

1. agent already `stopped` -> skip crash handling
2. agent already `crashed` and no active session -> skip duplicate crash handling
3. running/active session dies unexpectedly -> agent `crashed`, session `crashed`, alert fired once

### API/activity tests

Add or update activity-mapper or route tests:

1. `session.status = stopped` -> graceful stop entry
2. `session.status = crashed` -> runtime failed entry
3. end-to-end case where abnormal self-shutdown no longer appears as graceful stop

## Files Likely Affected

| File | Expected change |
|---|---|
| `packages/db/src/agent-repository.ts` | add status-aware session retirement helper |
| `apps/worker/src/agents/agent-message-broker.ts` | use terminal status for both agent and runtime session |
| `apps/worker/src/agents/docker-agent-manager.ts` | mark runtime sessions as crashed on unexpected die; add idempotency guard |
| `apps/api/src/routes/agent-activity-mapper.ts` | validate event semantics; possibly rename graceful stop event type |
| related test files | add coverage for graceful vs abnormal terminal-state alignment |

## Risks

1. If the idempotency guard is too broad, a genuinely missed crash could be ignored.
2. If the new session-retirement helper is used incorrectly, some code paths may stop updating `stoppedAt`.
3. If downstream UI implicitly relied on the old mismatch, correcting session status may change displayed history for existing incidents.

## Open Questions

1. Should `wall_clock_expired` remain classified as `stopped`, or is it semantically closer to a forced/system shutdown that deserves its own terminal state in the future?
2. Should the activity entry for graceful stop use event type `runtime.started`, or should that be corrected while this work is being touched?
3. Do we want to persist an explicit terminal reason on runtime sessions in the future, rather than infer from agent status and alerts?

## Recommendation

Implement in this order:

1. add status-aware runtime-session retirement in the repository
2. update broker `session_ended` handling to keep agent/session terminal states aligned
3. update Docker die handling to record crashed sessions and skip duplicate terminal handling
4. update tests
5. optionally clean up the activity event type for graceful stop while in the area

That sequence addresses the core persistence bug first, then removes the duplicate-crash side effects, and finally tightens the presentation layer.