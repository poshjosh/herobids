# Plan: Agent Stop Cascades to Bots

## Problem

When an agent is stopped (user action or crash), its agent-created bots keep running.
The bots are independent BullMQ instances — there is no FK cascade or lifecycle hook
that ties them to their parent agent.

This was observed live: an agent was stopped via the UI but its bots continued trading
until `maintenance-restart.sh` ran and the worker process restarted (which drained the
BullMQ jobs naturally).

### Affected scenarios

| Scenario | Current behaviour | Target behaviour |
|---|---|---|
| Agent stopped by user | Bots keep running | Bots cascade-stopped within ~5 s |
| Agent container crashes | Bots keep running | Bots cascade-stopped within ~5 s |
| Agent paused | Bots keep running | **No change** — pause is a reasoning pause, not a stop |
| Agent restarted by user | Bots keep running | **No change** — agent restarts, bots already running |
| Worker restart (maintenance) | Bots survive until BullMQ drains | Reconcile sweep catches orphans within 60 s |
| Maintenance restart (planned) | Bots survive agent stop → keep running when agent restarts | Bots stopped during stop phase; agent recreates them on first tick after restart |

### Out of scope

- Bots created by users (`creatorType = 'user'`) — not affected.
- "Restart bots when agent restarts" — not in scope; the agent reasons about this on its next tick.
- User-configurable `onAgentStop` policy — deferred until there is a proven user need.

---

## Solution: A + C

**A — Cascade stop** (immediate): trigger bot stops on both the user-stop path and the
container-crash path.

**C — Reconciliation sweep** (safety net): a periodic sweep that finds running bots
whose creator agent is no longer active and stops them. Catches anything the cascade
missed (worker restart, Redis pub/sub drop, crash mid-cleanup).

### Controlling stop paths in the current codebase

There are two distinct stop/control paths today:

1. `POST /agents/:id/stop` in `apps/api/src/routes/agents.ts` directly marks the
  agent row and active runtime sessions `stopped` in Postgres.
2. Runtime-originated exits flow through worker-owned paths: `session_ended`,
  `AgentSessionManager.stopSession()`, or Docker `onContainerDie`.

Important implication: the API stop path does **not** call
`AgentSessionManager.stopSession()` and therefore does **not** trigger the worker
`onSessionStopped` callback. The worker later notices terminal DB sessions in
`AgentHealthMonitor` and calls `runtimeLauncher.stop(sessionId)` directly.

Because of that, wiring the cascade only into `onSessionStopped` is insufficient for
the UI/API stop flow. This plan therefore uses:

- `AgentHealthMonitor` terminal-session cleanup as the primary user-stop cascade path
- `onSessionStopped` as a supplemental path for runtime-managed stops
- `DockerAgentManager.onContainerDie` as the crash path

To meet the target of stopping bots within ~5 s after a user stop, `AgentHealthMonitor`
must run on the operator-configured worker cadence (`worker.agents.healthCheckIntervalMs`,
default 2000 ms in `config/default.yaml`) rather than its current internal 10 s default.

### Relationship with the existing agent container reconcile

The existing `AgentSessionManager` timer (every 60 s, `containerReconcileIntervalMs`)
calls `agentRuntimeLauncher.reconcile()` which:
- Stops containers for agents no longer active in DB
- Restarts missing containers for agents with `status='active'`

The new bot orphan sweep is a **separate, parallel timer** at the same cadence.
They use mutually exclusive DB conditions and do not conflict:

| Timer | Agent status filter | Action |
|---|---|---|
| Agent container reconcile | `status = 'active'` | Restart missing containers |
| Bot orphan sweep | `status IN ('stopped', 'crashed')` | Stop orphaned bots |

`containerReconcileIntervalMs` is not exposed in operator config (hardcoded to 60 s
in `AgentSessionManager`). The bot sweep interval is added as a peer config key so
both can be tuned together.

### Maintenance restart sequence

With this plan in place, the `maintenance-restart.sh` sequence becomes safe:

1. Script sets agents → `status='stopped'`
2. **Bot orphan sweep fires** → stops their bots (within 60 s at most) ✓
3. Script sets agents → `status='starting'`; container reconcile relaunches them
4. Agent reasons on its first post-restart tick about whether to recreate bots

Step 4 is correct — the agent has full lifecycle authority over its bots. No
automatic bot restart is needed.

---

## Implementation

### Phase 1 — Cascade stop (Option A)

#### 1a. `DockerAgentManagerConfig` — add `onAgentCrashed` callback

**File:** `apps/worker/src/agents/docker-agent-manager.ts`

Add an optional callback to the config interface:

```ts
/** Called after a container crash is confirmed and the DB is updated. */
onAgentCrashed?: (agentId: string) => Promise<void>;
```

Store it in the constructor and call it at the end of `onContainerDie`, after the
`agentRepo.updateAgent` and `platformAlerts.fireAlert` calls, wrapped in try/catch so
a bot-stop failure never blocks crash recording:

```ts
try {
  await this.config.onAgentCrashed?.(agentId);
} catch (err) {
  logger.error({ err, agentId }, 'cascadeStopAgentBots failed after container crash');
}
```

#### 1b. `index.ts` — cascade helper + supplemental runtime-path wiring

**File:** `apps/worker/src/index.ts`

Add a module-scoped helper after `botRepo` is instantiated:

```ts
async function cascadeStopAgentBots(agentId: string): Promise<void> {
  try {
    const agentBots = await botRepo.getBotsByCreator('agent', agentId);
    const runningBots = agentBots.filter((b) => b.status === 'running');
    if (runningBots.length === 0) return;
    logger.info({ agentId, count: runningBots.length }, 'Cascade-stopping agent bots');
    await Promise.allSettled(
      runningBots.map((b) =>
        runtime.stopInstanceDirect(b.id).catch((err: unknown) =>
          logger.error({ err, botId: b.id, agentId }, 'Failed to cascade-stop agent bot'),
        ),
      ),
    );
  } catch (err) {
    logger.error({ err, agentId }, 'cascadeStopAgentBots query failed');
  }
}
```

**Wire into `onSessionStopped`** as a supplemental path for runtime-managed stops
(`stopSession`, runtime `session_ended`, and other session-manager-owned teardowns).

This is **not** the primary UI/API stop path because `POST /agents/:id/stop` updates
DB state directly and bypasses `onSessionStopped` today.

```ts
onSessionStopped: (agentId, sessionId) => {
  // ... existing actor teardown ...

  // Cascade-stop all running bots created by this agent
  cascadeStopAgentBots(agentId).catch((err: unknown) =>
    logger.error({ err, agentId }, 'cascadeStopAgentBots failed in onSessionStopped'),
  );
},
```

**Wire `onAgentCrashed`** when constructing `AgentRuntimeLauncher` in docker mode (covers crash path):

```ts
dockerConfig: {
  ...
  onAgentCrashed: (agentId) => cascadeStopAgentBots(agentId),
}
```

Note: `cascadeStopAgentBots` must be declared before the `AgentRuntimeLauncher`
construction. Move the `botRepo` instantiation and the helper above the launcher init.

#### 1c. `AgentHealthMonitor` — hook the actual UI/API stop cleanup path

**File:** `apps/worker/src/agents/agent-health-monitor.ts`

Add an optional callback to the health-monitor config so the worker can run the bot
cascade when it discovers a terminal session in DB and is about to stop the runtime
handle:

```ts
onTerminalSessionCleanup?: (
  agentId: string,
  sessionId: string,
  status: 'stopped' | 'crashed',
) => Promise<void>;
```

In the existing loop that finds in-memory runtime handles whose DB session is already
terminal, select `agentId` and `status` as well, then call the callback before
`runtimeLauncher.stop(session.id)`:

```ts
for (const session of stoppedSessions) {
  try {
    await this.config.onTerminalSessionCleanup?.(
      session.agentId,
      session.id,
      session.status as 'stopped' | 'crashed',
    );
  } catch (err) {
    logger.error({ err, sessionId: session.id, agentId: session.agentId }, 'Terminal session cleanup callback failed');
  }

  await this.runtimeLauncher.stop(session.id);
}
```

This is the controlling path for `POST /agents/:id/stop` today, because the API route
marks the DB session terminal first and the worker kills the runtime later when the
health monitor notices it.

#### 1d. `index.ts` — wire `AgentHealthMonitor` to config + cascade callback

**File:** `apps/worker/src/index.ts`

The current construction passes `undefined` config to `AgentHealthMonitor`, so it keeps
its internal 10 s default and misses the `~5 s` target. Change that construction to:

```ts
const agentHealthMonitor = new AgentHealthMonitor(
  db,
  sessionManager,
  {
    checkIntervalMs: appConfig.worker.agents.healthCheckIntervalMs,
    onTerminalSessionCleanup: (agentId) => cascadeStopAgentBots(agentId),
  },
  agentRuntimeLauncher,
);
```

This reuses the existing operator-configured 2000 ms cadence for the actual API-stop
cleanup path instead of relying on the class default of 10000 ms.

---

### Phase 2 — Reconciliation sweep (Option C)

#### 2a. `BotRepository` — new query method

**File:** `packages/db/src/repositories.ts`

```ts
/**
 * Returns running bots created by agents that are now stopped or crashed.
 * Used by the bot orphan reconcile sweep.
 */
async listRunningBotsForInactiveAgents(): Promise<{ id: string; creatorId: string }[]> {
  return this.db
    .select({ id: bots.id, creatorId: bots.creatorId })
    .from(bots)
    .innerJoin(agents, eq(bots.creatorId, agents.id))
    .where(
      and(
        eq(bots.creatorType, 'agent'),
        eq(bots.status, 'running'),
        inArray(agents.status, ['stopped', 'crashed']),
      ),
    );
}
```

#### 2b. `config/default.yaml` + config schema — new sweep key

Add a peer key under `worker.agents`, matching the undocumented `containerReconcileIntervalMs`
default of 60 s:

```yaml
worker:
  agents:
    healthCheckIntervalMs: 2000
    botOrphanSweepIntervalMs: 60000  # Bot orphan sweep cadence in ms
```

The typed config schema lives in `packages/domain/src/config/schema.ts`, not in a
worker-local parser. Update `WorkerConfigSchema` there to parse and expose
`appConfig.worker.agents.botOrphanSweepIntervalMs`.

#### 2c. `index.ts` — periodic sweep

**File:** `apps/worker/src/index.ts`

Add a sweep after `sessionManager.start()` (which is the last startup step):

```ts
const botOrphanSweepInterval = setInterval(async () => {
  try {
    const orphans = await botRepo.listRunningBotsForInactiveAgents();
    if (orphans.length === 0) return;
    logger.warn({ count: orphans.length }, 'Bot orphan sweep: stopping bots for inactive agents');
    await Promise.allSettled(
      orphans.map((b) =>
        runtime.stopInstanceDirect(b.id).catch((err: unknown) =>
          logger.error({ err, botId: b.id, creatorId: b.creatorId }, 'Orphan sweep failed to stop bot'),
        ),
      ),
    );
  } catch (err) {
    logger.error({ err }, 'Bot orphan sweep failed');
  }
}, appConfig.worker.agents.botOrphanSweepIntervalMs ?? 60_000);
```

Clear in both SIGTERM and SIGINT handlers:

```ts
clearInterval(botOrphanSweepInterval);
```

---

### Phase 3 — Tests

#### 3a. Unit test — `AgentHealthMonitor` terminal-session cleanup callback

**File:** `apps/worker/src/agents/agent-health-monitor.test.ts`

- Test that when a runtime handle exists and the DB session is already `stopped`, the
  health monitor calls `onTerminalSessionCleanup(agentId, sessionId, 'stopped')`
  before `runtimeLauncher.stop(sessionId)`.
- Test that callback failure is logged but does not block `runtimeLauncher.stop()`.
- Test that user-stop coverage is driven by the configured `checkIntervalMs`, not the
  class default.

#### 3b. Unit test — `onAgentCrashed` callback invoked after container crash

**File:** `apps/worker/src/agents/docker-agent-manager.test.ts`

New `describe` block: `DockerAgentManager — onAgentCrashed callback`

- Test that `onAgentCrashed` is called with the correct `agentId` after `onContainerDie`
  when the agent was in `active` status (i.e., a genuine crash, not a voluntary stop).
- Test that `onAgentCrashed` is **not** called when the agent was already `stopped`
  (voluntary exit path must not double-trigger cascade).

#### 3c. Unit test — `listRunningBotsForInactiveAgents`

**File:** `packages/db/src/__tests__/bot-lifecycle.test.ts`

- Insert an agent (status=`stopped`) + a bot (creatorType=`agent`, status=`running`).
- Assert `listRunningBotsForInactiveAgents()` returns the bot.
- Insert an agent (status=`active`) + a bot (status=`running`).
- Assert the active-agent bot is NOT returned.
- Insert a user-created bot (creatorType=`user`, status=`running`) for a stopped agent.
- Assert the user bot is NOT returned.

#### 3d. Integration smoke test — agent stop cascades to bots

Extend the existing `scripts/ts/agent-trade-test.ts` teardown or create a new
`scripts/ts/agent-bot-cascade-test.ts`:

1. Create agent, start it.
2. Agent creates a bot via `manage_bot`.
3. Assert bot `status = 'running'`.
4. `POST /agents/:id/stop`.
5. Poll: all bots with `creatorType='agent'` and `creatorId=agentId` reach
   `status='stopped'` within 30 s.
6. Assert agent `status = 'stopped'`.

---

## File Change Summary

| File | Change |
|---|---|
| `apps/worker/src/agents/docker-agent-manager.ts` | Add `onAgentCrashed` callback to config; call it in `onContainerDie` |
| `apps/worker/src/agents/agent-health-monitor.ts` | Add `onTerminalSessionCleanup` callback and invoke it on terminal-session cleanup before `runtimeLauncher.stop()` |
| `apps/worker/src/index.ts` | Add `cascadeStopAgentBots` helper; wire into `onSessionStopped`, `onAgentCrashed`, and `AgentHealthMonitor`; pass health-monitor config from `appConfig`; add `botOrphanSweepInterval` driven by config; clear interval in both signal handlers |
| `packages/db/src/repositories.ts` | Add `BotRepository.listRunningBotsForInactiveAgents()` |
| `config/default.yaml` | Add `worker.agents.botOrphanSweepIntervalMs: 60000` |
| `packages/domain/src/config/schema.ts` | Parse `botOrphanSweepIntervalMs` from `worker.agents` |
| `apps/worker/src/agents/agent-health-monitor.test.ts` | Tests for terminal-session cleanup callback |
| `apps/worker/src/agents/docker-agent-manager.test.ts` | Tests for `onAgentCrashed` callback |
| `packages/db/src/__tests__/bot-lifecycle.test.ts` | Tests for `listRunningBotsForInactiveAgents` |

---

## Acceptance Criteria

| # | Criterion |
|---|---|
| AC1 | `POST /agents/:id/stop` → all running agent-created bots reach `status='stopped'` within 5 s |
| AC2 | Agent container crash (`onContainerDie` runtime path) → all running agent-created bots reach `status='stopped'` within 5 s |
| AC3 | Agent paused → bots continue running unchanged |
| AC4 | User-created bots (`creatorType='user'`) are never touched by this feature |
| AC5 | Reconcile sweep detects and stops orphaned agent bots that survived the immediate cascade (e.g. after worker restart or Redis drop) within 60 s |
| AC6 | Cascade stop is idempotent — calling it when bots are already stopped is a no-op |
| AC7 | Cascade stop failure (DB error, queue error) is logged but never blocks agent teardown |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| `stopInstanceDirect` called for a bot whose BullMQ job has already exited | LOW | `stopInstanceDirect` is already idempotent; a missing actor is a no-op |
| UI/API stop bypasses `onSessionStopped` and only flips DB state | MEDIUM | Primary user-stop cascade runs from `AgentHealthMonitor`, which is the actual controlling cleanup path today |
| `onSessionStopped` fires before `cascadeStopAgentBots` completes and the session row is removed, causing the sweep to miss the bot briefly | LOW | Sweep catches it within 60 s |
| Worker restarts between agent stop and cascade | LOW | Reconcile sweep is the safety net for this exact scenario |
| `listRunningBotsForInactiveAgents` is slow on large datasets | LOW | Index already exists on `bots.status` and `bots.creator_type`; query joins are bounded by active-agent count |
| Double-stop if both `onSessionStopped` and `onContainerDie` fire for the same teardown | LOW | `stopInstanceDirect` is idempotent; `onContainerDie` only fires the crash path when agent was not already stopped |
