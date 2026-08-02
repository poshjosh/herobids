# 003 — Follow-Up Plan: Unit Tests & Outstanding Fixes

- **Status:** Done
- **Date:** 2026-07-25
- **Author:** AI agent
- **Trigger:** Code review of the initial implementation of [001-plan.md](./001-plan.md) identified four outstanding issues (2 MEDIUM, 2 LOW). This plan addresses them in priority order.

---

## 1. MEDIUM — Unit tests for new modules (Steps 1 & 2 of the original plan)

### 1.1 Context

Two new modules were added without the unit tests specified in §5.1 of the original plan. These tests are critical for correctness — they protect against regressions in Redis key safety and crash-loop counting logic.

### 1.2 Files to create

| File | What it tests |
|---|---|
| `apps/worker/src/agents/agent-ephemeral-redis-cleanup.test.ts` | `cleanupEphemeralAgentRedisState` |
| `apps/worker/src/agents/agent-crash-loop-guard.test.ts` | `recordCrashEvent`, `isCrashLaunchBlocked`, `shouldFireCrashLoopAlert` |
| `apps/worker/src/agents/agent-session-manager.test.ts` (extend) | `handleAgentCrashed`, `handleStartTimeout` ephemeral cleanup, crash recording in `handleRuntimeSessionEnd` |

### 1.3 `agent-ephemeral-redis-cleanup.test.ts`

Mock Redis with `pipeline() → { del(), exec() }`. Test cases:

1. **Deletes all 11 ephemeral keys** — pipeline receives exactly the expected key list.
2. **Idempotent when keys are absent** — `pipeline.exec()` resolves; no throw.
3. **Does NOT delete durable keys** — `agent:memory:<id>`, `agent:tasks:<id>`, `agent:reminders:<id>`, `agent:watches:<id>`, `agent:watches:notified:<id>` are NOT in the pipeline.
4. **Does NOT delete session-projection keys** — `agent:sessions:active`, `agent:sessions:count:<id>`, `agent:wake:prefs:<id>` are NOT in the pipeline.
5. **Swallows errors** — `pipeline.exec()` rejects → function resolves (does not throw), error logged.

**Mock pattern** (from existing tests):

```typescript
function makeRedisMock() {
  const pipelineMock = {
    del: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    pipeline: vi.fn().mockReturnValue(pipelineMock),
  } as any;
}
```

### 1.4 `agent-crash-loop-guard.test.ts`

Mock Redis with `zadd`, `zremrangebyscore`, `zcard`, `pexpire`, `set`. Test cases:

#### `recordCrashEvent`

1. **Distinct sessions within window count up** — 3 different `sessionId` values → `zcard` returns 3 → `blocked = 3 >= maxCrashesInWindow`.
2. **Duplicate session id counts once** — same `sessionId` called twice → `zcard` returns 1 (ZADD idempotent by member).
3. **Old entries pruned** — `zremrangebyscore` called with cutoff `nowMs - windowMs`.
4. **Block transition detected at threshold** — `maxCrashesInWindow = 3`, 3rd crash → `blocked: true`, `crashCount: 3`.
5. **Below threshold not blocked** — `maxCrashesInWindow = 3`, 2nd crash → `blocked: false`.
6. **TTL set on key** — `pexpire` called with `windowMs`.
7. **No sessionId uses timestamp-based member** — `sessionId` is `undefined` → member is `nosession:<nowMs>`.
8. **Error swallowed, returns safe default** — `zadd` rejects → returns `{ crashCount: 0, blocked: false }`.

#### `isCrashLaunchBlocked`

1. **Returns false when guard disabled** — `cfg.enabled = false` → returns `false` without Redis calls.
2. **Returns true when crashCount >= threshold** — `zcard` returns 3, `maxCrashesInWindow = 3` → `true`.
3. **Returns false when crashCount < threshold** — `zcard` returns 2, `maxCrashesInWindow = 3` → `false`.
4. **Prunes expired entries** — `zremrangebyscore` called with correct cutoff.
5. **Auto-unblock after window** — all entries older than window → `zcard` returns 0 → `false`.
6. **Error swallowed, returns false** — `zcard` rejects → returns `false`.

#### `shouldFireCrashLoopAlert`

1. **First call returns true** — `SET key 1 PX windowMs NX` returns `'OK'`.
2. **Second call within window returns false** — `SET ... NX` returns `null` (key exists).
3. **After TTL expires, returns true again** — simulate key expiry → `SET ... NX` returns `'OK'`.
4. **Error swallowed, returns true (fail-open)** — `set` rejects → returns `true`.

### 1.5 Extend `agent-session-manager.test.ts`

Add test cases in the existing `describe('AgentSessionManager')` block:

1. **`handleAgentCrashed` clears projection fully** — verifies `srem agent:sessions:active`, `del agent:sessions:count`, `del agent:wake:prefs` are called.
2. **`handleAgentCrashed` calls ephemeral cleanup** — verifies `cleanupEphemeralAgentRedisState` is invoked (indirectly via Redis pipeline).
3. **`handleAgentCrashed` records crash when guard enabled** — verifies `zadd` on `agent:crash:events:<id>` with correct member/score.
4. **`handleAgentCrashed` skips crash recording when guard disabled** — `crashLoopGuard.enabled = false` → no ZADD call.
5. **`handleAgentCrashed` fires alert on block transition** — when `recordCrashEvent` returns `blocked: true` and `shouldFireCrashLoopAlert` returns `true`.
6. **`handleAgentCrashed` does NOT fire alert if already alerted** — `shouldFireCrashLoopAlert` returns `false`.
7. **`handleAgentCrashed` handles Redis errors gracefully** — `srem` rejects → method resolves, no throw.
8. **`handleStartTimeout` calls ephemeral cleanup, does NOT change ref count** — verifies pipeline `del` called, but `decr agent:sessions:count` is NOT called.
9. **`handleRuntimeSessionEnd` with `status: 'crashed'` records crash** — verifies ZADD on `agent:crash:events:<id>`.

### 1.6 Acceptance criteria

- [ ] `pnpm --filter @herobids/worker run test` passes with the new tests.
- [ ] All mock Redis calls verified with `expect(...).toHaveBeenCalledWith(...)` for key correctness.
- [ ] Error paths covered (rejected Redis calls → function resolves/returns safe default).

---

## 2. MEDIUM — SessionId dedup from container-die path

### 2.1 Problem

`onAgentCrashed(agentId)` doesn't pass `sessionId`, so the container-die crash path records a ZSET member like `nosession:<nowMs>` while `handleRuntimeSessionEnd` records `<sessionId>`. These are different members → same crash could theoretically count twice if both terminal paths fire.

### 2.2 Fix

Extend the `onAgentCrashed` callback signature to include an optional `sessionId`, and have `DockerAgentManager.onContainerDie` pass the retiring session ID when available.

**Files changed:**

| File | Change |
|---|---|
| `apps/worker/src/agents/docker-agent-manager.ts` | Pass the retiring session ID from `retireActiveSessionsWithStatus` to `onAgentCrashed` |
| `apps/worker/src/index.ts` | Update callback to forward `sessionId` to `handleAgentCrashed` |
| `apps/worker/src/agents/agent-session-manager.ts` | Already accepts optional `sessionId` — no change needed |

**`docker-agent-manager.ts`** — in `onContainerDie()`, after `retireActiveSessionsWithStatus(agentId, 'crashed')`, collect the retired session IDs and pass the first one to the callback:

```typescript
// After retireActiveSessionsWithStatus, grab the first retired session ID
const retiredSessions = await this.agentRepo.getSessionsByStatuses(agentId, ['crashed']);
const firstCrashedSessionId = retiredSessions[0]?.id;

if (this.onAgentCrashed) {
  await this.onAgentCrashed(agentId, firstCrashedSessionId);
}
```

**`index.ts`** — update the callback signature:

```typescript
onAgentCrashed: async (agentId, sessionId?) => {
  await cascadeStopAgentBots(agentId);
  await sessionManager.handleAgentCrashed(agentId, sessionId);
},
```

### 2.3 Acceptance criteria

- [ ] `onAgentCrashed` callback receives optional `sessionId`.
- [ ] Same crash reported via both `onContainerDie` and `handleRuntimeSessionEnd` counts once in the ZSET.
- [ ] `pnpm lint` + `pnpm build` pass.

---

## 3. LOW — Stale crash keys if guard disabled

### 3.1 Problem

`agent:crash:events:*` ZSET keys get `PEXPIRE` only on `recordCrashEvent` calls. If the guard is later disabled, `isCrashLaunchBlocked` doesn't set TTL, so old keys could linger in Redis indefinitely.

### 3.2 Fix

Add a `PEXPIRE` call in `isCrashLaunchBlocked` after pruning, so the key self-cleans even when only the read path is exercised.

**`agent-crash-loop-guard.ts`** — in `isCrashLaunchBlocked`, after `zremrangebyscore`:

```typescript
// Ensure the key self-cleans even if recordCrashEvent is never called again
await redis.pexpire(key, cfg.windowMs);
```

### 3.3 Acceptance criteria

- [ ] `isCrashLaunchBlocked` calls `pexpire` with `windowMs`.
- [ ] Existing unit test for `isCrashLaunchBlocked` verifies the PEXPIRE call.
- [ ] `pnpm lint` + `pnpm build` pass.

---

## 4. LOW — Nomad path not wired

### 4.1 Problem

`onAgentCrashed` is only passed to `DockerAgentManager`. The `NomadRuntimeAdapter` path does not wire it, so Nomad deployments won't get Redis projection cleanup or crash-loop protection from the container-die path.

### 4.2 Decision

**Out of scope for this follow-up.** Nomad is not yet in production use for agents. When Nomad agent support is promoted, this wiring should be part of that work. Documented here for visibility.

---

## 5. Implementation steps

### Step 1 — Unit tests ✅ DONE
- [x] Create `apps/worker/src/agents/agent-ephemeral-redis-cleanup.test.ts` (5 test cases).
- [x] Create `apps/worker/src/agents/agent-crash-loop-guard.test.ts` (22 test cases across 3 functions).
- [x] Extend `apps/worker/src/agents/agent-session-manager.test.ts` (11 new test cases).

### Step 2 — SessionId dedup ✅ DONE
- [x] Update `docker-agent-manager.ts` to pass `sessionId` to `onAgentCrashed`.
- [x] Update `index.ts` `onAgentCrashed` callback signature to accept and forward `sessionId`.

### Step 3 — Stale key cleanup ✅ DONE
- [x] Add `pexpire` call in `isCrashLaunchBlocked`.
- [x] Update unit test to verify.

### Step 4 — Validate ✅ DONE
- [x] `pnpm lint` passes.
- [x] `pnpm build` passes.
- [x] `pnpm --filter @herobids/worker run test` passes (2519 tests, all new tests pass).

---

## 6. Files changed

| File | Change |
|---|---|
| `apps/worker/src/agents/agent-ephemeral-redis-cleanup.test.ts` | **NEW** — 5 test cases |
| `apps/worker/src/agents/agent-crash-loop-guard.test.ts` | **NEW** — 18 test cases |
| `apps/worker/src/agents/agent-session-manager.test.ts` | Extend — 9 new test cases |
| `apps/worker/src/agents/docker-agent-manager.ts` | Pass `sessionId` to `onAgentCrashed` |
| `apps/worker/src/index.ts` | Forward `sessionId` in `onAgentCrashed` callback |
| `apps/worker/src/agents/agent-crash-loop-guard.ts` | Add `pexpire` in `isCrashLaunchBlocked` |

---

## 7. References

- [001-plan.md](./001-plan.md) §5.1 — unit test specifications
- [001-plan.md](./001-plan.md) §11 — outstanding issues
- Existing test patterns: `apps/worker/src/agents/agent-session-manager.test.ts`, `apps/worker/src/agents/instance-event-publisher.test.ts`
