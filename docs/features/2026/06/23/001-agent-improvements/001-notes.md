## Issue 1: Container Lifecycle Management — Orphaned Containers

Between sessions 1 and 2, the old container attempted reconnection with ~140 pairs of tick.started/tick.skipped at 90-second intervals over 2 hours. The worker correctly ignored these as stale, but it reveals a container lifecycle management issue.

### Root Cause

The bug is in `AgentRuntimeLauncher.stop()` at `apps/worker/src/agents/agent-runtime-launcher.ts:218`:

```ts
async stop(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) return;  // ⚠️ SILENT NO-OP — container keeps running!
    ...
}
```

When the in-memory `RuntimeHandle` is missing, `stop()` returns silently **without touching the Docker container**. The handle can go missing when:

1. **Worker restarts** — `this.runtimes` is an in-memory `Map`, lost on process restart
2. **Health monitor pre-cleans** — `AgentHealthMonitor.checkHealth()` calls `runtimeLauncher.removeHandle()` for sessions marked stopped/crashed in the DB, which deletes the handle before `stop()` can use it

The health monitor's cleanup logic at `agent-health-monitor.ts:96` explicitly chooses `removeHandle` over `stop()`:

```ts
// "Use removeHandle (not stop) — the container already exited"
this.runtimeLauncher.removeHandle(session.id);
```

But this assumption is wrong if the container is **still running** (e.g., the Docker daemon hasn't reported the die event yet, or the stop attempt failed).

### The Sequence That Produced the Stale Tick Storm

```
1. Session 1 stopped via API → stopSession() called
2. Worker restarted (or handle was already removed by health monitor)
3. runtimeLauncher.stop(session1) → handle missing → NO-OP → container NOT stopped
4. Session marked "stopped" in DB, but container keeps running
5. Container's agent loop continues: sends heartbeats → rejected (session is "stopped")
6. Container's tick loop continues: sends agent.tick.started/skipped → rejected ("Stale session")
7. This continues for ~2 hours (11:30 → 13:36 UTC)
8. Session 2 starts → DockerAgentManager.start() calls removeExistingContainer()
9. Old container finally killed → Docker die event → "Ignoring stale container exit" ✓
```

### The Reconnect Storm (1,779 events) Revisited

The 1,779 count I reported was inflated — it included normal bootstrap reconnects (3 log lines per heartbeat during initial connection), not just the stale ones. The actual anomaly is the **stale tick messages** (~140 pairs of `tick.started`/`tick.skipped` at 90-second intervals over 2 hours), which are a separate symptom of the same root cause.

### Fix

`AgentRuntimeLauncher.stop()` should handle the missing-handle case by looking up the container by agent ID and stopping it directly:

```ts
async stop(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) {
      // Handle missing — try to stop by agent ID from the session record
      const session = await this.agentRepo.getSession(sessionId);
      if (session && this.mode === 'docker') {
        await this.dockerManager!.stop(session.agentId);
      }
      return;
    }
    // ... existing logic
}
```

Additionally, the health monitor should call `stop()` (not `removeHandle()`) when it can't confirm the container has already exited:

```ts
// In AgentHealthMonitor.checkHealth():
// Instead of unconditionally calling removeHandle:
if (this.dockerManager) {
  // Verify container state first
  await this.runtimeLauncher.stop(session.id);
} else {
  this.runtimeLauncher.removeHandle(session.id);
}
```

---

## Issue 2: Reconciliation Loop Silence (10.9 Hours)

The worker's agent-actor reconciliation loop stopped logging after ~6 minutes into session 2 — a 10.9-hour silence before the crash was detected. This suggests the internal state loop was already broken.

### Root Cause

The `Reconciler.runPass()` at `packages/engine/src/reconciliation/reconciler.ts:95` silently returns `null` when venue state fetch fails:

```ts
async runPass(): Promise<ReconciliationResult | null> {
    if (!this.running) return null;
    if (this.passing) return null;
    this.passing = true;
    try {
      const venueState = await this.fetchVenueState();
      if (!venueState) return null;  // ⚠️ Silent skip — no log, no alert
      // ... reconcile, persist, journal ...
    } finally {
      this.passing = false;
    }
}
```

When `fetchVenueState()` returns `null` (Hyperliquid API timeout, rate limit, network blip), the reconciler **silently skips** the pass. The `setInterval` timer keeps firing every 30 seconds, but every pass returns `null` with zero logging. This creates the appearance of a "broken loop" when in reality the loop is running perfectly — it's just producing null results.

The `fetchVenueState` is created by `createOrderbookVenueStateLoader` which queries the Hyperliquid API for the account's positions/orders. In shadow mode, the Hyperliquid account has no real positions (all trading is simulated), so the venue state should return empty positions. But if the **API call itself fails** (network error, timeout), the loader returns `null`.

### Why 10.9 Hours?

The Hyperliquid API or the network connection between the Hetzner server and Hyperliquid's API may have been intermittently failing. Each failed `fetchVenueState` call silently returns `null`, and the reconciler skips that pass. The `setInterval` continues firing. No error is logged because the `Reconciler` class treats `null` venue state as a normal condition ("can't reach venue, try again next pass"), not an error.

### Why It Resumed in Session 3

When session 3 started with a fresh container and fresh network connections, the Hyperliquid API calls succeeded again → venue state loaded → reconciliation passes started producing output → logs appeared.

### The Deeper Problem

Even when the reconciler silently skips, the `AgentTradingActor` has no visibility into this. The actor's other functions (order execution, position tracking, private stream) continue operating. The actor doesn't know its reconciler is effectively dead. This is dangerous because:

1. **Drift accumulates undetected** — local positions diverge from venue reality with no detection
2. **No alert fires** — platform alerts only trigger on explicit errors, not silent null returns
3. **The health monitor can't see it** — heartbeats continue, actor appears healthy

### Fix

1. **Log null venue state at warn level** in `Reconciler.runPass()`:
   ```ts
   if (!venueState) {
     this.deps.logger?.warn('Reconciliation skipped — venue state unavailable');
     return null;
   }
   ```

2. **Add a staleness counter** that fires an alert after N consecutive null passes:
   ```ts
   private consecutiveNullPasses = 0;
   // In runPass():
   if (!venueState) {
     this.consecutiveNullPasses++;
     if (this.consecutiveNullPasses >= 10) {
       // Fire alert: reconciler hasn't reached venue for 5 minutes
     }
     return null;
   }
   this.consecutiveNullPasses = 0;
   ```

3. **Expose reconciler health** to the `AgentTradingActor` so it can report reconciliation status in heartbeats, allowing the health monitor to detect a "running but blind" actor.

---

## Issue 3: Visibility into block lifting

The agent currently calls `get_analytics` and `get_risk_limits` to understand its state, but neither tells it **when** the block will lift. We could add a **when** block to `get_risk_limits`.**:

**What `get_risk_limits` currently returns**

```ts
{
  limits: {
    maxOpenPositions:  { value: 2, source: "creator", mutable: false, ceiling: 10 },
    maxPositionSizePct: { value: 40, source: "agent_override", mutable: true, ceiling: 100 },
    stopLossPct:        { value: 10, source: "operator_default", mutable: true, ceiling: 50 },
    stopLossCooldownMs: { value: 300000, source: "operator_default", mutable: true, ceiling: 3600000 },
  }
}
```

Static configuration only. The agent sees the limits but has **no idea** how close it is to hitting them — or that it already has.

**What it should additionally return**

```ts
{
  limits: { /* same as above */ },
  runtime: {                                          // ← NEW
    dailyLoss: {
      current: "23.99",
      limit: "19.76",
      limitPct: 2,
      blocked: true,
      oldestFillAgesOutAt: "2026-06-23T23:58:27Z",
      remainingMs: 66420000,
    },
    drawdown: {
      current: "17.84",
      limit: "200.00",
      approaching: false,
    },
    openPositions: {
      current: 0,
      limit: 2,
      blocked: false,
    },
  }
}
```

**We could get a better name than `runtime`**

**Why `get_risk_limits` is the right home**

| Consideration | `get_risk_limits` | `get_analytics` | New tool |
|---|---|---|---|
| Agent already calls it before `submit_decision`? | ✅ Yes | Sometimes | Would need new call |
| Conceptually about risk state? | ✅ Yes — limits + runtime status | Partially — P&L, exposure | Yes |
| Avoids extra LLM round-trip? | ✅ One call instead of two | Same | ❌ Adds a call |
| Natural grouping? | ✅ "What are my guardrails and where do I stand?" | ❌ Analytics is backward-looking | ✅ But unnecessary |

The agent's current broken pattern is:

```
1. get_risk_limits  → "limit is 2%"
2. submit_decision  → REJECTED ("daily loss $23.99 > $19.76")
3. get_analytics    → "oh, I lost $23.99 today"
```

Adding `runtime` to `get_risk_limits` collapses this to:

```
1. get_risk_limits  → "limit is 2%, you're at 2.4%, blocked for 18.5h"
2. (agent doesn't bother calling submit_decision)
```

One call, complete picture, no wasted submission. The `runtime` field should be present **unconditionally** — not gated behind a parameter — so the agent can't accidentally skip checking it.

This eliminates the guesswork and prevents the agent from repeatedly testing the gate.

---

## Issue 4: Crash Telemetry

When an agent crash, we have no-post crash insight into what caused the crash, if the container is re-started.

We could add `uncaughtException` / `unhandledRejection` handlers that write crash telemetry before exit.

### What we add (in agent.ts, near the top after Redis/deps are initialized)

```ts
// ── Crash telemetry ──────────────────────────────────────────────────────

const CRASH_LOG_PATH = '/workspace/crash.log';

let crashHandlerArmed = false;

function armCrashHandlers(): void {
  if (crashHandlerArmed) return;
  crashHandlerArmed = true;

  const writeCrashTelemetry = (kind: string, error: Error): void => {
    // 1. Write to local file FIRST — no network, always works even near-OOM
    const crashRecord = JSON.stringify({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      kind,
      message: error.message,
      stack: error.stack?.slice(0, 2000),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      timestamp: new Date().toISOString(),
    });
    try {
      require('fs').appendFileSync(CRASH_LOG_PATH, crashRecord + '\n');
    } catch { /* disk full — nothing we can do */ }

    // 2. Best-effort Redis publish with 2s timeout (process may be dying)
    const deadline = Date.now() + 2000;
    const attempt = (): void => {
      if (Date.now() > deadline) {
        process.exit(1);
      }
      publishToInbound(AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED, {
        sessionId: SESSION_ID!,
        reasonCode: `crash.${kind}`,
        detail: error.message.slice(0, 500),
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      }).then(() => process.exit(1))
        .catch(() => setTimeout(attempt, 100));
    };
    attempt();
    // Hard deadline: exit after 3s no matter what
    setTimeout(() => process.exit(1), 3000);
  };

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — writing crash telemetry');
    writeCrashTelemetry('uncaught_exception', error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err: error }, 'Unhandled rejection — writing crash telemetry');
    writeCrashTelemetry('unhandled_rejection', error);
  });
}

// Call at startup, right after Redis connects and AGENT_ID/SESSION_ID are validated:
armCrashHandlers();
```

### What changes on the worker side

The worker's agent-session-manager.ts already handles `session_ended` messages at `handleRuntimeSessionEnd()`. No code change needed — the worker will receive the crash telemetry just like a normal `session_ended`, but with:
- `reasonCode: "crash.uncaught_exception"` or `"crash.unhandled_rejection"`
- `detail: "JavaScript heap out of memory"` (the actual error)
- `heapUsedMB: 487` (how close to the 512 MB limit we were)

### What the crash log file gives us

Even if Redis is unreachable (network dead, event loop blocked), the `/workspace/crash.log` file survives because:
- `/workspace` is a Docker volume/bind mount in the container
- The file is written synchronously with `appendFileSync` — no async I/O needed
- On the next container start, the startup sequence can check for a previous crash log and log it

### Where this fits in the startup sequence

```
1. process.env validation (AGENT_ID, SESSION_ID, etc.)
2. Redis connect
3. DB connect
4. armCrashHandlers()          ← INSERT HERE (after deps, before main loop)
5. Sandbox enforcer init
6. Tool registry init
7. Main reasoning loop (runTick)
```

### Why this works even near-OOM

The `writeCrashTelemetry` function:
- Allocates only one string (the JSON payload) — minimal heap pressure
- Uses `fs.appendFileSync` — writes directly to the OS buffer, doesn't need the event loop
- Has a 3-second hard deadline — if Redis is stuck, the process exits anyway
- Is guarded against recursive crashes (`crashHandlerArmed` flag)
- Catches its own errors — if the disk is full, it just exits silently

---

## Implementation Status (2026-06-23)

All four issues have been implemented and committed:

| # | Issue | Commit | Status |
|---|-------|--------|--------|
| 1 | Container Lifecycle Management — Orphaned Containers | `1799406` | ✅ DONE |
| 2 | Reconciliation Loop Silence (10.9 Hours) | `70c4cbd` | ✅ DONE |
| 3 | Visibility into block lifting (`runtime` in `get_risk_limits`) | `1cfbf04` | ✅ DONE |
| 4 | Crash Telemetry | `d9eb87f` | ✅ DONE |

---

## Outstanding Issues (Post-Implementation Code Review)

### [Issue 1] Container Lifecycle Management

- **MEDIUM**: Duplicated fallback logic in `stop()` and `kill()` — ~20 lines nearly identical. Extract private helper `stopMissingHandle()` for DRY. (Maintainability, not correctness)
- **LOW**: Awkward phrasing in `kill()` log message — "killed" appears twice.
- **LOW**: Redundant defensive guard for `agentRepo` — constructor guarantees it in Docker mode, but guard is harmless.
- **LOW (pre-existing)**: `stop()` and `kill()` are behaviorally identical (both use 10s grace). Naming is misleading but documented intent.
- **LOW (pre-existing)**: Heartbeat timer cleared before Docker stop may throw — if Docker stop throws, heartbeat is gone but handle stays in map.

### [Issue 2] Reconciliation Loop Silence

- **MEDIUM (M-N1)**: `healthy` flag scope too narrow — doesn't account for error-induced blindness (`fetchVenueState` throws). Error passes ARE logged separately (at error level) so log-based alerting covers this, but heartbeat-based health monitoring would miss it. Consider broadening `healthy` to account for error passes, or rename to `venueReachable`.
- **LOW (L-N1)**: Repeated error alert on every pass after threshold — could be noisy (120 logs/hour during prolonged outage). Consider rate-limiting future alerts (e.g., fire once, then again every N minutes).
- **LOW (L-N2)**: Alert duration test uses `expect.any(Number)` instead of verifying exact computed value.

### [Issue 3] Visibility into block lifting

- **MEDIUM (N1)**: Missing test for `dailyMaxLossPct === 0` convention (treated as unlimited). Code logic is correct (`limitNum > 0` guard), but no test verifies this documented convention.
- **LOW (N2)**: Asymmetric `dailyLossCurrent` default — `'0'` when `botRepo` absent, `null` when query fails. Subtle but intentional.
- **LOW (N3)**: Floating-point string conversion for dailyLossLimit can produce artifacts (e.g., `"500.00000000000006"`). Consider `.toFixed(2)` or a decimal library.
- **LOW**: Test `botRepo` mock duplication — extract `makeBotRepo` helper to reduce boilerplate.
- **LOW**: `blpop` added to redis mock unnecessarily in test file.
- **LOW**: Hardcoded 24-hour sliding window for daily loss — consider reading from operator config in a future iteration.

### [Issue 4] Crash Telemetry

- **LOW**: No test coverage for crash telemetry (inherently hard to test — involves `process.exit`, `process.on('uncaughtException')`, and filesystem I/O). Key logic (settled flag state machine, `shuttingDown` guard, deadline/retry orchestration) could be extracted and unit-tested.
- **LOW**: Cross-invocation duplicate prevention is only partial — both `uncaughtException` and `unhandledRejection` get separate `settled` flags. Benign since Node.js typically fires only one per error, and the first `process.exit(1)` wins.
- **LOW**: `CRASH_LOG_PATH` hardcoded to `/workspace/crash.log` — only exists inside Docker containers. Consider making configurable via env var.
- **LOW**: Crash payload has extra fields (`detail`, `heapUsedMB`) not in `SessionEndedPayloadSchema` — silently stripped by Zod validation on the consumer side. Either add them to the schema or accept they'll be discarded.
- **LOW**: `logger.fatal` not wrapped in try/catch in crash handlers — if pino's `fatal` throws (e.g., stream broken), falls back to Node's default uncaughtException handler. Not dangerous but could be more robust.
- **LOW**: Race between crash telemetry and graceful shutdown if SIGTERM arrives during active crash handler retry — both may race to call `process.exit`. Acceptable since the process is already in an unrecoverable state.