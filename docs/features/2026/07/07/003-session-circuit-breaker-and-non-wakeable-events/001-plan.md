# 003 — Session Circuit Breaker & Non-Wakeable Events

## Problem

Across seven eval sessions on 2026-07-06, the platform burned **24.2M input tokens** and **4.1M output tokens** while producing only ~150 useful trading decisions. The primary waste pattern is **semantic loops**: the agent's LLM is invoked repeatedly to reason about broken or unchanged state (strategy errors, drift avalanches, stream disconnects) with no prospect of a different outcome.

### Evidence (2026-07-06 evals)

| Session | strategy.error | drift_detected | stream.disconnect | Input tokens | Fills | Diagnosis |
|---------|---------------|----------------|-------------------|-------------|-------|-----------|
| 4aa54197 | 17,114 | 1,319 | 1,425 | 3.58M | 6 | Error loop: strategy crashing in tight loop |
| 1707c8ce | 0 | 1,494 | 5 | 1.08M | 2 | Drift loop: no decisions after first minute |
| 69c1c1a6 | 0 | 1,497 | 0 | 4.86M | 17 | Drift + bot-count violation |
| 6842606f | 0 | 1,008 | 3 | 3.31M | 29 | Drift from phantom bot instances |
| 2af32e13 | 0 | 1,286 | 5 | 3.96M | 28 | Drift + fatal crash cascade |
| 176bea51 | 0 | 1,132 | 0 | 3.08M | 13 | Drift but functional trading |
| fb894931 | 0 | 1,502 | 3 | 4.35M | 26 | Drift + fatal |

**Key insight:** The existing `FailureBackoffController` only handles *infrastructure* failures (LLM 429s, Redis down). It does not see *semantic* waste where the tick succeeds but produces no actionable output. The context-hash gate cannot suppress these ticks because drift events change the context snapshot slightly each pass.

## Goals

1. **Session-level circuit breaker**: Stop LLM invocations when the session is in an unrecoverable error/drift loop.
2. **Non-wakeable events**: Prevent events that the agent cannot act on from triggering LLM ticks.

Read: docs/best-practices/agent-runtime.md

## Design

### Part A — Session Circuit Breaker (`SessionCircuitBreaker`)

A new class in `apps/worker/src/runtime-resilience.ts` that tracks session-level event counters and decides whether to suppress LLM invocations.

#### Tracked event categories

| Category | Source | Counter logic |
|----------|--------|---------------|
| `strategy_error` | Journal `strategy.error` events from bot trading actors | Sliding window: count in last T minutes |
| `strategy_fatal` | Journal `strategy.fatal` events | Cumulative (any single fatal is significant) |
| `drift_detected` | Journal `reconciliation.drift_detected` events | Sliding window: count in last T minutes |
| `stream_disconnect` | Journal `stream.disconnect` events | Sliding window: count in last T minutes |

#### Thresholds (operator config in `config/default.yaml`)

```yaml
agentRuntime:
  sessionCircuitBreaker:
    enabled: true
    strategyError:
      maxInWindow: 10          # max strategy.error events in windowMs before tripping
      windowMs: 60000          # 1 minute sliding window
    drift:
      maxInWindow: 5           # max drift detections in windowMs before tripping
      windowMs: 300000         # 5 minute sliding window  
    streamDisconnect:
      maxInWindow: 5           # max disconnects in windowMs before tripping
      windowMs: 300000         # 5 minute window
    cooldownMs: 300000         # 5 min cooldown: suppress LLM, keep heartbeat alive
    maxTrips: 3                # after N trips in one session → terminate
    probeIntervalMs: 60000     # while in cooldown, run one probe tick every 60s to check recovery
```

#### State machine

```
CLOSED → [threshold breached] → OPEN (cooldown)
OPEN   → [cooldownMs elapsed] → HALF_OPEN (probe)
HALF_OPEN → [probe succeeds, no errors] → CLOSED
HALF_OPEN → [probe fails] → OPEN (reset cooldown)
OPEN   → [maxTrips reached] → TERMINATED (session shutdown)
```

#### Integration point

In `agent.ts`, between tick scheduling and LLM invocation:

```typescript
// Before LLM dispatch in runTick()
if (sessionCircuitBreaker.isOpen()) {
  logger.warn({ state: sessionCircuitBreaker.state }, 'Session circuit breaker open — suppressing LLM');
  scheduleNextTick(sessionCircuitBreaker.probeIntervalMs);
  return;
}
```

#### Event feeding

The `AgentTradingActor` already emits journal events. We add a lightweight callback from the journal append path to feed the breaker:

```typescript
// In agent.ts, when constructing trading actor deps:
onJournalEvent: (event) => sessionCircuitBreaker.record(event.type),
```

#### Recovery/reset

- A successful fill (`fill.recorded` journal event) resets all counters.
- A successful decision acceptance resets the drift counter.
- A clean reconciliation pass (`reconciliation.match`) decrements the drift counter.

### Part B — Non-Wakeable Events

#### Problem restatement

The agent is woken (or kept active) by events it cannot meaningfully act on. In a hybrid agent, each wake = one LLM invocation minimum. Events that produce no actionable change should either:
1. Not produce wake signals at all, OR
2. Be filtered before they reach the wake path

#### Events to make non-wakeable

Based on the eval data, the following event patterns should **NOT** trigger agent wakes or bypass the tick gate:

| Event | Current behavior | Proposed behavior | Rationale |
|-------|-----------------|-------------------|-----------|
| `reconciliation.drift_detected` | Goes to journal + context snapshot changes slightly → tick passes context-hash gate | Do not emit context snapshot when reconciler detects drift-only state; journal only | Drift is an infrastructure signal the agent cannot fix; it just triggers useless LLM reasoning about position mismatches |
| `stream.disconnect` | Goes to journal; may cause reconnect handler to emit new context snapshots | Reconnect handler should NOT emit context snapshots during drift-only reconnects; only on genuine position changes | Reconnects in a broken state flood the agent with stale snapshots |
| `strategy.error` (bot) | Goes to journal only (no wake) | No change needed — already non-wakeable | Already correct, but the tick timer still fires and the agent reasons about errors via the activity timeline |
| `reconciliation.drift_within_threshold` | Goes to journal only | No change needed | Already benign |

#### Implementation: Drift-suppressed context snapshots

The key mechanism is: when the `AgentTradingActor`'s reconciler detects drift but no actual position change (same side, same size within threshold), it should **not** emit a new `instance.context.snapshot` to the outbound stream. This prevents the context-hash gate from seeing a "changed" context.

```typescript
// In agent-trading-actor.ts reconciliation handler:
// Before emitting context snapshot on reconnect/reconciliation:
if (reconciliationResult.status === 'drift_detected' && !hasPositionChange) {
  // Log only — do not emit snapshot that would invalidate context hash
  this.logger.debug('Drift detected but no position change — suppressing context snapshot');
  return;
}
```

#### Implementation: Suppress wake during breaker open state

When the session circuit breaker is OPEN, incoming `agent.wake` signals should be acknowledged but not trigger `requestWakeDrivenTick()`:

```typescript
// In pollWakeSignals():
if (envelope['type'] === 'agent.wake') {
  if (sessionCircuitBreaker.isOpen()) {
    // ACK the message but don't wake
    await wakeRedis.xack(OUTBOUND_STREAM, WAKE_CONSUMER_GROUP, msgId);
    continue;
  }
  // ... existing wake handling
}
```

## File Changes

| File | Change |
|------|--------|
| `apps/worker/src/runtime-resilience.ts` | Add `SessionCircuitBreaker` class |
| `apps/worker/src/runtime-resilience.test.ts` | Unit tests for `SessionCircuitBreaker` |
| `apps/worker/src/agent.ts` | Wire breaker into tick loop, feed events from journal/trading actor |
| `apps/worker/src/agent-trading-actor.ts` | Add `onJournalEvent` callback to deps; suppress context snapshot on drift-only reconciliation |
| `apps/worker/src/agents/agent-reconnect-handler.ts` | Skip context snapshot emission when reconnect detects drift-only state |
| `config/default.yaml` | Add `agentRuntime.sessionCircuitBreaker` config block |
| `apps/worker/src/config.ts` | Parse and validate the new config section |
| `apps/worker/src/config.test.ts` | Test config parsing |

## Implementation Order

1. **Config schema** — Add `sessionCircuitBreaker` to `config/default.yaml` and parse in `config.ts`
2. **SessionCircuitBreaker class** — Implement in `runtime-resilience.ts` with full unit tests
3. **Wire into agent.ts** — Gate LLM dispatch, feed journal events, handle cooldown/termination
4. **Suppress drift context snapshots** — In `agent-trading-actor.ts`, don't emit snapshots on drift-only reconciliation passes
5. **Suppress wakes during breaker open** — In `pollWakeSignals()`, ACK but don't trigger tick
6. **Reconnect handler** — Skip snapshot emission on drift-only reconnect state

## Acceptance Criteria

- [ ] A session with ≥10 `strategy.error` events in 60s enters cooldown and produces 0 LLM calls for 5 minutes
- [ ] A session with ≥5 `reconciliation.drift_detected` in 5 minutes enters cooldown
- [ ] After cooldown, a single probe tick fires; if the underlying issue resolved, normal operation resumes
- [ ] After 3 trips in one session, the agent terminates with reason `session_circuit_breaker_exhausted`
- [ ] Drift-only reconciliation passes do NOT emit context snapshots to the outbound stream
- [ ] A successful fill resets all breaker counters
- [ ] `pnpm lint` and `pnpm test` pass
- [ ] Config defaults are in `config/default.yaml`, not hard-coded

## Token Savings Estimate

Based on the 2026-07-06 data:
- Session 4aa54197 (17k errors, 3.58M input tokens): breaker would trip in ~6 seconds, saving ~3.5M input tokens
- Session 1707c8ce (1.5k drift, 1.08M tokens): breaker would trip in ~5 minutes, saving ~900k input tokens  
- Across all 7 sessions: estimated **40-60% input token reduction** for pathological sessions, with zero impact on healthy sessions (176bea51, 2af32e13 would never trip)
