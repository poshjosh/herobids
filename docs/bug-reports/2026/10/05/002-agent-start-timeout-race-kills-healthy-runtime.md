# Bug Report 002 — Start-timeout race kills a healthy agent runtime; "Runtime Failed" fired for a container that actually booted and ticked

- **Status:** OPEN (analysed, not yet fixed)
- **Severity:** High. A user-initiated agent start can be killed by the platform ~30 s later with a user-visible "Runtime Failed" safety alert (email + in-product message), even though the agent container launched successfully, connected to Redis, and began a normal tick (scout escalated, LLM dispatched). The failure is intermittent and timing-dependent: it fires whenever the runtime scheduler (Nomad) takes long enough to place the job that the container's first heartbeat lands after the start-timeout deadline. Wasted LLM work, a false-alarm safety alert, and an agent left `stopped` that the user believes they started.
- **Date:** 2026-10-05
- **Environment:** Observed on **staging** (`staging.openaidom.com`, host `138.199.172.202`), which runs agents as **Nomad jobs** (`nomad-runtime-adapter`), not local Docker containers. The defect is in worker-side timeout accounting and is runtime-agnostic — it will reproduce on any runtime whose launch/placement latency is non-trivial (Nomad, a cold Docker image pull, a busy node). It is **not** specific to the agent, its config, or its models.
- **Reviewer:** The fix will be reviewed against the acceptance criteria in this document. Please satisfy every item in [Acceptance criteria](#acceptance-criteria) and every scenario in [Required tests](#required-tests).

---

## 1. Summary

When an agent runtime session is created, its DB row is stamped `status='starting'` and `started_at = now()` **at that instant**. The worker then asks the runtime adapter to launch the container (a Nomad job). The health monitor independently sweeps for sessions stuck in `starting`/`launching` whose `started_at` is older than a fixed **30 s** window and, when it finds one, tears the runtime down and fires a `RUNTIME_FAILED` ("Runtime Failed") platform safety alert.

The bug: **the 30 s start-timeout clock is anchored to session-creation time, not to when the runtime actually started.** On staging, Nomad took ~15 s just to register the job, so the container only had ~15 s of the 30 s budget left to pull its image, boot Node, connect to Redis/DB, and get its first heartbeat processed by the worker. It missed the deadline by a few seconds — then came up healthy and started ticking, by which point the worker had already declared it failed and purged the job. The container's own messages (`agent.tick.started`, `agent.tick.skipped`, `agent.scout.escalated`, `agent.llm.dispatch`) arrived 4–5 s after the kill and were rejected as "Stale session message rejected at broker boundary".

There is a second, structural problem feeding this: the start-timeout reuses the **same** `heartbeatTimeoutMs` (default 30 s) that is used to detect heartbeat loss on an already-`running` session. 30 s is generous for a steady-state heartbeat gap but tight as a cold-start launch budget, and it does not account for scheduler placement latency at all.

This is a bug, not a feature request. A user clicked "Start", the container worked, and the platform killed it and told the user it failed.

---

## 2. Background a fixer needs

Keep in mind which process each piece of code runs in. There are three.

1. **API** (`apps/api`): HTTP routes. `POST /agents/:id/start` writes agent/session state to Postgres; it does not talk to the container.
2. **Worker** (`apps/worker/src/index.ts`): the shared long-running process. It runs `AgentSessionManager`, `AgentHealthMonitor`, `AgentRuntimeLauncher` (which drives the Nomad or Docker adapter via a port), the message broker, etc. **All the code in this bug lives here**, plus the repository in `packages/db`.
3. **Agent container** (`apps/worker/src/agent.ts`): one per running agent. It boots, connects to Redis/DB, sends heartbeats, and runs the tick loop. On staging this is a Nomad job.

### 2.1 Session lifecycle and the two competing writes

- A runtime session row lives in `agent_runtime_sessions`. Schema: `packages/db/src/schema/agent-runtime-sessions.ts`.
  - `status`: `starting | launching | running | unhealthy | stopped | crashed`, default `'starting'` (line 15).
  - `started_at`: `timestamp(...).notNull().defaultNow()` (line 21) — **stamped by the DB at row insert**.
  - `last_heartbeat_at`: nullable; set on the first processed heartbeat.
- Session creation: `AgentRepository.createSession` (`packages/db/src/agent-repository.ts:308`) inserts with `status: 'starting'`. `started_at` therefore defaults to the insert time. The session manager's `startSession` (`apps/worker/src/agents/agent-session-manager.ts:272`) just calls `createSession`.
- Launch: `AgentSessionManager` later calls `this.runtimeLauncher.launch(...)` (`agent-session-manager.ts:531`). `AgentRuntimeLauncher.launch` (`apps/worker/src/agents/agent-runtime-launcher.ts:331`) calls `this.port.launch(...)` — the Nomad/Docker adapter. This is where real wall-clock time is spent (image pull, scheduler placement). The adapter returns `startedAt` from `portResult.data.startedAt` (`agent-runtime-launcher.ts:390`), which the launcher stores on its in-memory handle but which is **not** what the timeout is measured against.

Two methods race to be the first to change the session out of `starting`:

- **First heartbeat → running** (`AgentRepository.markSessionRunning`, `agent-repository.ts:448`):
  ```ts
  update(agentRuntimeSessions)
    .set({ status: 'running', lastHeartbeatAt: heartbeatAt })
    .where(and(eq(id, sessionId),
      inArray(status, ['starting','launching','running','unhealthy'])))
  ```
- **Start timeout → stopped** (`AgentRepository.markSessionStartTimedOut`, `agent-repository.ts:464`):
  ```ts
  update(agentRuntimeSessions)
    .set({ status: 'stopped', stoppedAt })
    .where(and(eq(id, sessionId),
      inArray(status, ['starting','launching'])))
  ```

Both are guarded conditional updates, so exactly one wins. Whichever observes the row still in `starting` first flips it. There is **no** check that prevents the timeout from firing when a first heartbeat is moments away or already in flight.

### 2.2 The start-timeout mechanism

- `AgentHealthMonitor` (`apps/worker/src/agents/agent-health-monitor.ts`):
  - `DEFAULT_CONFIG = { checkIntervalMs: 10_000, heartbeatTimeoutMs: 30_000 }` (around line 68). On the worker the check interval is overridden (see `apps/worker/src/index.ts:684` / `:769`, `appConfig.worker.agents.healthCheckIntervalMs`), but **`heartbeatTimeoutMs` is left at the 30 s default** — there is no separate launch budget.
  - `checkHealth()` (around line 64) computes `threshold = now - heartbeatTimeoutMs` and runs two sweeps against the same threshold:
    1. `running` sessions with `last_heartbeat_at < threshold` → `markUnhealthy`.
    2. `starting`/`launching` sessions with **`started_at < threshold`** → `handleStartTimeout` (line 90).
  - So the **same** 30 s window is used both as a steady-state heartbeat-loss timeout and as a cold-start launch budget, and the start sweep measures from `started_at` (session-creation time).
- `AgentSessionManager.handleStartTimeout(sessionId)` (`agent-session-manager.ts:934`): re-reads the session; if still `starting`/`launching`, calls `markSessionStartTimedOut`, then `runtimeLauncher.stop(sessionId)`, sets the **agent** row to `status: 'stopped'`, cleans up ephemeral Redis, and fires `RUNTIME_FAILED`:
  ```ts
  this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, {
    agentId: session.agentId,
    sessionId,
    message: 'Agent runtime failed to start — the runtime did not connect within the expected window.',
  })
  ```
  (`agent-session-manager.ts:965`). `RUNTIME_FAILED = 'agent.runtime.failed'` and renders to the user as **"Runtime Failed"** (`apps/worker/src/alerting/platform-alert-service.ts:30`, `:167`).

### 2.3 The container's first heartbeat path

- In the container, `main()` sends `sendHeartbeat('starting')` early in boot (`apps/worker/src/agent.ts:4009`), *before* external-skill installation. `sendHeartbeat` publishes a `RUNTIME_HEARTBEAT` message to the agent inbound stream (`agent.ts:1444`); it swallows and only `warn`-logs on failure ("Failed to send heartbeat").
- The worker consumes that heartbeat and calls `markSessionRunning`, flipping the session `starting → running` and setting `last_heartbeat_at`. That is the signal the health monitor's start sweep is implicitly waiting for.
- Net: for a start to be judged successful, **session-create → container boot → first heartbeat published → worker processes it → `markSessionRunning`** must all complete within 30 s of `started_at`. Any latency before the container exists (scheduler placement, image pull) eats directly into that budget.

---

## 3. Evidence (staging, 2026-10-05)

Agent `c9a51a75-27a1-42fc-a262-891ea6cb9698` ("pa"), a non-trading monitoring agent (`capabilityMode: intelligence`, skills: web-access/browser/email/programming/file-management/task-management). This same agent had started cleanly twice before (Sep 27 00:58, Sep 28 16:48) and run for ~40 h — so config and models are known-good.

### 3.1 API-derived timeline (from `/agents/:id/activity-feed`, `/messages`, `/sessions`)

- `06:33:12.364Z` — session `619621d3-f3a1-41ab-bf2b-83d8a3f8a368` created, `started_at = 06:33:12.364Z`. Triggered by a user clicking **Start** (`POST /agents/.../start`, referer = staging agent detail page — confirmed in API logs).
- `06:33:42.693Z` — session flipped to `stopped`.
- `06:33:44.193Z` — outbound platform message **"Runtime Failed — Agent runtime failed to start — the runtime did not connect within the expected window."**
- The activity feed also shows the misleading pair: **"Session stopped — Agent runtime shut down gracefully"** immediately followed by **"Runtime Failed"** (see §5.3).

### 3.2 Worker container logs (`docker logs herobids-worker-1`, window 06:31:30–06:35:30Z)

```
[06:33:27] INFO (nomad-runtime-adapter): Nomad job registered
    jobId: "agent-c9a51a75-27a1-42fc-a262-891ea6cb9698"
[06:33:42] WARN (agent-health-monitor): Stale agent start detected
    sessionId: "619621d3-f3a1-41ab-bf2b-83d8a3f8a368"
    startedAt: "2026-10-05T06:33:12.364Z"
[06:33:42] INFO (nomad-runtime-adapter): Nomad job stopped and purged
[06:33:44] WARN (agent-session-manager): Agent session start timed out
    sessionId: "619621d3-f3a1-41ab-bf2b-83d8a3f8a368"
[06:33:44] INFO (platform-alert-service): Platform safety alert sent via email
    event: "agent.runtime.failed"
[06:33:46] WARN (agent-message-broker): Stale session message rejected at broker boundary
    sessionId: "619621d3-..."  type: "agent.tick.started"
[06:33:47] WARN (agent-message-broker): Stale session message rejected at broker boundary
    type: "agent.tick.skipped"
[06:33:47] WARN (agent-message-broker): Stale session message rejected at broker boundary
    type: "agent.scout.escalated"
[06:33:47] WARN (agent-message-broker): Stale session message rejected at broker boundary
    type: "agent.llm.dispatch"
```

### 3.3 What the evidence proves

1. **The container booted and worked.** The four broker-rejected messages at 06:33:46–47 are the container's own output: it reached Redis, started a tick, the scout escalated, and an LLM call was dispatched. This is not a "never launched" and not a "crashed on boot" case.
2. **The kill was premature.** `started_at = 06:33:12`; the 30 s sweep fired at `06:33:42` (exactly +30 s). The Nomad job did not even *register* until `06:33:27` — ~15 s gone before the container existed — so the real boot had ~15 s, not 30 s.
3. **It was a race, lost by seconds.** The container's first messages landed ~4–5 s after the deadline. Had the timeout been measured from launch (or been a few seconds longer, or deferred because a heartbeat was imminent), this start would have succeeded like the previous two.
4. **It is intermittent.** Of three lifetime Nomad registrations on this worker, only this one hit the timeout. It depends entirely on scheduler/placement latency, which varies with node warmth, image cache, and cluster load.

---

## 4. Root cause

Two coupled defects:

### 4.1 (Primary) The start-timeout is measured from session-creation time, not runtime-launch time

`AgentHealthMonitor.checkHealth` compares `agent_runtime_sessions.started_at` (stamped at `createSession`, before `runtimeLauncher.launch` returns) against `now - heartbeatTimeoutMs`. All time spent in scheduler placement / image pull before the container exists is wrongly billed against the container's boot-and-first-heartbeat budget. A slow placement alone can exhaust the window before the container has a chance.

### 4.2 (Contributing) One 30 s constant serves two different purposes

`heartbeatTimeoutMs` (default 30 s, `agent-health-monitor.ts:68`) is used both for steady-state heartbeat-loss detection on `running` sessions **and** as the cold-start launch budget for `starting`/`launching` sessions. These have very different latency profiles. There is no dedicated, longer launch/placement budget, and no separate "time since the runtime actually started" signal.

### 4.3 (Aggravating) No guard against killing a start whose first heartbeat is in flight

`markSessionStartTimedOut` and `markSessionRunning` are both conditional single-statement updates guarded on `status IN ('starting','launching')`, so one wins cleanly — but nothing makes the timeout *yield* to an imminent/just-arrived heartbeat. The broker clearly saw the container's heartbeat/tick traffic ~4 s after the kill; the timeout had no notion of "a heartbeat is about to land, hold off."

---

## 5. Required behaviour after the fix

These are the **what**; the implementation approach is up to the fixer, but each item is checked in review.

### R1. The start-timeout must be measured from when the runtime actually started, not from session creation
- The launch budget must begin at the moment the runtime adapter reports the job/container as launched (the launcher already receives `portResult.data.startedAt`, `agent-runtime-launcher.ts:390`), **not** at `agent_runtime_sessions.started_at` (session-insert time).
- Equivalently, the health monitor's `starting`/`launching` sweep must not count scheduler-placement / image-pull latency that occurs before the container exists.
- Preserve the existing meaning of `started_at` for everything else that reads it (activity feed, analytics). If a new column/field is needed to record "runtime actually launched at", add it rather than overloading `started_at`. If you add a column, add a migration under `packages/db` and update the Drizzle schema in the same change.

### R2. The cold-start launch budget must be operator-configurable and separate from the heartbeat-loss timeout
- Introduce a dedicated launch/start timeout distinct from `heartbeatTimeoutMs`, with a default that comfortably accommodates scheduler placement plus container boot on a cold node (the plan author should pick a defensible default — materially larger than 30 s; e.g. 90–120 s — and justify it). The steady-state `heartbeatTimeoutMs` for `running` sessions should keep its current 30 s semantics unless there is a separate reason to change it.
- **No hard-coded magic numbers for operator-meaningful values.** The new timeout must come from operator config: `config/default.yaml` (with an inline comment) **and** the Zod schema in `packages/domain/src/config/schema.ts`, plumbed through `appConfig.worker.agents.*` the same way `healthCheckIntervalMs` is (`apps/worker/src/index.ts:684`, `:769`). See `docs/best-practices/configuration.md`.
- If an env var is added, update the matching `.env*.example` twin in the SAME change per `AGENTS.md`.

### R3. A start must not be failed when its first heartbeat has already been (or is being) processed
- The timeout path must be a no-op if the session has already transitioned to `running` (or has a `last_heartbeat_at`) — i.e. losing the race must favour the live container, never kill it. The current conditional updates already prevent a double-write, but the fix must guarantee that a heartbeat landing at/after the deadline cannot be stranded as "stale" against an already-torn-down session for a start that was in fact healthy. Closing the window in R1/R2 is the main lever; this is the backstop.

### R4. No false "Runtime Failed" for a runtime that launched and became healthy
- After the fix, the Oct-5 scenario (placement latency ~15 s, container healthy by ~06:33:46) must result in a **running** agent and **no** `RUNTIME_FAILED` alert.
- A genuine start failure (adapter launch error, container never boots, image missing, container exits during boot) must **still** be detected and must still fire `RUNTIME_FAILED` within a bounded time. Do not fix the false positive by disabling the timeout.

### R5. Fix the misleading "shut down gracefully" label on the start-timeout path
- The start-timeout path persists the session as `stopped` (`markSessionStartTimedOut`), and the activity-feed mapper renders a `stopped` session as "Agent runtime shut down gracefully" — which directly contradicts the "Runtime Failed" alert emitted 2 s later. The operator-facing feed for a start-timeout must read as a failure/timeout, not a graceful shutdown. Fix this in the activity mapper (`apps/api/src/routes/agent-activity-mapper.ts` and/or `agent-activity-types.ts`) and/or by distinguishing the terminal reason, without regressing the label for genuine graceful stops.

---

## 6. Must not regress

1. **Genuine start failures still fail fast.** Adapter launch error, container that never heartbeats, crash-on-boot → `RUNTIME_FAILED` still fires within a bounded, operator-configured window.
2. **Steady-state heartbeat-loss detection is unchanged.** A `running` session that stops heartbeating is still marked `unhealthy` on the existing 30 s `heartbeatTimeoutMs` (`markUnhealthy` path), independent of the new launch budget.
3. **Model-selection pre-flight still blocks launch.** The existing `config.model_selection_incomplete` guard (`agent-session-manager.ts`, around line 497) that stops an agent before launch when provider/light/heavy model are unset must still run and still persist `stopped`.
4. **First-boot activation side effects still run on first heartbeat.** `markSessionRunning`, `onSessionActive` (actor bootstrap), `activatedSessions`, `agent:sessions:count:*` / `agent:sessions:active`, wake prefs, `recordSessionStartedSkillUsage` — all unchanged (`agent-session-manager.ts` first-heartbeat block, ~lines 757–835).
5. **Worker-restart recovery is unchanged.** Survived `running`/`launching`/`unhealthy` sessions are still re-registered and reactivated on their next heartbeat (`registerSurvivedSessions`, first-heartbeat recovery). This bug and Bug Report 001's §3.2 both touch the first-heartbeat recovery block — coordinate; do not undo 001's paused-status guard if it has landed.
6. **Stop/delete reachability.** A timed-out or still-launching session must remain stoppable: `runtimeLauncher.stop(sessionId)` must still reach and purge the Nomad job (as it did at 06:33:42).
7. **The unique active-session index holds.** `uq_agent_runtime_sessions_active_agent` (schema line 29, `status NOT IN ('stopped','crashed')`) must not be violated — do not leave two non-terminal sessions for one agent.
8. **Strict TypeScript.** No `any`, `@ts-ignore`, `as unknown as`. `pnpm lint` passes.

---

## 7. Acceptance criteria

- [ ] R1–R5 implemented.
- [ ] Every item in §6 holds.
- [ ] New operator config key(s) added to `config/default.yaml` with an inline comment **and** to the Zod schema in `packages/domain/src/config/schema.ts`, plumbed through `appConfig.worker.agents.*`. `.env*.example` twins updated in the same change only if an env var was added (per `AGENTS.md`).
- [ ] Any new DB column has a migration under `packages/db` and a matching Drizzle schema update.
- [ ] Every test in §8 is added and passing.
- [ ] `pnpm lint` passes. `pnpm build` passes. `pnpm test` passes for `apps/worker`, `packages/db`, and `packages/domain` (and `apps/api` if the activity mapper is changed for R5).
- [ ] This report is updated: Status → FIXED, plus a **Fix** section (files changed), a **Verification** section (commands run + results), and any deliberate deviations with reasons.

---

## 8. Required tests

Test names describe behaviour, not implementation (repo rule). Put them next to the closest existing tests.

**Health monitor / timeout accounting (R1, R2, R3)** — `apps/worker/src/agents/agent-health-monitor.test.ts`
1. "does not time out a starting session when the runtime launched within the launch budget even though session creation was earlier" (simulate placement latency: `started_at` old, runtime-launched-at recent).
2. "times out a starting session only after the launch budget elapses from runtime launch, not from session creation".
3. "still marks a running session unhealthy on the existing heartbeat-loss timeout" (regression — the two budgets are independent).
4. "does not fire a start timeout once the session has transitioned to running / has a last_heartbeat_at".

**Session manager (R3, R4)** — `apps/worker/src/agents/agent-session-manager.test.ts`
5. "a first heartbeat arriving just before the deadline marks the session running and no RUNTIME_FAILED alert is sent".
6. "a genuine start failure (no heartbeat within the launch budget) still fires RUNTIME_FAILED and persists the agent as stopped/crashed".
7. "the model-selection pre-flight still blocks launch and persists stopped" (regression).

**Repository (R1, R3)** — `packages/db/src/agent-repository.test.ts`
8. "markSessionStartTimedOut does not stop a session that is already running".
9. "markSessionRunning promotes a starting session and records last_heartbeat_at".
10. If a new "runtime launched at" column is added: "records the runtime-launched-at timestamp distinct from started_at".

**Activity mapper (R5)** — `apps/api/src/routes/agent-activity-mapper.test.ts` (or the nearest existing mapper test)
11. "renders a start-timeout session as a failure/timeout, not a graceful shutdown".
12. "still renders a genuinely graceful stop as a graceful shutdown" (regression).

If the pure timeout decision is awkward to test through the monitor, extract it into a small pure helper (inputs: `runtimeLaunchedAt`/`startedAt`, `now`, `launchBudgetMs`, current status, `lastHeartbeatAt`; output: time-out yes/no) and unit-test that directly, keeping the monitor wiring thin.

---

## 9. Out of scope (note in the Fix section if relevant)

- Reducing Nomad scheduler placement latency itself (infra tuning, image pre-pull/caching on nodes). The fix must tolerate placement latency, not eliminate it.
- Retrying a failed start automatically. Current behaviour leaves the agent `stopped`; a user re-click starts a fresh session. Auto-retry is a separate feature.
- Bug Report 001 (paused agents keep ticking / worker restart un-pauses). Different defect in the same first-heartbeat recovery block — coordinate but do not conflate.
- Reconciling or replaying the LLM work that the killed container performed before being purged (the dispatched scout/LLM call on the Oct-5 run). The container is torn down; that work is discarded. Acceptable.

---

## 10. Related code

- `apps/worker/src/agents/agent-health-monitor.ts` — `checkHealth` (two sweeps), `DEFAULT_CONFIG` (~line 68), `handleStartTimeout` call (~line 90).
- `apps/worker/src/agents/agent-session-manager.ts` — `startSession` (:272), `launch` call (:531), first-heartbeat `markSessionRunning` + recovery block (~:757–835), `handleStartTimeout` (:934), `RUNTIME_FAILED` fire (:965).
- `apps/worker/src/agents/agent-runtime-launcher.ts` — `launch` (:331), `portResult.data.startedAt` (:390).
- `packages/db/src/agent-repository.ts` — `createSession` (:308), `markSessionRunning` (:448), `markSessionStartTimedOut` (:464).
- `packages/db/src/schema/agent-runtime-sessions.ts` — `status` default (:15), `started_at` default (:21), unique active-session index (:29).
- `apps/worker/src/alerting/platform-alert-service.ts` — `RUNTIME_FAILED` (:30), label mapping (:167).
- `apps/worker/src/index.ts` — health monitor wiring, `healthCheckIntervalMs` (:684, :769).
- `apps/api/src/routes/agent-activity-mapper.ts` / `agent-activity-types.ts` — "shut down gracefully" rendering (R5).
- `config/default.yaml` (`agentRuntime` / `worker.agents`), `packages/domain/src/config/schema.ts` — operator config for the new launch budget.
- `docs/best-practices/configuration.md` — config layering and no-magic-numbers rule.
