# 003 — Plan: Agent Crash-Path Redis Cleanup & Cross-Session Crash-Loop Guard

- **Status:** Done
- **Date:** 2026-07-25
- **Author:** AI agent
- **Trigger:** Staging evaluation showed crashed agents (range, swing) leaving orphaned Redis state and repeatedly crashing with no cross-session guard.

---

## 1. Problem statement

Two independent defects were observed after crashes on staging.

### 1.1 Crashed agents leak Redis session state

An agent's presence in Redis is projected by the session manager so the market monitor knows who to wake:

- `agent:sessions:active` (SET) — agent IDs the monitor may push wakes to
- `agent:sessions:count:<agentId>` (STRING) — ref count of active sessions
- `agent:wake:prefs:<agentId>` (STRING) — wake subscriptions

This projection is torn down **only** on the two graceful termination paths:

- `AgentSessionManager.stopSession()` — user/operator stop
- `AgentSessionManager.handleRuntimeSessionEnd()` — runtime-reported `session_ended`

The **hard-crash path is not covered.** When a container dies without a graceful farewell, `DockerAgentManager.onContainerDie()` marks the DB sessions/agent crashed and fires a `RUNTIME_FAILED` alert, but it never touches the Redis projection. The wired `onAgentCrashed` callback only calls `cascadeStopAgentBots(agentId)`. Result:

- the crashed agent stays in `agent:sessions:active` indefinitely
- the market monitor keeps pushing wake messages to `agent:inbound:<agentId>`, a stream no consumer is draining
- `agent:sessions:count:<agentId>` and `agent:wake:prefs:<agentId>` remain forever

This is the primary observed lapse.

### 1.2 No cross-session crash-loop guard

Within-session resilience exists (`SessionCircuitBreaker`), but its counters are in-process and reset when the container dies. There is no state that survives a crash to answer: "this agent has crashed N times in M minutes — stop relaunching it." Nothing blocks a fresh launch of an agent that is crash-looping, and no operator alert distinguishes a one-off crash from a loop.

### 1.3 Scope

| In scope | Out of scope |
|---|---|
| Clean the Redis session projection on the crash path | Automatic restart/backoff orchestration |
| Delete genuinely-ephemeral runtime keys on every terminal path | Deleting durable product state (memory, tasks, reminders, watches) |
| Persist a cross-session crash counter and block relaunch while looping | A persistent crash-history table |
| Fire a distinct crash-loop platform alert | A background `SCAN` reconciler over all `agent:*` keys |

---

## 2. Verified current state (do not re-solve solved problems)

Before implementing, note what the code already does. Confirmed by reading the source on 2026-07-25.

### 2.1 Keys that are already bounded — leave their write sites alone

| Key | Current protection | Source |
|---|---|---|
| `agent:inbound:<id>` / `agent:outbound:<id>` | `XADD ... MAXLEN ~ AGENT_STREAM_MAXLEN` | `agent.ts`, `agent-reconnect-handler.ts`, `instance-event-publisher.ts` |
| `agent:prompt:<id>`, `agent:prompt:scout:<id>`, `agent:prompt:user-context:<id>`, `agent:prompt:judge-user-context:<id>`, `agent:prompt:hybrid:<id>` | `SET ... EX 3600` | `agent.ts` (~L2585, ~L2885–2888) |
| `agent:scanner:fingerprint:<id>` | `SET ... EX <ttlSeconds>` (default 600) | `agent-trading-actor.ts` (~L1665) |
| `agent:scanner_gated:<id>` | `SET ... EX 86400` | `agent.ts` |
| `market-monitor:rate:<id>:<family>` | `EXPIRE key 60` | `market-intelligence/monitor.ts` (~L1024) |
| `herobids:actor-health:agent:<id>` | `EX 120` (`ACTOR_HEALTH_TTL_SECONDS`) | actor-health publisher |
| `agent:billing:notified:<id>` | `SET ... EX 86400` | `agent-message-broker.ts` |

### 2.2 Keys that are durable product state — must NOT be deleted or TTL'd

These are documented in tool descriptions as surviving restarts. Touching them is silent data loss.

- `agent:memory:<id>` — "persists across ticks and survives agent restarts" (`tools/memory.ts`)
- `agent:tasks:<id>` — "Tasks persist across ticks and survive restarts" (`tools/tasks.ts`)
- `agent:reminders:<id>` — scheduled future work (`reminder-coordinator.ts`, `tools/tasks.ts`)
- `agent:watches:<id>` — active SL/TP watches; may be needed after a manual restart (`tools/watch.ts`)
- `agent:watches:notified:<id>` — escalation dedup (already gets a 24h TTL where used)

### 2.3 The only genuinely unbounded, ephemeral key

- `agent:watches:summary:<id>` (HASH, single `summary` field) — set by `market-intelligence/monitor.ts` (~L217) and `tools/watch.ts`; **no TTL, no cleanup.**

### 2.4 Session projection is ref-counted

`agent:sessions:count:<id>` is incremented on first-boot heartbeat (`handleHeartbeat`, ~L699) and decremented on graceful termination; projection is cleared only when the count reaches 0. Any change must preserve multi-session correctness on the graceful paths. On the **crash** path, `onContainerDie` retires **all** active sessions for the agent (`retireActiveSessionsWithStatus(agentId, 'crashed')`), so crash cleanup should clear the projection **fully**, not decrement.

### 2.5 Two terminal crash paths exist

1. `DockerAgentManager.onContainerDie()` — container death fallback (hard crash, reconcile-no-container).
2. `AgentSessionManager.handleRuntimeSessionEnd(..., 'crashed')` — runtime self-reported crash farewell.

`onContainerDie` already dedupes against an already-recorded crash (`status === 'crashed' && !currentSession`). Crash accounting must still be idempotent if both fire for one crash.

---

## 3. Design

### 3.1 Ephemeral cleanup helper

**New file:** `apps/worker/src/agents/agent-ephemeral-redis-cleanup.ts`

```typescript
import type { Redis } from 'ioredis';

/**
 * Best-effort deletion of an agent's ephemeral runtime Redis keys.
 * Idempotent (DEL ignores missing keys). Never throws — errors are logged.
 * Does NOT touch the ref-counted session projection, nor durable product
 * state (memory / tasks / reminders / watches).
 */
export async function cleanupEphemeralAgentRedisState(
  redis: Redis,
  agentId: string,
): Promise<void>;
```

Deletes exactly these keys via a single pipeline:

```
agent:inbound:<agentId>
agent:outbound:<agentId>
agent:prompt:<agentId>
agent:prompt:scout:<agentId>
agent:prompt:user-context:<agentId>
agent:prompt:judge-user-context:<agentId>
agent:prompt:hybrid:<agentId>
agent:scanner:fingerprint:<agentId>
agent:scanner_gated:<agentId>
agent:watches:summary:<agentId>
herobids:actor-health:agent:<agentId>
```

Notes for the implementer:
- Streams and most string keys above already self-expire; deleting them on termination is an immediacy optimization, not the correctness fix. Deleting them is cheap and keeps a crashed agent's footprint at zero.
- `market-monitor:rate:<agentId>:<family>` is intentionally omitted: it self-expires in 60 s and the family suffix is dynamic (would require a per-agent `SCAN`, not worth it).
- Wrap the whole pipeline in `try/catch`; log at `warn` on failure. Return `void`.

### 3.2 Fix the crash path — clear the session projection on crash

**Add a method to `AgentSessionManager`:**

```typescript
/**
 * Called when an agent crashes (all its sessions have been retired as 'crashed').
 * Fully clears the Redis session projection and ephemeral runtime keys, then
 * records the crash for the cross-session crash-loop guard.
 */
async handleAgentCrashed(agentId: string, sessionId?: string): Promise<void>;
```

Behavior:
1. If `this.redis` is set:
   - `SREM agent:sessions:active <agentId>`
   - `DEL agent:sessions:count:<agentId>`
   - `DEL agent:wake:prefs:<agentId>`
   - `await cleanupEphemeralAgentRedisState(this.redis, agentId)`
   - `await recordCrashAndCheckBlock(...)` (see §3.4) and, if the agent transitioned into the blocked state, fire the crash-loop alert (see §3.5)
2. All Redis work is best-effort (try/catch, log, never throw).

Rationale for unconditional projection clear (not decrement): a container crash retires every active session for the agent, so the correct post-state is "no active sessions". Decrementing would be wrong and could leave a stale positive count.

**Wire it from the crash path** in `apps/worker/src/index.ts` (~L528):

```typescript
onAgentCrashed: async (agentId) => {
  await cascadeStopAgentBots(agentId);
  await sessionManager.handleAgentCrashed(agentId);
},
```

`onAgentCrashed` currently receives only `agentId`. That is sufficient for projection cleanup. For crash-guard session dedup (§3.4) the session id is optional; when absent, the guard falls back to a timestamp-based member.

### 3.3 Graceful paths — delete ephemeral keys when the last session ends

Keep the existing ref-count logic in `stopSession()` (~L539) and `handleRuntimeSessionEnd()` (~L587). Inside the existing `if (count <= 0) { ... }` block — after the current `SREM` / `DEL wake:prefs` / `DEL count` — add:

```typescript
await cleanupEphemeralAgentRedisState(this.redis, agentId);
```

Do **not** call the helper when `count > 0` (a sibling session is still live and owns the shared surfaces).

### 3.4 Start-timeout — delete ephemeral keys, do not touch the ref count

In `handleStartTimeout()` (~L818), after `runtimeLauncher.stop(sessionId)` and the status update, add:

```typescript
if (this.redis) {
  await cleanupEphemeralAgentRedisState(this.redis, session.agentId);
}
```

Do **not** decrement `agent:sessions:count` here: a timed-out session may never have reached first-boot heartbeat, so it may never have incremented the counter. Decrementing would drive the count negative and permanently suppress future graceful cleanup.

### 3.5 Cross-session crash-loop guard

**New file:** `apps/worker/src/agents/agent-crash-loop-guard.ts`

Sliding-window crash counter in Redis, deduped by session id.

```typescript
export interface CrashLoopGuardConfig {
  enabled: boolean;
  maxCrashesInWindow: number;
  windowMs: number;
}

export interface CrashRecordResult {
  crashCount: number;
  blocked: boolean;
}

/** Record a crash and return the current in-window count + whether the agent is now blocked. */
export async function recordCrashEvent(
  redis: Redis,
  agentId: string,
  sessionId: string | undefined,
  cfg: CrashLoopGuardConfig,
  nowMs: number,
): Promise<CrashRecordResult>;

/** Read-only check used by the launch gate. */
export async function isCrashLaunchBlocked(
  redis: Redis,
  agentId: string,
  cfg: CrashLoopGuardConfig,
  nowMs: number,
): Promise<boolean>;
```

Redis structure — one ZSET per agent:

- key: `agent:crash:events:<agentId>`
- member: `sessionId` when known, else `nosession:<nowMs>`
- score: `nowMs`

`recordCrashEvent` algorithm:
1. `ZADD agent:crash:events:<agentId> <nowMs> <member>` (same session id ⇒ same member ⇒ no double count if both terminal paths fire).
2. `ZREMRANGEBYSCORE agent:crash:events:<agentId> -inf (nowMs - windowMs)`.
3. `crashCount = ZCARD agent:crash:events:<agentId>`.
4. `PEXPIRE agent:crash:events:<agentId> windowMs` (so the key self-cleans after the window).
5. `blocked = crashCount >= maxCrashesInWindow`.

`isCrashLaunchBlocked` runs steps 2–3 (prune + count, no add) and returns `crashCount >= maxCrashesInWindow`.

**Auto-unblock:** because the window slides, once no crash occurs for `windowMs` the ZCARD falls below the threshold and launches are permitted again automatically. No manual reset is required. (If the block is active, the agent stays `crashed`; it is only re-launched when something creates a new `starting` session — e.g. an operator/API restart.)

**Record crashes from both terminal paths:**
- `AgentSessionManager.handleAgentCrashed()` (called from the `onContainerDie` → `onAgentCrashed` path) — passes `sessionId` when available.
- `AgentSessionManager.handleRuntimeSessionEnd(..., 'crashed')` — passes its `sessionId`.

Because members are deduped by session id, a crash reported by both paths counts once.

**Alert on transition only.** `recordCrashEvent` returning `blocked === true` for the first time in a window should fire the alert once. Implement the transition check by comparing the pre-record count: if `crashCount === maxCrashesInWindow` exactly on this record (i.e. it just crossed the threshold), fire; subsequent blocked records (count > threshold) do not re-fire.

### 3.6 Launch gate — turn counting into prevention

In `reconcileStartingSessions()` (~L272), at the top of the per-session loop, **before** `claimStartingSession`:

```typescript
if (this.redis && this.crashLoopGuard?.enabled) {
  const blocked = await isCrashLaunchBlocked(this.redis, session.agentId, this.crashLoopGuard, Date.now());
  if (blocked) {
    await this.agentRepo.markSessionStopped(session.id, new Date());
    await this.agentRepo.updateAgent(session.agentId, { status: 'crashed' });
    await this.eventPublisher.emitGuardrailTriggered(session.agentId, {
      scope: 'agent_guardrail',
      code: 'runtime.crash_loop_blocked',
      message: 'Agent launch blocked — repeated crashes detected within the crash-loop window.',
      details: { sessionId: session.id },
    });
    await this.eventPublisher.emitInstanceStatus(session.agentId, {
      status: 'crashed',
      reason: 'runtime.crash_loop_blocked',
      updatedAt: new Date().toISOString(),
    });
    continue; // do not launch
  }
}
```

Notes:
- A blocked session never reaches first-boot heartbeat, so it never increments `agent:sessions:count` — no underflow risk from this gate.
- Keep the agent `crashed` (do not flip to `stopped`) so diagnostic state is preserved and the UI shows the true condition.

### 3.7 Alerting

Add a dedicated event to `apps/worker/src/alerting/platform-alert-service.ts`:

- In `PLATFORM_ALERT_EVENTS` (~L28): `CRASH_LOOP_BLOCKED: 'agent.runtime.crash_loop_blocked'`.
- In `eventSubject()` (~L163): `case PLATFORM_ALERT_EVENTS.CRASH_LOOP_BLOCKED: return 'Agent Crash Loop Blocked';`.

Fire it from `handleAgentCrashed()` when `recordCrashEvent` reports the block transition:

```typescript
await this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.CRASH_LOOP_BLOCKED, {
  agentId,
  message: `Agent crash loop detected — ${result.crashCount} crashes within ${Math.round(cfg.windowMs / 1000)}s. Automatic relaunch is blocked until the crash window clears.`,
  detail: 'The agent will not be restarted automatically. Investigate the crash cause before restarting.',
}).catch((err: unknown) => logger.warn({ err, agentId }, 'Failed to send crash-loop alert'));
```

### 3.8 Configuration (no magic numbers)

Thresholds come from operator config, never hard-coded.

**`packages/domain/src/config/schema.ts`** — add to `AgentRuntimeConfigSchema` (~L1067):

```typescript
crashLoopGuard: z.object({
  enabled: z.boolean().default(true),
  maxCrashesInWindow: z.number().int().min(1).default(3),
  windowMs: z.number().int().min(10_000).default(300_000),
}).default({}),
```

**`config/default.yaml`** — add under `agentRuntime:` (~L426):

```yaml
  crashLoopGuard:
    enabled: true
    maxCrashesInWindow: 3     # crashes within the window before relaunch is blocked
    windowMs: 300000          # 5-minute sliding window
```

**`apps/worker/src/index.ts`** — pass into the `AgentSessionManager` config object (~L873):

```typescript
crashLoopGuard: appConfig.agentRuntime.crashLoopGuard,
```

**`apps/worker/src/agents/agent-session-manager.ts`** — add `crashLoopGuard?: CrashLoopGuardConfig` to `AgentSessionManagerConfig`, store it, and read it in `handleAgentCrashed`, `handleRuntimeSessionEnd`, and `reconcileStartingSessions`.

---

## 4. Implementation steps (ordered)

### Step 1 — Ephemeral cleanup helper ✅ DONE
- [x] Create `apps/worker/src/agents/agent-ephemeral-redis-cleanup.ts` with `cleanupEphemeralAgentRedisState`.
- [x] Pipeline all DELs; wrap in try/catch; never throw.
- [ ] Unit test: all listed keys deleted; idempotent when absent; durable keys (`agent:memory:*`, `agent:tasks:*`, `agent:reminders:*`, `agent:watches:*`) NOT deleted; error is swallowed.

### Step 2 — Crash-loop guard helper ✅ DONE
- [x] Create `apps/worker/src/agents/agent-crash-loop-guard.ts` with `recordCrashEvent` and `isCrashLaunchBlocked`.
- [ ] Unit test: distinct sessions within window count up; duplicate session id counts once; old entries pruned; block transition detected exactly at threshold; auto-unblock after window.

### Step 3 — Config wiring ✅ DONE
- [x] Add `crashLoopGuard` to `AgentRuntimeConfigSchema` (`packages/domain/src/config/schema.ts`).
- [x] Add `crashLoopGuard` block to `config/default.yaml` under `agentRuntime`.
- [x] Add `crashLoopGuard?: CrashLoopGuardConfig` to `AgentSessionManagerConfig`; pass it in `index.ts`.

### Step 4 — Crash path cleanup + recording ✅ DONE
- [x] Add `AgentSessionManager.handleAgentCrashed(agentId, sessionId?)`: clear projection, call ephemeral cleanup, record crash, fire alert on block transition.
- [x] Update `onAgentCrashed` wiring in `index.ts` to call `sessionManager.handleAgentCrashed(agentId)` after `cascadeStopAgentBots`.
- [x] In `handleRuntimeSessionEnd(..., 'crashed')`, call `recordCrashEvent` (dedup by its `sessionId`) and fire the alert on block transition.

### Step 5 — Graceful & timeout cleanup ✅ DONE
- [x] In `stopSession()` and `handleRuntimeSessionEnd()`, inside the existing `if (count <= 0)` block, call `cleanupEphemeralAgentRedisState`.
- [x] In `handleStartTimeout()`, call `cleanupEphemeralAgentRedisState` (no ref-count change).

### Step 6 — Launch gate ✅ DONE
- [x] In `reconcileStartingSessions()`, add the `isCrashLaunchBlocked` gate before `claimStartingSession`, emitting guardrail + status events and `continue` on block.

### Step 7 — Alerting ✅ DONE
- [x] Add `CRASH_LOOP_BLOCKED` to `PLATFORM_ALERT_EVENTS` and `eventSubject()`.

### Step 8 — Staging remediation (one-shot) ✅ DONE
- [x] Provide a targeted command set to clear the current orphans for the known crashed staging agent IDs: `SREM agent:sessions:active <id>`, `DEL agent:sessions:count:<id> agent:wake:prefs:<id> agent:watches:summary:<id>` and the ephemeral prompt/stream keys. Do NOT delete `agent:memory:*`, `agent:tasks:*`, `agent:reminders:*`, `agent:watches:*`.

**Remediation commands** (run against staging Redis):

```bash
# For each crashed agent ID, run:
AGENT_ID="cdf9fa49-be64-4e2f-8998-bda9225d605a"  # range agent

# Clear session projection
redis-cli SREM agent:sessions:active "$AGENT_ID"
redis-cli DEL "agent:sessions:count:$AGENT_ID" "agent:wake:prefs:$AGENT_ID"

# Clear ephemeral keys
redis-cli DEL \
  "agent:inbound:$AGENT_ID" \
  "agent:outbound:$AGENT_ID" \
  "agent:prompt:$AGENT_ID" \
  "agent:prompt:scout:$AGENT_ID" \
  "agent:prompt:user-context:$AGENT_ID" \
  "agent:prompt:judge-user-context:$AGENT_ID" \
  "agent:prompt:hybrid:$AGENT_ID" \
  "agent:scanner:fingerprint:$AGENT_ID" \
  "agent:scanner_gated:$AGENT_ID" \
  "agent:watches:summary:$AGENT_ID" \
  "herobids:actor-health:agent:$AGENT_ID"

# Repeat for swing agent:
AGENT_ID="70b61677-ae13-4e49-ba0f-d47d6eead4ee"
# ... same commands as above

# DO NOT delete these durable keys:
# agent:memory:$AGENT_ID
# agent:tasks:$AGENT_ID
# agent:reminders:$AGENT_ID
# agent:watches:$AGENT_ID
```

### Step 9 — Validate ✅ DONE
- [x] `pnpm lint` passes.
- [x] `pnpm build` passes.
- [x] `pnpm --filter @herobids/worker run test` passes (all 2483 existing tests).
- [ ] Unit tests for new modules (Steps 1 & 2) — tracked as outstanding.

---

## 5. Tests

### 5.1 Unit
- `cleanupEphemeralAgentRedisState`: deletes exactly the ephemeral set; leaves durable keys; idempotent; swallows errors.
- `recordCrashEvent` / `isCrashLaunchBlocked`: window counting, session dedup, pruning, block transition, auto-unblock.
- `AgentSessionManager.handleAgentCrashed`: clears projection fully (SREM + DEL count + DEL prefs), calls ephemeral cleanup, records crash, fires alert only on transition.
- `handleStartTimeout`: calls ephemeral cleanup and does NOT change `agent:sessions:count`.

### 5.2 Integration / behavioural
- Multi-session agent: graceful stop of one session preserves shared projection + ephemeral keys; last-session stop removes both.
- Hard crash: projection is fully cleared and agent removed from `agent:sessions:active`.
- Crash recorded by both `onContainerDie` and `handleRuntimeSessionEnd` for one session counts once.
- After `maxCrashesInWindow` crashes, a new `starting` session is not launched (no `claimStartingSession`, no container), agent stays `crashed`, one alert fired.
- After the window passes, a new `starting` session launches normally.

---

## 6. Files changed

| File | Change |
|---|---|
| `apps/worker/src/agents/agent-ephemeral-redis-cleanup.ts` | **NEW** — ephemeral key cleanup helper |
| `apps/worker/src/agents/agent-crash-loop-guard.ts` | **NEW** — sliding-window crash guard |
| `apps/worker/src/agents/agent-session-manager.ts` | `handleAgentCrashed`; ephemeral cleanup in stop/end/timeout; launch gate; config field |
| `apps/worker/src/index.ts` | `onAgentCrashed` → `handleAgentCrashed`; pass `crashLoopGuard` config |
| `apps/worker/src/alerting/platform-alert-service.ts` | `CRASH_LOOP_BLOCKED` event + subject |
| `packages/domain/src/config/schema.ts` | `crashLoopGuard` schema in `AgentRuntimeConfigSchema` |
| `config/default.yaml` | `agentRuntime.crashLoopGuard` defaults |

---

## 7. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Deleting shared state out from under a live sibling session | HIGH | Ephemeral cleanup on graceful paths runs only inside `if (count <= 0)`; crash path clears only after all sessions are retired as crashed |
| Ref-count underflow from timeout/gate | MEDIUM | Start-timeout and blocked-launch paths never decrement the counter |
| Double-counting one crash across two terminal paths | MEDIUM | ZSET member = session id ⇒ idempotent |
| False positive from a transient network blip counted as crash | MEDIUM | Config-driven window/threshold; auto-unblock after window; operator alert on transition |
| Accidentally deleting durable product state | HIGH | Helper key list is explicit and excludes memory/tasks/reminders/watches; unit test asserts they are untouched |

---

## 8. Rollback

- Disable the guard at runtime: `agentRuntime.crashLoopGuard.enabled: false` (launch gate becomes a no-op; crashes still recorded harmlessly).
- Cleanup calls only run on confirmed terminal/last-session states — reverting is a straight `git revert` of the changed lines.
- No schema migration; config addition is additive with defaults.

---

## 9. Open decision (for confirmation)

- **Crash-loop recovery semantics:** this plan auto-unblocks once the sliding window clears (no manual reset). If the desired behaviour is "stay blocked until an operator explicitly restarts", replace the sliding-window auto-unblock with a sticky block flag cleared only on an explicit start action. Flagged for confirmation; the sliding-window default is assumed.

---

## 10. References

- `apps/worker/src/agents/agent-session-manager.ts` — `stopSession` (~L536), `handleRuntimeSessionEnd` (~L574), `handleHeartbeat` incr (~L699), `reconcileStartingSessions` (~L272), `handleStartTimeout` (~L818)
- `apps/worker/src/agents/docker-agent-manager.ts` — `onContainerDie` (~L497), crash alert + `onAgentCrashed` (~L530–542)
- `apps/worker/src/index.ts` — `onAgentCrashed` wiring (~L528), `AgentSessionManager` construction (~L873)
- `apps/worker/src/alerting/platform-alert-service.ts` — `PLATFORM_ALERT_EVENTS` (~L28), `eventSubject` (~L163)
- `packages/domain/src/config/schema.ts` — `AgentRuntimeConfigSchema` (~L1067)
- `config/default.yaml` — `agentRuntime` (~L426)

---

## 11. Outstanding Issues (post-implementation)

### ✅ RESOLVED

1. ~~**Unit tests not yet written**~~ — Added in [002-followup-plan.md](./002-followup-plan.md): `agent-ephemeral-redis-cleanup.test.ts` (5 cases), `agent-crash-loop-guard.test.ts` (22 cases), `agent-session-manager.test.ts` extended (+11 cases).

2. ~~**SessionId dedup from container-die path**~~ — Fixed: `onAgentCrashed` callback now accepts optional `sessionId` and `DockerAgentManager.onContainerDie` passes it through.

3. ~~**Stale crash keys if guard disabled**~~ — Fixed: `isCrashLaunchBlocked` now calls `pexpire` on the ZSET key to ensure self-cleanup even if `recordCrashEvent` is never called again.

### LOW (remaining)

1. **Nomad path not wired**: `onAgentCrashed` is only passed to `DockerAgentManager`, not `NomadRuntimeAdapter`. Nomad deployments won't get Redis projection cleanup or crash-loop protection from the container-die path. Tracked for when Nomad agent support goes to production.
