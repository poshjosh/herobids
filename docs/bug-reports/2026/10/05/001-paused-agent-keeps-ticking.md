# Bug Report 001 — Paused agents keep ticking, waking and calling the LLM; worker restart silently un-pauses them

- **Status:** OPEN (analysed, not yet fixed)
- **Severity:** High. A user-facing safety and cost control does not do what the UI and platform docs say. Paused agents keep spending LLM budget, and a routine worker redeploy can turn a pause back into `active`.
- **Date:** 2026-10-05
- **Environment:** All runtimes (Docker, Nomad, stub). The bug is in the runtime logic, not in the infrastructure.
- **Reviewer:** The fix will be reviewed against the acceptance criteria in this document. Please satisfy every item in [Acceptance criteria](#acceptance-criteria) and every scenario in [Required tests](#required-tests).

---

## 1. Summary

When an agent is paused (`agents.status = 'paused'`), the only behaviour that actually changes is that **trade decisions get rejected**. Everything else continues as if the agent were active:

| Behaviour | Expected while paused | Actual today |
|---|---|---|
| Scheduled ticks (LLM dispatch on cadence) | None | Continue at the normal cadence |
| Market / watch wake signals (`agent.wake`) | Ignored | Trigger early ticks and LLM calls |
| User messages | Kept and answered after resume | Answered immediately, while paused |
| `submit_decision` | Rejected | Rejected (`agent_paused`). This is the only part that works |
| Reminders | Not delivered | Not delivered (works by accident, see §3.4) |
| Bots owned by the agent | Keep running | Keep running (intended) |
| Container / session | Stays alive | Stays alive (intended; pause is not stop) |

There's a second, separate defect: **a worker restart rewrites `paused` back to `active`**, because the heartbeat recovery path writes `status: 'active'` without checking the current status.

The agent-facing platform docs already promise the correct behaviour (`apps/worker/src/tools/platform-docs-data.ts:413`: *"paused: Temporarily suspended (bots remain active, agent doesn't tick)"*). This is a bug, not a feature request.

---

## 2. Background a fixer needs

### 2.1 Processes involved

There are three separate processes. Keep in mind which one each piece of code runs in.

1. **API** (`apps/api`): HTTP routes. It writes agent status to Postgres. It does **not** talk to the agent container directly.
2. **Worker** (`apps/worker/src/index.ts`): the shared, long-running process. It runs `AgentSessionManager`, `AgentHealthMonitor`, the message broker, the reminder coordinator, the market monitor and so on. It launches agent containers through `AgentRuntimeLauncher` (Docker or Nomad adapter).
3. **Agent container** (`apps/worker/src/agent.ts`, about 4,000 lines): one per running agent. It runs the tick loop and the LLM calls. It has its own Redis connections and, when `DATABASE_URL` is set, its own DB handle:
   - `agent.ts:849`: `const db = DATABASE_URL ? createDatabase(DATABASE_URL) : null;`
   - `agent.ts:850`: `const agentRepo = db ? new AgentRepository(db) : null;`
   - **`agentRepo` can be `null`.** Any new code must handle that.

### 2.2 Agent status vs session status

- `agents.status` is the agent row, with values such as `starting`, `active`, `paused`, `stopped` and `crashed`. **Pause and resume only touch this column** (and `agents.pauseState`).
- `agent_runtime_sessions.status` tracks the container session: `starting`, `launching`, `running`, `unhealthy`, `stopped` or `crashed`. **Pause does not change the session.** It stays `running`, which is intended and must be preserved. The Docker reconcile code depends on it (`docker-agent-manager.ts`, around line 500: *"Paused agents keep their runtime session alive as well"*), and so do health monitoring and the market monitor's recipient set.

### 2.3 Pause and resume entry points (all of them only write the DB)

| Entry point | File | What it does |
|---|---|---|
| `POST /agents/:id/pause` | `apps/api/src/routes/agents.ts:2113`, then `pauseAgent()` in `apps/api/src/services/agent-lifecycle-service.ts:193` | Sets `status='paused'` and `pauseState={reason, requestedBy:'user', pausedAt}`. There's **no precondition on the current status**, so a `starting` agent can be paused. |
| `POST /agents/:id/resume` | `agents.ts:2132`, then `resumeAgent()` in `agent-lifecycle-service.ts:245` | Requires `status==='paused'`. Sets `status='active'` and `pauseState=null`. |
| Capability / Telegram pause and resume | `apps/api/src/routes/capabilities/trading.ts`, around lines 1369–1390 | Same DB writes as above. |
| Agent-originated `agent.lifecycle.pause_request` | `apps/worker/src/agents/agent-message-broker.ts:264`, then `AgentSessionManager.handlePauseRequest()` (`agent-session-manager.ts:853`) | Sets `status='paused'` and fires a guardrail alert when it isn't self-initiated. **Nothing in `agent.ts` sends this message today.** |

None of these notify the running container. Pause and resume are **DB state only**.

### 2.4 How the agent container ticks (`apps/worker/src/agent.ts`)

- **Startup:** `main()` (around line 3967) starts a heartbeat `setInterval` (around line 4046, every `HEARTBEAT_INTERVAL_MS`). This interval also enforces wall-clock expiry and flushes the billing window, and it is **independent of ticks**. It then runs the first `runTick()` and calls `scheduleNextTick()`.
- **`scheduleNextTick(delayMs)`** (around line 2238): sets `tickTimer`. When it fires it calls `runTick()`, and in `finally` it reschedules with `effectiveTickIntervalMs`. Wake requests can pull the next tick earlier through `resolveNextTickDelay`, bounded by `WAKE_MIN_INTERVAL_MS`.
- **`runTick()`** (around line 2417) does, in order:
  1. `tickCount++`, `refreshToolCircuits()`, a new `tickId`
  2. Wall-clock expiry check through `sandboxEnforcer.isExpired`, then `shutdown()`
  3. `sendHeartbeat('busy')`
  4. `readOutboundMessages()` (around line 1506). This reads **and acknowledges** up to 200 messages from the agent's outbound Redis stream through the runtime consumer group (`readAgentOutboundMessages`, `maxDrain: 200`).
  5. `applyRuntimeMessage(runtimeState, msg)` for each message (context snapshots, decision results and so on)
  6. Feeds the session circuit breaker from message types
  7. Drains `pendingWakeSignalBuffer` into `currentMarketWake`
  8. Captures `user.message` text into `runtimeState.metrics.activityTimeline` (around line 2552, enriched prompt style only)
  9. Handles `agent.runtime.config_update` by calling `toolVisibility.snapshotToolBaselines(); applyToolVisibility();`
  10. Boundary fetches: open positions, active watches
  11. Drains the `pendingUserMessage` flag into `hasBufferedWake`
  12. `buildTickGateState(...)`, then `shouldSkipTick` gates (`apps/worker/src/tick-gates.ts`: session/trading-hours, regime, context-hash)
  13. Either a skip (it emits `AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED` with `{ tickId, reason, gate, trigger, positionSide }`, see around line 2792) or LLM dispatch
  14. Later code also checks `incomingMessages.some(isUserMessageType)` (around lines 3397 and 3454)
- **Wake poller `pollWakeSignals()`** (around line 1552): a separate consumer group (`WAKE_CONSUMER_GROUP`) on the **same** outbound stream. Redis Streams deliver each message to every consumer group, so both groups see everything.
  - `agent.wake`: buffers it into `pendingWakeSignalBuffer` and calls `requestWakeDrivenTick()`. **Precedent:** when the session circuit breaker is open, it ACKs and suppresses the wake instead (around lines 1584–1590). Pause handling should follow the same pattern.
  - `user.message`: sets `pendingUserMessage = true` and calls `requestWakeDrivenTick()`.
- **Outbound stream size cap:** `AGENT_STREAM_MAXLEN = 1000` (`packages/domain/src/agent-protocol.ts:51`), applied with `MAXLEN ~`. If the runtime **stops reading** the stream, older unread entries, including user messages, can be trimmed and lost.

### 2.5 Wake and reminder producers in the worker

- The market monitor (`apps/worker/src/market-intelligence/monitor.ts`, around line 938) picks wake recipients from Redis `agent:sessions:active`. That set is **session-based** and pause does not remove the agent from it, so paused agents keep receiving wakes.
- `ReminderCoordinator.tick()` (`apps/worker/src/reminder-coordinator.ts`, around line 44) and the platform review scheduler bootstrap (`apps/worker/src/index.ts`, around line 1227) use `agentRepo.listActiveAgents()`, which only returns `status='active'`. So reminders and review schedulers already skip paused agents. That behaviour is correct and must not change.

### 2.6 Operator config for agent runtime

- YAML: `config/default.yaml`, top-level key `agentRuntime:` (around line 438), sub-key `wake:` (around line 497) with `minIntervalMs` and `pollMs`.
- Zod schema: `packages/domain/src/config/schema.ts`, around lines 1127–1130 (the `wake: z.object({...})` block).
- Inside the container these values arrive as `agentRuntimePolicy` (`agent.ts:398`, `parseAgentRuntimePolicy(AGENT_RUNTIME_CONFIG_RAW)`). For example, `agentRuntimePolicy.wake.minIntervalMs` is used at `agent.ts:2191`. Follow the same path for any new value.
- Rules: `docs/best-practices/configuration.md`. No hard-coded magic numbers for user- or operator-meaningful values. Every YAML key gets an inline comment.

---

## 3. Root cause

### 3.1 The runtime never learns it is paused

`agent.ts`, `tick-gates.ts`, `tick-gate-state.ts` and `agent-wake-scheduler.ts` never read `agents.status` and never check for `paused`. To confirm, grep for `paused` under `apps/worker/src` outside tests. The only runtime hit is `agent-decision-handler.ts:246`, which rejects decisions with code `agent_paused` (and is the reason trades are blocked).

### 3.2 Worker restart (and first boot) overwrites `paused` with `active`

`apps/worker/src/agents/agent-session-manager.ts`, heartbeat handling (around lines 750–830):

```ts
const isFirstBoot = session.status === 'starting' || session.status === 'launching';
const shouldBootstrapRecovery = !isUnhealthyRecovery && (
  isFirstBoot
  || session.status === 'unhealthy'
  || (session.status === 'running' && !this.activatedSessions.has(payload.sessionId))
);
...
if (shouldBootstrapRecovery) {
  this.runtimeLauncher.registerRecoveredRuntime(session.agentId, payload.sessionId);
  ...
  await this.agentRepo.updateAgent(session.agentId, { status: 'active' });   // ← around line 828, unconditional
  // onAgentStatusChange(..., 'active') notification follows
}
```

`activatedSessions` is in-memory, so after **every worker restart or redeploy** the first heartbeat from each surviving session takes this path, and a paused agent becomes `active`. The same thing happens if a user pauses an agent while its session is still `starting` or `launching` (first boot).

### 3.3 Side effects that make this worse

- The platform docs (`platform-docs-data.ts:413`) tell the agent's LLM that paused agents don't tick, which is untrue.
- Paused agents keep generating LLM cost. With trades rejected, every LLM tick while paused is wasted spend and produces rejected-decision noise.

### 3.4 Why reminders "work"

Reminders are skipped only because `listActiveAgents()` filters on `status='active'` (§2.5). Nothing in the runtime knows about pause.

---

## 4. Required behaviour after the fix

These are the **what**. The implementation approach is up to you, but each item is checked in review.

### R1. The runtime detects pause and resume on its own
- The agent container determines whether its agent is paused from the source of truth, `agents.status` in Postgres, read through the container's existing `agentRepo`.
- Pause must take effect **no later than the next scheduled tick**.
- Resume must take effect within a **bounded, operator-configurable delay**, even when the agent's normal tick interval is long (minimal/standard cost presets can be many minutes). While paused, the runtime must re-check status at `min(effectiveTickIntervalMs, <new pause poll interval>)`.
- Any new interval goes in operator config (`config/default.yaml` → `agentRuntime`, plus the Zod schema in `packages/domain/src/config/schema.ts`), with a sensible default (about 30s suggested), a minimum bound and an inline YAML comment. Don't hard-code it.
- **If the status read fails** (DB error), the runtime keeps its last-known pause state and logs a warning. It must not flip state on a transient error, must not crash, and must keep the tick loop scheduled.
- **If `agentRepo` is `null`** (no `DATABASE_URL`), treat the agent as not paused. That's the current behaviour, so nothing regresses.

### R2. A paused tick does no decision work
While paused, a tick must **not**:
- run tick gates, boundary fetches (positions, watches, regime, volatility), scout/judge or any other LLM call
- increment `tickCount` (it drives the `initial` trigger label and `FORCE_FULL_EVALUATION_EVERY_TICK`)
- touch `failureBackoff` / `handleTickSuccess()` / `handleRuntimeFailure()` or the session circuit breaker state
- change `effectiveTickIntervalMs` or `previousContextHash`

While paused, a tick **must** still:
- enforce wall-clock session expiry (`sandboxEnforcer.isExpired`, then `shutdown`)
- leave heartbeats unaffected (the independent heartbeat interval must keep running so the session stays `running` and `AgentHealthMonitor` never marks it unhealthy)
- emit a `TICK_SKIPPED` activity event with `gate: 'paused'` and a clear `reason` (for example `agent_paused`). Log at most once per pause transition at info level so a long pause doesn't flood the logs.
- reschedule itself (the existing `finally` in `scheduleNextTick` already does this; don't break it)

If `gate` is a typed union somewhere (activity event types or `TickSkipDecision['gate']`), extend the type properly. Don't cast.

### R3. Outbound messages received while paused are not lost and are processed on resume
- The runtime must **keep consuming** the outbound stream while paused. Otherwise `MAXLEN ~ 1000` trimming can delete unread user messages during a long pause.
- Messages read during paused ticks must be **held, not processed**, and then fed into the **first non-paused tick** ahead of freshly read messages, in original order. That tick must behave exactly as if it had read them itself: `applyRuntimeMessage`, circuit-breaker feeding, activity-timeline capture, `config_update` handling, and the `isUserMessageType` checks around lines 3397 and 3454.
- Don't half-process messages during paused ticks. In particular, `applyRuntimeMessage` must not run twice for the same message.
- The held queue must be **bounded**, with the cap from operator config or a clearly justified internal constant. On overflow it must **always keep** `user.message` envelopes (see `isUserMessageType`) and `agent.runtime.config_update` envelopes, and drop the oldest other messages first. Log a warning when it drops anything.

### R4. Wake handling while paused (`pollWakeSignals`)
- `agent.wake`: ACK it, **don't** buffer it into `pendingWakeSignalBuffer`, and **don't** call `requestWakeDrivenTick()`. Mirror the circuit-breaker suppression block.
- `user.message`: still set `pendingUserMessage = true` so the first resumed tick bypasses the context-hash gate, but **don't** request an early tick while paused.
- On resume there must be **no burst** of stale market wakes.

### R5. Resume re-engages the agent
- The first non-paused tick after a paused-to-active transition must run a full evaluation. It must not be skipped by the context-hash gate, for example by treating the transition like a wake signal.
- The first resumed tick must reply to any user messages received during the pause.

### R6. Paused status survives worker restart and first boot
- In `AgentSessionManager` (§3.2), the heartbeat recovery/first-boot path must **not overwrite `paused`**. Leave every other status transition exactly as it is today.
- Prefer an atomic conditional update, for example a new `AgentRepository` method or a `WHERE status <> 'paused'` clause in `packages/db/src/agent-repository.ts`, over read-then-write. A pause request that lands between the read and the write must not be lost.
- The `onAgentStatusChange` notification that follows must report the **actual** resulting status (`paused` when the write was skipped), not a hard-coded `'active'`.
- Everything else in that block must still run when the agent is paused: `registerRecoveredRuntime`, `onSessionActive`, `activatedSessions`, Redis `agent:sessions:count:*` / `agent:sessions:active` / wake prefs. Stop and delete must still be able to reach the container, and the session must still be treated as live.

### R7. Docs
- Update `apps/worker/src/tools/platform-docs-data.ts` (around lines 413–420) so the agent-facing description matches the new behaviour: no ticks or wakes while paused, user messages handled after resume, bots keep running, trades rejected.
- If `docs/tech/agents/wake-signal-and-technical-scan.md` or `docs/tech/agents/runtime-boundary-and-message-contract.md` describe tick or wake behaviour, add a short note about pause.

---

## 5. Must not regress

Each of these must hold after the fix. Most are covered by [Required tests](#required-tests).

1. **Active agents are unchanged.** Same tick cadence, gates, `tickCount`, backoff, circuit breaker, wake handling and user-message handling. The only allowed difference is one extra lightweight status read per tick.
2. **Heartbeats and health.** A paused agent's session stays `running` and is never marked `unhealthy` or `crashed` because of the pause.
3. **Stop and delete while paused.** `POST /agents/:id/stop` and `DELETE /agents/:id` still tear the container down (through `AgentHealthMonitor`'s stopped-session cleanup and the `agent:cleanup:{id}` Redis signal).
4. **Wall-clock expiry** still shuts down a paused agent.
5. **The decision-handler `agent_paused` rejection** (`agent-decision-handler.ts:246`) stays as defence in depth. Don't remove it.
6. **Reminders and review schedulers** still skip paused agents (no change to `listActiveAgents()` semantics).
7. **Docker reconcile** still treats a paused agent's running container as owned, not orphaned (`docker-agent-manager.ts` reconcile, live-session check).
8. **Hybrid / scanner-gated agents** (`IS_HYBRID`, `IS_SCANNER_GATED` in `agent.ts`): pause applies to them the same way, and their existing wake-only LLM dispatch is unchanged when active.
9. **No DB access** (`agentRepo === null`): behaviour is identical to today.
10. **Shutdown drain** (`shutdown()`, `SHUTDOWN_DRAIN_TIMEOUT_MS`) still works when the runtime is paused.
11. **Strict TypeScript:** no `any`, `@ts-ignore` or `as unknown as`. `pnpm lint` passes.

---

## 6. Acceptance criteria

- [ ] R1–R7 implemented.
- [ ] Every item in §5 holds.
- [ ] New operator config key(s) are added to `config/default.yaml` with inline comments **and** to the Zod schema. `.env*.example` files are untouched unless an env var was added; if one was, the matching `.example` is updated in the same change, per `AGENTS.md`.
- [ ] Every test in §7 is added and passing.
- [ ] `pnpm lint` passes. `pnpm build` passes. `pnpm test` passes for `apps/worker`, `packages/db` and `packages/domain`.
- [ ] This report is updated: Status changed to FIXED, plus a **Fix** section listing the files changed, a **Verification** section with the commands run and their results, and any deliberate deviations from this report with reasons.

---

## 7. Required tests

Test names should describe behaviour (repo rule). Put them next to the closest existing tests where possible:
- `apps/worker/src/agents/agent-session-manager.test.ts`
- `packages/db/src/agent-repository.test.ts`
- `apps/worker/src/tick-gates.test.ts` / `tick-gate-state.test.ts`
- `apps/worker/src/agent-wake-scheduler.test.ts`
- `apps/worker/src/runtime-*.test.ts`

`agent.ts` is a large module with top-level side effects. If the new pause logic is hard to test in place, extract the pure parts (pause-state resolution, held-message queue with priority overflow, next-delay-while-paused calculation, wake-suppression decision) into a small new module with unit tests, and keep the `agent.ts` wiring thin.

**Session manager / repository (R6)**
1. "keeps a paused agent paused when a surviving session sends its first heartbeat after worker restart"
2. "keeps an agent paused when it was paused while its session was still starting"
3. "still marks a non-paused agent active on first-boot and recovery heartbeats" (regression)
4. "still registers the recovered runtime handle and session-active projection for a paused agent"
5. "reports the actual resulting status to onAgentStatusChange when the active write is skipped"
6. Repository: "conditional activate does not overwrite paused" / "conditional activate sets active from other statuses"

**Runtime pause behaviour (R1–R5)**

7. "does not dispatch the LLM or run tick gates while the agent is paused"
8. "does not increment tickCount or alter failure backoff while paused"
9. "emits a tick_skipped activity event with gate paused"
10. "re-checks pause status within the configured pause poll interval when the normal tick interval is longer"
11. "keeps last-known pause state when the status read fails"
12. "treats the agent as not paused when no database is configured"
13. "holds outbound messages read while paused and processes them in order on the first resumed tick"
14. "applies each held runtime message exactly once"
15. "applies a config_update received while paused on resume"
16. "answers a user message received while paused on the first resumed tick"
17. "retains user messages and config updates when the held-message queue overflows"
18. "ACKs and ignores market wake signals while paused without scheduling an early tick"
19. "does not burst stale wake ticks after resume"
20. "runs a full evaluation on the first tick after resume even if context is unchanged"
21. "still enforces wall-clock expiry while paused"

---

## 8. Out of scope (don't implement here; note in the Fix section if relevant)

- Filtering paused agents out of market-monitor wake recipients (`monitor.ts`). Runtime-side suppression (R4) is enough for correctness. Producer-side filtering is a possible efficiency follow-up.
- Auto-replying to users who message a paused agent ("agent is paused; will respond on resume"). That's a separate feature.
- Pausing runtime/container billing while paused. That's a product decision.
- Persisting the held-message queue across a container restart. A container restart while paused loses it, the same exposure as today's in-memory `pendingWakeSignalBuffer`. Acceptable for now. Mention it in the Fix section.
- Agent self-resume. If an agent ever sends `agent.lifecycle.pause_request` for itself, it can't resume itself after this fix, because it no longer ticks. Nothing sends that message today. Flag it in the Fix section; don't change it.
- Adding a status precondition to `pauseAgent()` (it currently allows pausing any status). R6 makes pausing during `starting` safe, and anything further is a separate change.
- The unrelated runtime-stop issues found in the same investigation (the Docker `stopByContainerId` being given an agent ID or a `recovered-*` ID, and Docker reconcile not listing exited containers). These need their own bug report.

---

## 9. Related

- `apps/worker/src/agent.ts`: `runTick`, `scheduleNextTick`, `pollWakeSignals`, `requestWakeDrivenTick`, `readOutboundMessages`, `shutdown`
- `apps/worker/src/tick-gates.ts`, `apps/worker/src/tick-gate-state.ts`, `apps/worker/src/agent-wake-scheduler.ts`
- `apps/worker/src/agents/agent-session-manager.ts` (heartbeat recovery, `handlePauseRequest`)
- `apps/worker/src/agents/agent-decision-handler.ts:246`
- `apps/worker/src/agents/agent-health-monitor.ts` (stopped-session cleanup)
- `apps/api/src/services/agent-lifecycle-service.ts` (`pauseAgent`, `resumeAgent`, `stopAgent`)
- `apps/api/src/routes/agents.ts`, `apps/api/src/routes/capabilities/trading.ts`
- `packages/db/src/agent-repository.ts`
- `packages/domain/src/config/schema.ts`, `config/default.yaml` (`agentRuntime.wake`)
- `docs/best-practices/configuration.md`, `docs/tech/agents/wake-signal-and-technical-scan.md`, `docs/tech/agents/runtime-boundary-and-message-contract.md`
