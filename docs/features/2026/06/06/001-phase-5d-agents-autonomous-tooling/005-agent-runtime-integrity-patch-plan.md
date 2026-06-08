# Agent Runtime Integrity Patch Plan

This document is the concrete follow-on patch plan for the current in-repo Step 6 implementation work.

It addresses four concrete gaps in the current unstaged implementation:

1. agent start reports success before any runtime is actually launched
2. `starting` sessions never age out, so failed launches wedge the agent
3. agent-supplied `contextHash` can diverge from the server-resolved decision context
4. position persistence no longer carries `markSource`

These fixes should land before broader Step 6 expansion. Otherwise the runtime boundary, recovery story, and audit trail stay internally inconsistent.

## Scope

This plan is intentionally narrow.

In scope:

- worker-owned runtime launch orchestration
- truthful session and agent lifecycle state
- canonical context-hash computation and validation
- mark-source propagation on persisted positions
- regression coverage for the above

Out of scope:

- broader tool-policy work
- artifact body storage changes
- bot CRUD or bot runtime introduction
- billing or budget metering
- container hardening beyond wiring the existing launcher abstraction into the runtime lifecycle

## Delivery Shape

Ship this in two patches, not one.

1. Patch A: lifecycle truth and failed-start recovery
2. Patch B: decision-context integrity and audit completeness

This order matters. The lifecycle path is the highest-risk defect because it leaves the system claiming the runtime is alive when nothing is actually running.

## Patch A: Lifecycle Truth And Failed-Start Recovery

### Goal

Make the worker the sole owner of runtime launch and session liveness.

After this patch:

- API `start` means requested and durably recorded, not already alive
- only the worker launches runtimes
- the first valid heartbeat moves a session from `starting` to `running`
- a runtime that never connects times out cleanly and becomes retryable

### Required Behavior Changes

1. `POST /agents/:id/start` must create a `starting` session and leave the agent in `starting`, not `active`.
2. The worker must discover launchable `starting` sessions and call `AgentRuntimeLauncher`.
3. The first successful heartbeat must be the only transition that marks the session `running` and the agent `active`.
4. A `starting` session with no heartbeat before timeout must move to a terminal non-running state and restore the agent to `stopped`.
5. Shutdown and stop flows must stop the tracked runtime handle if it exists.

### File-By-File Changes

#### [apps/api/src/routes/agents.ts](../../../../../apps/api/src/routes/agents.ts)

Change the lifecycle semantics of `/agents/:id/start`.

Exact changes:

- change the agent status transition in the transaction from `stopped -> active` to `stopped -> starting`
- keep inserting `agent_runtime_sessions` with `status = 'starting'`
- return `202` semantics in the handler response shape, with `status: 'starting'` and `sessionId`
- keep the idempotency guard so repeated `start` while already `starting` or `active` fails with `409`
- do not add any runtime-launch side effect in the API layer

Why here:

- the API should record intent and ownership only
- runtime launch belongs to the worker per the canonical runtime-boundary doc

#### [packages/db/src/agent-repository.ts](../../../../../packages/db/src/agent-repository.ts)

Add repository methods for worker-side orchestration and timeout handling.

Exact changes:

- add a `getSessionsByStatuses(statuses: string[])` helper or equivalent worker-facing query
- add a `getLaunchableStartingSessions()` helper that returns `starting` sessions whose agent is still `starting` and whose link is still active
- add a `markSessionRunning(sessionId: string, heartbeatAt: Date)` helper
- add a `markSessionStopped(sessionId: string, stoppedAt: Date)` helper
- add a `markSessionStartTimedOut(sessionId: string, stoppedAt: Date)` helper if you want a distinct status transition path in one method
- add a compare-and-set style update helper if needed so two workers cannot both claim the same `starting` session for launch

Design note:

- prefer a worker-facing helper instead of scattering launch eligibility rules across `index.ts`, `health-monitor.ts`, and `session-manager.ts`

#### [apps/worker/src/agents/agent-runtime-launcher.ts](../../../../../apps/worker/src/agents/agent-runtime-launcher.ts)

Make launcher usage safe for orchestration.

Exact changes:

- make `launch(sessionId)` idempotent by returning the existing handle if the session is already tracked
- add a `hasRuntime(sessionId: string): boolean` helper or equivalent
- keep the current in-memory implementation for MVP, but make its contract explicit enough that the rest of the worker can rely on it

This is still an abstraction layer. No new container implementation is required in this patch.

#### [apps/worker/src/agents/agent-session-manager.ts](../../../../../apps/worker/src/agents/agent-session-manager.ts)

Move the runtime-session truth here.

Exact changes:

- inject `AgentRuntimeLauncher` into the constructor
- replace the current placeholder stale-session logic with two explicit paths:
  - `reconcileStartingSessions()` or equivalent worker loop that launches any eligible `starting` sessions not yet launched
  - `handleStartTimeout(sessionId)` that marks a never-connected session stopped and resets the agent to `stopped`
- update `handleHeartbeat()` so:
  - `starting -> running` happens only on heartbeat
  - `agent.status` becomes `active` only after heartbeat
  - stale runtimes from revoked links are still ignored
- update `stopSession()` so it also stops the launcher handle
- update `handleStopRequest()` so any resolved session stop also tears down the runtime handle
- remove the dead `checkStaleSessions()` stub if the health monitor remains the single caller for timeout detection

Important implementation constraint:

- do not mark a session `running` inside `startSession()` when the session was only just created; that method currently conflates session creation and successful runtime connection

#### [apps/worker/src/agents/agent-health-monitor.ts](../../../../../apps/worker/src/agents/agent-health-monitor.ts)

Extend health checks to cover failed starts.

Exact changes:

- keep the existing stale-`running` heartbeat logic
- add a second query for stale `starting` sessions using `startedAt < threshold`
- route stale `starting` sessions to `sessionManager.handleStartTimeout(session.id)`
- keep `running` heartbeat loss routed to `sessionManager.markUnhealthy(session.id)`

Why this matters:

- the current code only ages out `running` sessions, so a launch that never connects wedges forever

#### [apps/worker/src/index.ts](../../../../../apps/worker/src/index.ts)

Wire the orchestration path.

Exact changes:

- instantiate `AgentRuntimeLauncher`
- pass it into `AgentSessionManager`
- ensure the worker starts the reconciliation loop that discovers and launches `starting` sessions
- ensure shutdown stops the session manager and any tracked runtime handles in a predictable order

Keep the ownership boundary clear:

- API records desired start
- worker launches runtime
- heartbeat proves liveness

#### [packages/db/src/schema/agents.ts](../../../../../packages/db/src/schema/agents.ts)

Update the schema comment to reflect the real state machine.

Exact changes:

- change the status comment from `active, paused, stopped` to `starting, active, paused, stopped` at minimum

No migration is required for this patch because the column is already free-form `text`.

### Tests For Patch A

#### New: [apps/api/src/routes/agents.test.ts](../../../../../apps/api/src/routes/agents.test.ts)

Add API route coverage for lifecycle truth.

Required cases:

1. `POST /agents/:id/start` returns `status = starting` and persists agent status `starting`
2. `POST /agents/:id/start` inserts one `agent_runtime_sessions` row with `status = starting`
3. a second `POST /agents/:id/start` while already `starting` returns `409`
4. `POST /agents/:id/start` still rejects when the user does not own the agent or the linked instance is missing

#### Update: [apps/worker/src/agents/agent-session-manager.test.ts](../../../../../apps/worker/src/agents/agent-session-manager.test.ts)

Expand session-manager behavior coverage.

Required cases:

1. `reconcileStartingSessions()` launches each eligible `starting` session exactly once
2. first heartbeat on a `starting` session transitions session to `running`
3. first heartbeat on a `starting` session transitions agent status to `active`
4. `stopSession()` stops the launcher handle and marks the session stopped
5. `handleStartTimeout()` marks the session stopped and resets the agent to `stopped`
6. heartbeat from a stale or revoked link is ignored

#### New: [apps/worker/src/agents/agent-health-monitor.test.ts](../../../../../apps/worker/src/agents/agent-health-monitor.test.ts)

Add timeout coverage for both lifecycle paths.

Required cases:

1. stale `starting` session triggers `handleStartTimeout`
2. stale `running` session triggers `markUnhealthy`
3. recently-started or recently-heartbeating sessions are ignored

### Validation For Patch A

Run at least:

- `pnpm test -- apps/api/src/routes/agents.test.ts`
- `pnpm test -- apps/worker/src/agents/agent-session-manager.test.ts apps/worker/src/agents/agent-health-monitor.test.ts`
- `pnpm lint`

## Patch B: Decision-Context Integrity And Audit Completeness

### Goal

Make the persisted decision hash, persisted context, and persisted position provenance agree with each other.

After this patch:

- one canonical hash function is used for both strategy-originated and agent-originated decisions
- a non-empty supplied hash is validated against the server-resolved context
- mismatched hashes are rejected with a stable protocol code
- `markSource` is persisted on positions again

### Root-Cause Note

The current implementation already has two different hash algorithms:

- [packages/engine/src/trading-cycle.ts](../../../../../packages/engine/src/trading-cycle.ts) hashes `snapshot + position + strategyConfig`
- [packages/engine/src/decision-intake.ts](../../../../../packages/engine/src/decision-intake.ts) hashes the full `DecisionContext`

Do not patch only the agent path. Replace both with one shared implementation.

### File-By-File Changes

#### New: [packages/engine/src/decision-context-hash.ts](../../../../../packages/engine/src/decision-context-hash.ts)

Introduce one shared canonical hash helper.

Exact changes:

- export `computeDecisionContextHash(context: DecisionContext): string`
- keep the hash input shape identical to the persisted `DecisionContext`
- keep the current digest format consistent with the rest of the repo unless there is a strong reason to change it

Optional but recommended:

- export a small typed error or helper for mismatch validation so the caller can surface a stable rejection code cleanly

#### [packages/engine/src/decision-intake.ts](../../../../../packages/engine/src/decision-intake.ts)

Move decision intake to canonical validation.

Exact changes:

- replace the local `computeDecisionContextHash()` helper with the shared helper from `decision-context-hash.ts`
- always compute the canonical hash from the resolved `DecisionContext`
- if `decision.contextHash` is present and non-empty but does not match the canonical hash, reject the submission before persistence
- persist the canonical hash on the decision and on the decision context row
- pass `markSource: context.referenceMark.source` into `persistPosition(...)`

Recommended error shape:

- use a typed engine error or a stable `code` string such as `decision.context_hash_mismatch`
- do not surface this as a generic `execution_error`

#### [packages/engine/src/trading-cycle.ts](../../../../../packages/engine/src/trading-cycle.ts)

Unify the strategy path with the intake path.

Exact changes:

- build `DecisionContext` before stamping `contextHash`
- compute the decision hash from the shared helper against that `DecisionContext`
- remove the old private `computeContextHash()` implementation
- keep `actorType: system` defaulting as-is

This is the key root-cause fix. Without it, strategy-originated decisions and agent-originated decisions keep using different hash semantics.

#### [packages/engine/src/index.ts](../../../../../packages/engine/src/index.ts)

Export the shared helper and any new typed error if other packages need it.

Exact changes:

- export `computeDecisionContextHash`
- export the typed mismatch error if you introduce one in engine

#### [apps/worker/src/agents/agent-decision-handler.ts](../../../../../apps/worker/src/agents/agent-decision-handler.ts)

Map canonical validation errors into protocol-stable rejection codes.

Exact changes:

- catch the typed mismatch error or inspect the stable engine error code
- emit `instance.decision.rejected` with a stable code such as `context_hash_mismatch`
- keep generic unexpected failures mapped to `execution_error`

Optional diagnostic improvement:

- include bounded mismatch detail in `details`, for example supplied hash versus expected hash, only if that is safe and useful for operator debugging

#### [packages/db/src/repositories.ts](../../../../../packages/db/src/repositories.ts)

No behavioral change is required, but verify that `PositionRepository.upsert(...)` continues to write `markSource` from the input row.

If the input type or comment drifted, align it here. The root regression is upstream in engine, not in the repository.

### Tests For Patch B

#### New: [packages/engine/src/decision-intake.test.ts](../../../../../packages/engine/src/decision-intake.test.ts)

Add direct coverage for the new shared engine boundary.

Required cases:

1. missing `decision.contextHash` is replaced with the canonical hash from the resolved `DecisionContext`
2. matching supplied `contextHash` is accepted
3. mismatched supplied `contextHash` is rejected with stable code `decision.context_hash_mismatch`
4. `persistDecisionContext()` and `persistDecision()` receive the same canonical hash
5. `persistPosition()` receives `markSource = context.referenceMark.source`

Use stubbed persistence and journal dependencies so this test validates the real public function rather than copied helper logic.

#### Update: [packages/engine/src/trading-cycle.test.ts](../../../../../packages/engine/src/trading-cycle.test.ts)

Add strategy-path alignment coverage.

Required cases:

1. `runTradingCycle()` stamps the same hash that `computeDecisionContextHash()` produces for the generated context
2. the refactor does not change the no-decision or risk-rejected behavior already covered in that file

#### Update: [apps/worker/src/agents/agent-decision-handler.test.ts](../../../../../apps/worker/src/agents/agent-decision-handler.test.ts)

Add protocol-facing rejection coverage.

Required cases:

1. engine mismatch error produces `emitDecisionRejected(... code: 'context_hash_mismatch')`
2. generic unexpected intake failure still produces `execution_error`

### Validation For Patch B

Run at least:

- `pnpm test -- packages/engine/src/decision-intake.test.ts packages/engine/src/trading-cycle.test.ts`
- `pnpm test -- apps/worker/src/agents/agent-decision-handler.test.ts`
- `pnpm lint`

## Suggested Merge Order

Use two PRs.

### PR 1

Lifecycle truth and failed-start recovery.

Files expected:

- `apps/api/src/routes/agents.ts`
- `packages/db/src/agent-repository.ts`
- `packages/db/src/schema/agents.ts`
- `apps/worker/src/agents/agent-runtime-launcher.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agents/agent-health-monitor.ts`
- `apps/worker/src/index.ts`
- `apps/api/src/routes/agents.test.ts`
- `apps/worker/src/agents/agent-session-manager.test.ts`
- `apps/worker/src/agents/agent-health-monitor.test.ts`

### PR 2

Shared context hashing, mismatch rejection, and mark-source propagation.

Files expected:

- `packages/engine/src/decision-context-hash.ts`
- `packages/engine/src/decision-intake.ts`
- `packages/engine/src/trading-cycle.ts`
- `packages/engine/src/index.ts`
- `apps/worker/src/agents/agent-decision-handler.ts`
- `packages/db/src/repositories.ts` if type/comment alignment is needed
- `packages/engine/src/decision-intake.test.ts`
- `packages/engine/src/trading-cycle.test.ts`
- `apps/worker/src/agents/agent-decision-handler.test.ts`

## Exit Criteria

This patch plan is complete when all of the following are true:

1. the UI and API never claim an agent is running before a heartbeat proves it
2. a failed launch ages out cleanly and the user can retry `start`
3. one canonical `contextHash` algorithm is used for both strategy and agent submissions
4. mismatched agent-supplied hashes are rejected before persistence or execution
5. persisted positions retain `markSource`
6. the new behavior is covered by automated tests, not only by manual reasoning# Step 6 Concrete Patch Plan: Agent Runtime Integrity

This document turns the current Step 6 review findings into an implementation-ready patch plan against the code that already exists in `apps/api`, `apps/worker`, `packages/engine`, and `packages/db`.

It is intentionally narrower than [004-step-6-implementation-plan.md](./004-step-6-implementation-plan.md). The broader document explains the whole Step 6 workstream. This document explains the next concrete patches needed to make the current agent runtime slice safe, truthful, and testable.

## Canonical Inputs

Use these as the source of truth for this patch sequence:

- [Phase 5 Outline](../../../../features/2026/05/initial/019-phase-5-outline.md)
- [Step 6 Implementation Plan](./004-step-6-implementation-plan.md)
- [Agent Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)

## Scope

This patch plan addresses four concrete problems in the current Step 6 slice:

1. `/agents/:id/start` records success without any worker-owned runtime launch path.
2. `starting` sessions can wedge forever because they never age out.
3. `contextHash` is not canonical because strategy-driven and externally submitted decisions use different hash inputs, and the agent-supplied hash is currently trusted.
4. `markSource` provenance is dropped when positions are persisted through the new shared decision-intake path.

This plan does not widen scope to:

1. bot CRUD or bot runtime behavior
2. generalized tool-marketplace work
3. billing integration for agent cost controls
4. a new orchestration transport for runtime launch if the DB-driven MVP path is sufficient

## Design Choice For MVP

For the fastest safe path to MVP, worker-owned runtime launch should be driven from durable database state, not from a new API-to-worker control channel.

Recommended MVP shape:

1. the API persists intent by creating a `starting` session and moving the agent into a truthful `starting` state
2. the worker periodically reconciles `starting` sessions and launches runtimes through `AgentRuntimeLauncher`
3. the first valid heartbeat transitions the session to `running` and the agent to `active`
4. stale `starting` sessions time out back to `stopped`

Why this is the quickest correct path:

1. it keeps lifecycle authority in the worker, which matches the canonical boundary
2. it avoids inventing a second control transport before the current protocol path is fully stabilized
3. it makes worker restart behavior naturally idempotent because the source of truth is already durable

## Delivery Shape

Ship this as two focused patch sets.

1. Patch Set A: lifecycle truth, runtime launch orchestration, and stale-start recovery
2. Patch Set B: canonical context hashing, stable rejection codes, and mark-source propagation

Do not interleave broader feature work between these two patch sets.

## Patch Set A: Lifecycle Truth And Runtime Orchestration

### Outcome

After Patch Set A:

1. the API no longer claims an agent is active before a runtime exists
2. the worker is the only component that launches or stops runtimes
3. `starting` sessions either become `running` on heartbeat or fall back to `stopped` on timeout
4. restart after a failed launch becomes possible without manual DB repair

### File-By-File Changes

#### `apps/api/src/routes/agents.ts`

Change the lifecycle routes so they report durable intent, not worker success.

Required edits:

1. In `POST /agents/:id/start`:
   - change the agent state written inside the transaction from `active` to `starting`
   - keep creating the `agent_runtime_sessions` row with `status = 'starting'`
   - return `202` semantics in behavior even if the HTTP code stays `200`; the body should report `status: 'starting'`
   - do not claim the agent is `active` until the worker sees a heartbeat
2. Keep the active-link requirement exactly as-is.
3. Keep the compare-and-set guard on `agents.status = 'stopped'` exactly as-is.
4. In the single-agent read route, continue surfacing `starting` sessions in `activeSession` so the UI can render the transition state.
5. Update inline comments so they describe durable intent creation, not runtime success.

Optional but recommended:

1. If `POST /agents/:id/resume` is invoked when there is no live runtime session, either:
   - leave resume unchanged for this patch set, or
   - explicitly move the agent back to `starting` and rely on the worker launch reconciler

Recommendation for MVP:

1. leave resume unchanged in this patch set unless a failing test proves it is currently misleading

#### `packages/db/src/schema/agents.ts`

No schema migration is required because `status` is already a free-form text column.

Required edits:

1. update the comment on `status` to include `starting` in the documented lifecycle states

#### `packages/db/src/agent-repository.ts`

Add the repository methods the worker needs to reconcile startup and timeout state without reimplementing raw queries in the worker layer.

Required additions:

1. `getSessionsByStatuses(statuses: string[])`
2. `getLaunchableStartingSessions()`
   - join or sequence through `agentRuntimeSessions`, `agents`, and `agentInstanceLinks`
   - return only sessions where:
     - session status is `starting`
     - agent status is `starting`
     - the agent still has an active link to the same trading instance
3. `markSessionRunning(sessionId: string, heartbeatAt: Date)`
4. `markSessionStartTimedOut(sessionId: string, stoppedAt: Date)`
5. `markAgentStarting(agentId: string)` only if needed to keep writes centralized
6. `markAgentActive(agentId: string)` if the session manager should not write raw agent updates itself
7. `markAgentStopped(agentId: string)` if the session manager should not write raw agent updates itself

Implementation rule:

1. keep compare-and-set behavior where practical so repeated reconciler loops do not double-launch or regress state

#### `apps/worker/src/agents/agent-runtime-launcher.ts`

Keep this as the worker-owned runtime abstraction, but make it usable in the real lifecycle flow.

Required edits:

1. make `launch(sessionId)` idempotent
   - if the session is already tracked, return the existing handle instead of recording a second launch
2. add a lightweight `hasRuntime(sessionId: string): boolean` helper or equivalent
3. keep `stop` and `kill` idempotent

Important constraint:

1. do not move any trading or DB logic into this class; it stays a pure runtime launcher abstraction

#### `apps/worker/src/agents/agent-session-manager.ts`

Expand this class from heartbeat handling into the worker-owned lifecycle controller described in the Step 6 plan.

Required edits:

1. inject `AgentRuntimeLauncher` into the constructor
2. add a launch reconciliation loop, for example:
   - `reconcileStartingSessions()`
   - called on an interval from `start()`
3. In `reconcileStartingSessions()`:
   - load launchable `starting` sessions from `AgentRepository`
   - launch each session exactly once through `AgentRuntimeLauncher`
   - do not mark it `running` yet
4. In `handleHeartbeat(...)`:
   - when a session is `starting`, update the session to `running`
   - update the owning agent from `starting` to `active`
   - keep the reconnect/bootstrap behavior for `unhealthy` sessions
5. In `stopSession(...)`:
   - stop the runtime via `AgentRuntimeLauncher.stop(sessionId)` before or alongside DB state updates
6. add `handleStartTimeout(sessionId: string)`:
   - mark session `stopped`
   - set `stoppedAt`
   - move the agent back to `stopped`
   - make the method safe to repeat

Important rule:

1. no path should move an agent to `active` before a successful heartbeat

#### `apps/worker/src/agents/agent-health-monitor.ts`

Make startup timeout a first-class failure mode instead of only checking `running` heartbeats.

Required edits:

1. continue scanning `running` sessions whose `lastHeartbeatAt` is stale and mark them `unhealthy`
2. also scan `starting` sessions whose `startedAt` is older than the configured timeout
3. for stale `starting` sessions, call `sessionManager.handleStartTimeout(session.id)`

Recommended config shape:

1. keep one timeout value for MVP if that is simplest
2. if the implementation stays clean, split into:
   - `startTimeoutMs`
   - `heartbeatTimeoutMs`

#### `apps/worker/src/index.ts`

Wire the worker bootstrap to the new lifecycle shape.

Required edits:

1. instantiate `AgentRuntimeLauncher`
2. pass it into `AgentSessionManager`
3. ensure `sessionManager.start()` also begins startup reconciliation, not just heartbeat monitoring
4. ensure shutdown stops the session manager before process exit, as it already does

No new API-to-worker transport is required in this patch set.

#### `apps/web/src/lib/api-client.ts`

Required edits:

1. update the `agents.start()` response type to expect `status: 'starting' | 'active' | string`

#### `apps/web/src/features/agents/AgentDetailPage.tsx`

Keep the UI simple, but make the new transition state visible.

Required edits:

1. render `starting` in the existing status badge flow
2. when the agent is `starting`, replace the start button with a disabled `Starting...` action or no action
3. keep the page minimal; do not add advanced controls in this patch set

### Test Cases For Patch Set A

#### New file: `apps/api/src/routes/agents.test.ts`

Add route-level tests for truthful lifecycle state.

Required cases:

1. `POST /agents/:id/start` returns `status: 'starting'`
2. `POST /agents/:id/start` writes agent status `starting`, not `active`
3. `POST /agents/:id/start` inserts exactly one `starting` session
4. repeating `POST /agents/:id/start` while already `starting` or `active` returns conflict

#### Update: `apps/worker/src/agents/agent-session-manager.test.ts`

Add lifecycle-controller tests.

Required cases:

1. `reconcileStartingSessions()` launches each startable session exactly once
2. a heartbeat for a `starting` session transitions session `starting -> running`
3. the same heartbeat transitions agent `starting -> active`
4. `stopSession()` stops the runtime handle and marks the session stopped
5. `handleStartTimeout()` moves a wedged start back to `stopped`

#### New file: `apps/worker/src/agents/agent-health-monitor.test.ts`

Add timeout coverage for both startup and steady-state health.

Required cases:

1. stale `starting` session calls `handleStartTimeout`
2. stale `running` session calls `markUnhealthy`
3. fresh sessions are ignored

#### Optional update: `apps/web/src/features/agents/AgentDetailPage.tsx` test coverage

Only add this if the web test harness is already in use for route/detail components.

Required case if implemented:

1. `starting` status renders without exposing a second start action

### Validation For Patch Set A

Run at minimum:

1. `pnpm test -- apps/api/src/routes/agents.test.ts`
2. `pnpm test -- apps/worker/src/agents/agent-session-manager.test.ts`
3. `pnpm test -- apps/worker/src/agents/agent-health-monitor.test.ts`
4. `pnpm lint`

## Patch Set B: Canonical Context Hashing And Mark Provenance

### Outcome

After Patch Set B:

1. all decisions persist a platform-canonical `contextHash`
2. strategy-originated and agent-originated decisions use the same hash algorithm
3. agent-supplied hash mismatches are rejected with a stable code before execution
4. persisted positions retain the reference mark source used during execution

### Root Cause To Fix

The current code has two separate hash algorithms:

1. `runTradingCycle()` hashes `{ snapshot, position, strategyConfig }`
2. `submitDecisionForExecution()` hashes the serialized `DecisionContext`

That means the strategy path and the external decision-intake path are already inconsistent even before agent-supplied hashes are considered.

The fix must be one shared hash builder, not another local patch.

### File-By-File Changes

#### New file: `packages/engine/src/decision-context-hash.ts`

Create one shared helper for canonical context hashing.

Required contents:

1. a function that normalizes the hash input shape
2. a function that computes the hash from the normalized shape
3. exported types if they help keep `trading-cycle.ts` and `decision-intake.ts` aligned

Canonical input should be the decision context actually persisted with the decision, including:

1. snapshot
2. position or `null`
3. reference mark
4. strategy parameters

#### `packages/engine/src/decision-intake.ts`

Make this file the integrity gate for all externally submitted decisions.

Required edits:

1. replace the local `computeDecisionContextHash()` helper with the shared helper
2. always compute the canonical context hash from the supplied `DecisionContext`
3. if `decision.contextHash` is present and does not match the canonical hash:
   - throw a typed validation error such as `DecisionIntakeValidationError`
   - attach a stable code such as `decision.context_hash_mismatch`
4. if `decision.contextHash` is missing, stamp the canonical hash onto the persisted decision
5. persist the canonical hash in both the decision row and the decision-context row
6. when persisting the resulting position, include `markSource: context.referenceMark.source`

Important rule:

1. do not silently accept a mismatched agent-supplied hash and overwrite it without surfacing the mismatch

#### `packages/engine/src/trading-cycle.ts`

Unify the strategy path with the same canonical hash implementation.

Required edits:

1. build the `DecisionContext` first
2. compute `contextHash` from that context using the new shared helper
3. delete the current private `computeContextHash(snapshot, position, strategyConfig)` helper
4. stamp strategy-originated decisions with the canonical hash before calling `submitDecisionForExecution(...)`

Result:

1. strategies and agents use the same persisted hash semantics

#### `packages/engine/src/index.ts`

Required edits:

1. export the new shared hash helper
2. export the typed intake validation error if the worker layer needs it

#### `apps/worker/src/agents/agent-decision-handler.ts`

Convert engine-side integrity failures into stable protocol rejections.

Required edits:

1. catch the typed context-hash mismatch error separately from generic execution failures
2. emit `instance.decision.rejected` with:
   - `code: 'context_hash_mismatch'` or the exact canonical code chosen in the engine
   - `retryable: false`
3. keep generic unexpected failures mapped to `execution_error`

Optional but recommended:

1. include both the supplied and canonical hash in `details` if that can be done without widening the public contract more than necessary

#### `packages/domain/src/models/decision.ts`

No schema change is required, but the comment on `contextHash` should make the ownership rule explicit.

Required edit:

1. clarify that the persisted value is the platform-canonical hash of the decision context

### Test Cases For Patch Set B

#### New file: `packages/engine/src/decision-intake.test.ts`

Add direct engine tests for canonical hashing and mark provenance.

Required cases:

1. missing `decision.contextHash` is replaced with the canonical hash
2. matching `decision.contextHash` is accepted unchanged
3. mismatched `decision.contextHash` throws a typed validation error with the stable code
4. `persistDecisionContext()` and `persistDecision()` receive the same canonical hash
5. `persistPosition()` receives `markSource = context.referenceMark.source`

#### Update: `packages/engine/src/trading-cycle.test.ts`

Add a regression test proving the strategy path uses the same hash semantics.

Required case:

1. a strategy-originated decision and the resulting persisted context share the same canonical hash

#### Update: `apps/worker/src/agents/agent-decision-handler.test.ts`

Add protocol-facing rejection behavior.

Required cases:

1. context-hash mismatch becomes `emitDecisionRejected(... code: 'context_hash_mismatch')`
2. unexpected intake failures still become `execution_error`

### Validation For Patch Set B

Run at minimum:

1. `pnpm test -- packages/engine/src/decision-intake.test.ts`
2. `pnpm test -- packages/engine/src/trading-cycle.test.ts`
3. `pnpm test -- apps/worker/src/agents/agent-decision-handler.test.ts`
4. `pnpm lint`

## Sequencing Rules During Implementation

Apply these rules while coding the patches:

1. Patch Set A lands first.
2. After the first substantive lifecycle edit, the first validation should be the narrow route or session-manager test that proves the API no longer reports `active` prematurely.
3. Patch Set B should not start until Patch Set A has passing lifecycle tests.
4. The shared context-hash helper must be introduced before tightening mismatch rejection, otherwise strategy-originated decisions may fail incorrectly.
5. Keep all runtime launch responsibility in the worker. Do not let the API instantiate or directly control `AgentRuntimeLauncher`.

## Explicit Non-Changes For These Patches

To keep the slice tight, do not roll these into the same work:

1. object-storage bodies for agent artifacts
2. bot entity introduction
3. new billing-plan limits beyond what is already in progress
4. generalized runtime scheduling over Redis Streams or another control plane
5. broad UI redesign beyond showing truthful `starting` state

## Exit Criteria

This concrete patch plan is complete when all of the following are true:

1. starting an agent creates a truthful `starting` state and only becomes `active` after heartbeat
2. stale startup attempts fall back to `stopped` automatically
3. externally submitted decisions cannot persist a non-canonical `contextHash`
4. strategy-originated and agent-originated decisions share the same persisted hash semantics
5. persisted positions retain the reference mark source used during execution
6. the automated tests named in this document pass together with `pnpm lint`