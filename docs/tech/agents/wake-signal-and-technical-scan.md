# Wake Signal and Technical Scan Delivery

This document is the canonical technical reference for how **wake signals** and **technical-scan results** are delivered to an agent runtime, and why the delivery architecture has a subtle two-consumer-group race that the code must handle deterministically.

It grounds the current logic in deterministic, understanding-fostering language. It complements (not replaces) the incident record in `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md` and the implementation plan in `docs/features/2026/08/05/001-fix-wake-consumer-group-race/001-plan.md`.

---

## 1. The outbound stream and its two consumer groups

The worker publishes platform→agent messages (including `agent.wake` and `agent.technical.scan_completed`) to a **single** Redis stream per agent: `agent:outbound:<agentId>` (`apps/worker/src/agents/instance-event-publisher.ts`).

Two consumer groups read that same stream:

| Group | Polling | Purpose |
|---|---|---|
| `agent-market-wake` | **Continuous** (`pollWakeSignals`, `WAKE_SIGNAL_POLL_MS`) | Consumes `agent.wake` → schedules an early tick (`requestWakeDrivenTick`) |
| `agent-runtime` | **Once per tick** (`readOutboundMessages`, `COUNT 10`) | Consumes ALL messages, including `agent.wake` and `agent.technical.scan_completed` |

### The one-message-per-group invariant

**Redis Streams delivers each message to only ONE consumer group.** When the `agent-market-wake` group consumes an `agent.wake` message, the `agent-runtime` group does **not** receive it, and vice-versa.

This invariant is the root cause of the race described below. It is non-obvious and easy to miss — which is why it is documented here and called out in the code comments at `pollWakeSignals()` and `readOutboundMessages()`.

---

## 2. The wake lifecycle

1. The worker publishes an `agent.wake` message to `agent:outbound:<agentId>`.
2. `pollWakeSignals()` (wake group) reads it and calls `requestWakeDrivenTick()`, which schedules an early tick (bounded by `wake.minIntervalMs`, default 15s).
3. **The wake group buffers the full wake envelope** into `pendingWakeSignalBuffer` via `bufferWakeEnvelope()` (`apps/worker/src/runtime-composition.ts`). This is done unconditionally (regardless of `promptStyle`) because the wake context must survive even if the runtime group never sees the message.
4. When the early tick fires, `runTick()` drains the newest buffered wake into `runtimeState.metrics.currentMarketWake` via `drainNewestWakeIntoMarketWake()` — **only if** the runtime group did not already set it.
5. `runTick()` sets `hasBufferedWake = true` when a wake was drained, and passes it to `buildTickGateState()`.
6. `buildTickGateState()` computes `hasWakeSignal = incomingMessages.some(agent.wake) || hasBufferedWake === true`. This unblocks the hybrid no-wake guard and the hybrid-evaluator routing.

### Why the wake must be buffered (not re-read)

Because the wake group and the runtime group race for the same `agent.wake` message, and Redis delivers it to only one group, the runtime group may never see the wake. If the tick relied on re-reading the wake from the stream, it would find nothing and log `"timer tick without wake signal"`. Buffering the envelope in the wake group and draining it into `currentMarketWake` decouples wake-context delivery from which group won the race.

---

### Paused agents

When `agents.status = 'paused'` the runtime does no wake-driven work (bug `docs/bug-reports/2026/10/05/001-paused-agent-keeps-ticking.md`):

- `pollWakeSignals()` ACKs `agent.wake` without buffering it or calling `requestWakeDrivenTick()`. A `user.message` only sets `pendingUserMessage`; no early tick is requested.
- Paused ticks (at `min(tick interval, agentRuntime.pause.statusPollMs)`) keep reading the runtime group so `MAXLEN` trimming cannot drop user messages. What they read is held in a bounded queue (`agentRuntime.pause.maxHeldMessages`) and fed, in order, into the first resumed tick.
- `agent.wake` envelopes read by the runtime group while paused are **dropped, not held**. In practice the runtime group also receives `agent.wake` (Redis delivers every entry to every consumer group), and replaying them on resume would present stale market signals as current. On pause, `pendingWakeSignalBuffer` and `currentMarketWake` are cleared too.
- The first resumed tick is forced past the context-hash gate (treated like a buffered wake).

Pure logic lives in `apps/worker/src/runtime-pause.ts`.

---

## 3. Reminders

Reminders are a wake source an agent schedules for itself. A reminder record lives in the Redis hash `agent:reminders:<agentId>` (field = reminder UUID), and the `ReminderCoordinator` (`apps/worker/src/reminder-coordinator.ts`) polls for due records and emits an `agent.wake` with `source: 'reminder'`. A reminder wake sets `hasWakeSignal`, so it bypasses the context-hash gate like any other wake.

### One-shot vs repeating, and `key` replacement

- A reminder scheduled with `schedule_reminder` and no `repeatEveryMinutes` is **one-shot**: it fires once and the coordinator deletes the record.
- A reminder scheduled with `repeatEveryMinutes` is **repeating**: when it fires, the coordinator re-schedules the record on its original grid (`advanceRepeatingReminder` in `apps/worker/src/reminders/reminder-schedule.ts`) instead of deleting it.
- An optional `key` names a reminder. Scheduling again with an existing `key` **replaces** the record in place — the old field is removed, a new `reminderId` is written, and the result reports `replaced: true` with `previousReminderId`. This is how an agent adjusts a routine without accumulating duplicates; there is no edit-in-place.

### The coordinator lease

The coordinator must run on **one worker at a time**. Before each poll it acquires a short-lived Redis lease (`SET reminder-coordinator:lease <workerId> EX <ttl> NX`, renewed while held, released on `stop()`). A worker that does not hold the lease skips the poll. Without the lease, more than one worker could fire the same reminder twice.

### Missed occurrences

The coordinator only polls agents with status `active`, so occurrences that come due while an agent is stopped are not fired then. When the agent is active again, a due repeating reminder fires **once** and the wake reports `missedOccurrences` (the number of grid slots already past, excluding the one being fired). The schedule continues on its original slots — missed occurrences are not replayed one-by-one.

### Reminders and user messages bypass active hours

The session (active-hours) gate in `shouldSkipTick` (`apps/worker/src/tick-gates.ts`) skips a tick only when it is neither a user-message tick nor a reminder-wake tick. Reminder wakes and user messages therefore always reach the agent, even outside its active hours. Market wakes and plain scheduled ticks still respect the gate.

---

## 4. The technical-scan lifecycle

1. The worker's technical scanner runs every `scanIntervalMs` (default 60s) and produces a `TechnicalScanState`.
2. The scan producer now lives Traderton-side (the in-process `complete-technical-scan.ts` scanner was removed with the L3d-5 actor slice). Traderton emits an `agent.technical.scan_completed` message, which herobids consumes over the boundary into the same `agent:outbound:<agentId>` stream (`apps/worker/src/scan-types.ts` defines the DTO; `apps/worker/src/agents/instance-event-publisher.ts` still carries the publisher seam).
3. The `agent-runtime` group consumes it via `readOutboundMessages()`, and `applyRuntimeMessage()` calls `recordTechnicalScan()` to update `runtimeState.metrics.lastTechnicalScan` (`apps/worker/src/runtime-composition.ts`).
4. The hybrid evaluator reads `lastTechnicalScan` and checks freshness via `isTechnicalScanFresh()` (`apps/worker/src/hybrid-agent-evaluator.ts`), which rejects any scan older than `2 × scanIntervalMs` (120s) with a `stale_scan` error.

### The downstream lag concern

Because the `agent-runtime` group only drains once per tick with `COUNT 10`, and the scanner produces ~1 message/min, the group can fall behind a fast scan cadence. When it lags, `lastTechnicalScan` is stale by the time the evaluator runs → `stale_scan` abort. The wake fix decouples wake-driven ticks from this lag, but a fuller fix for scan-state delivery is a separate follow-up (see the plan's Out of Scope).

---

## 5. The race condition and the fix

### The race

Both `agent.wake` and `agent.technical.scan_completed` are on the same stream. The wake group polls continuously; the runtime group reads once per tick. For the runtime group to see a wake, it must read the message in the brief window before the wake group's next poll consumes it. Whether the runtime group wins is **timing-dependent** (server load, Redis latency, concurrency).

### Evidence it is a latent, non-deterministic race

| Run | Wakes received | Wakes reaching runtime group | Result |
|---|---|---|---|
| 07/25 scalper | 25 | 23 (92%) | ✅ traded |
| 08/05 thyper | 36 | 19 (53%) | ❌ zero trades |

The same code, different outcomes — because the race resolved differently. This is why the bug did not manifest in earlier runs: they happened to win the race more often.

### The fix

The fix does not try to "win" the race. It **eliminates the dependency on the race outcome**:

1. Buffer the full wake envelope in the wake group (`bufferWakeEnvelope`).
2. Drain it into `currentMarketWake` at tick start (`drainNewestWakeIntoMarketWake`).
3. Make `hasWakeSignal` true when a wake was drained (`hasBufferedWake` in `buildTickGateState`).

After the fix, the tick sees the wake context no matter which group consumed the message.

---

## 6. Key source references

| File | Symbol | Role |
|---|---|---|
| `apps/worker/src/agent.ts` | `pollWakeSignals` | Wake group: consumes `agent.wake`, buffers envelope, schedules early tick |
| `apps/worker/src/agent.ts` | `readOutboundMessages` | Runtime group: drains all messages once per tick |
| `apps/worker/src/agent.ts` | `runTick` | Drains buffered wake into `currentMarketWake`, sets `hasBufferedWake` |
| `apps/worker/src/runtime-composition.ts` | `bufferWakeEnvelope` | Extracts full wake envelope from an `agent.wake` payload |
| `apps/worker/src/runtime-composition.ts` | `drainNewestWakeIntoMarketWake` | Drains newest buffered wake into `currentMarketWake` |
| `apps/worker/src/runtime-composition.ts` | `applyRuntimeMessage` | Runtime-group path: sets `currentMarketWake` from validated wake |
| `apps/worker/src/tick-gate-state.ts` | `buildTickGateState` | Computes `hasWakeSignal` (includes `hasBufferedWake`) |
| `apps/worker/src/hybrid-agent-evaluator.ts` | `isTechnicalScanFresh` | Rejects stale scans (`2 × scanIntervalMs`) |
| `apps/worker/src/agents/instance-event-publisher.ts` | `emitTechnicalScanCompleted` | Publishes `agent.technical.scan_completed` (producer is Traderton-side; herobids consumes) |

---

## 7. Related documents

- **Bug report:** `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- **Implementation plan:** `docs/features/2026/08/05/001-fix-wake-consumer-group-race/001-plan.md`
- **Message catalog:** `docs/tech/agents/message-catalog.md`
- **Runtime boundary:** `docs/tech/agents/runtime-boundary-and-message-contract.md`
