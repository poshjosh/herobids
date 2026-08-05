# Fix Issue 1: Wake message consumed by the wrong consumer group → scanner-gated agents never reach the LLM

## Objective

Fix the race condition where the `agent.wake` message is consumed by the `agent-market-wake` consumer group (triggering an early tick) but is **not** delivered to the `agent-runtime` consumer group, so `currentMarketWake` is `null` when the tick runs. This causes scanner-gated agents to log `"timer tick without wake signal"`, skip LLM dispatch, and (via downstream `agent-runtime` lag) abort the hybrid evaluator with `stale_scan` — resulting in zero trades.

**Scope:** This plan fixes **only Issue 1** (the wake/consumer-group race). Issue 2 (t1inch base discovery suppressed by antistaleness) is out of scope and tracked separately.

## Background / Root Cause (confirmed)

- Both `agent.wake` and `agent.technical.scan_completed` messages are published to the **same** `agent:outbound:<id>` Redis stream (`apps/worker/src/agents/instance-event-publisher.ts:188-215`).
- Two consumer groups read that stream:
  - `agent-market-wake` — polled continuously by `pollWakeSignals()` (`apps/worker/src/agent.ts:1390`), consumes `agent.wake` → calls `requestWakeDrivenTick()` → schedules an early tick.
  - `agent-runtime` — drained once per tick by `readOutboundMessages()` (`apps/worker/src/agent.ts:1358`), consumes ALL messages including `agent.wake` and `agent.technical.scan_completed`.
- **Redis Streams delivers each message to only ONE consumer group.** When the wake group wins the race and consumes an `agent.wake` message, the runtime group never sees it.
- When the early tick fires, `runTick()` calls `readOutboundMessages()` (runtime group), which does NOT see the wake → `currentMarketWake` stays `null` → `"timer tick without wake signal"` → LLM dispatch skipped.
- Downstream, the runtime group only reads once per tick (15 min) with `COUNT 10` (`apps/worker/src/agents/outbound-message-reader.ts:25`), so it lags behind the 60s scanner cadence (lag 149 for thyper). The `agent.technical.scan_completed` messages (which update `lastTechnicalScan`) are stuck in the lagging group → `lastTechnicalScan` stale → `isTechnicalScanFresh()` (`apps/worker/src/hybrid-agent-evaluator.ts:13`) rejects it → `stale_scan` abort.

**Evidence:** On 08/05 thyper, only 19 of 36 wakes (53%) reached the runtime group (`"Processing market wake"`), vs 23 of 25 (92%) on the working 07/25 scalper run.

## Fix Design

The core problem is that the wake context (`currentMarketWake`) is only populated when the `agent-runtime` group consumes the `agent.wake` message, but that message is consumed by the `agent-market-wake` group. The fix must ensure the wake context is available to the tick regardless of which group consumed the message.

**Chosen approach: buffer the wake context in the wake group and drain it into runtime state at tick start.**

When `pollWakeSignals()` consumes an `agent.wake` message, it already pushes to `pendingWakeSignalBuffer` (when prompt enrichment is enabled). We extend this so the **full wake envelope** (source, reason, context) is buffered, and `runTick()` drains it into `runtimeState.metrics.currentMarketWake` before the hybrid-routing decision. This decouples wake-context delivery from the `agent-runtime` consumer group.

### Why this approach

- **Minimal and localized.** It reuses the existing `pendingWakeSignalBuffer` mechanism and the existing `currentMarketWake` field. No new Redis streams or consumer groups.
- **Fixes the root cause.** The wake context is no longer dependent on which group consumed the message.
- **Preserves existing behavior.** Timer ticks without wakes still skip LLM dispatch; wake-driven ticks now correctly see `currentMarketWake`.
- **Also reduces the downstream lag symptom.** Because the wake no longer needs to be re-read by the runtime group, the runtime group's lag no longer blocks wake-driven ticks (though the `agent-runtime` lag for `scan_completed` delivery is a separate concern addressed by the mitigation in §Mitigation).

### Alternative approaches considered (and rejected)

1. **Publish `agent.wake` to a separate stream per group.** More invasive; requires new streams, new consumer groups, and changes to the publisher. Higher risk.
2. **Have the wake group forward the wake to the runtime group.** Adds a second write and a potential feedback loop; more complex.
3. **Increase `COUNT` / read frequency of the runtime group.** Treats the downstream symptom (lag) but does NOT fix the root cause (wake context lost to the runtime group). The wake would still be consumed by the wake group first.

## Implementation

### Step 1 — Buffer full wake envelopes in the wake group (`apps/worker/src/agent.ts`)

In `pollWakeSignals()`, when an `agent.wake` message is consumed and not suppressed by the circuit breaker, buffer the **full wake envelope** (not just source/reason) so the tick can reconstruct `currentMarketWake`.

- Extend the `pendingWakeSignalBuffer` element type to carry the full wake payload: `{ source, reason, requestedAt, context, wakeId }`.
- Currently the buffer is only populated when `promptStyle === 'enriched' && promptEnrichment.queuedSignals.enabled`. Change this so the wake envelope is **always** buffered (the enrichment gating applies only to how it's rendered in the prompt, not to whether `currentMarketWake` is set).

### Step 2 — Drain the buffered wake into `currentMarketWake` at tick start (`apps/worker/src/agent.ts`)

In `runTick()`, before the hybrid-routing decision (around line 2431 where `isScannerWake` is computed), drain the most recent buffered wake envelope into `runtimeState.metrics.currentMarketWake` if it is not already set.

- If `currentMarketWake` is already set (e.g. the runtime group did consume the wake), leave it as-is.
- Otherwise, take the newest buffered wake envelope and set `currentMarketWake = { wakeId, source, reason, requestedAt, context }`.
- Clear the drained buffer entry to avoid re-triggering on subsequent ticks.

### Step 3 — Preserve the existing enrichment behavior

Keep the `pendingWakeSignalBuffer` used for prompt enrichment (queued signals) intact. The new full-envelope buffer is separate from (or a superset of) the enrichment buffer. Ensure the enrichment path still works as before.

### Step 4 — Update the wake scheduler if needed (`apps/worker/src/agent-wake-scheduler.ts`)

No change expected to `resolveNextTickDelay()` / `getWakeRescheduleDelay()` — the tick acceleration already works (wakes DO trigger early ticks). The bug is purely that `currentMarketWake` is not set. Verify no change is needed; if the scheduler is touched, add/adjust unit tests.

## Tests

### Unit tests

1. **`apps/worker/src/agent-wake-scheduler.test.ts`** — existing tests for `resolveNextTickDelay` / `getWakeRescheduleDelay` must continue to pass (no behavior change expected).

2. **New: wake-context buffering test** — verify that when `pollWakeSignals()` consumes an `agent.wake` message, the full wake envelope is buffered (source, reason, requestedAt, context, wakeId), regardless of `promptStyle`.

3. **New: wake-context drain test** — verify that `runTick()` drains the buffered wake envelope into `currentMarketWake` when the runtime group did not consume the wake, and that the hybrid-routing decision (`isScannerWake`) then evaluates correctly.

4. **New: race-condition regression test** — simulate the scenario where the wake group consumes the `agent.wake` message (so the runtime group does not see it), then assert that the subsequent tick still sets `currentMarketWake` and routes to the single-shot hybrid evaluator (not `"timer tick without wake signal"`).

### Integration / functional tests

5. **`apps/worker/src/hybrid-agent-evaluator.test.ts`** — add a test that a scanner wake with a fresh technical scan routes to the hybrid evaluator and submits a decision, even when the wake message was consumed by the wake group (not the runtime group).

6. **`apps/worker/src/runtime-composition.test.ts`** — add a test that `currentMarketWake` is correctly populated from the buffered wake envelope at tick start.

### Shell / end-to-end tests

7. **`scripts/shell/tests/agent-trade-test.sh`** — run the agent trade test end-to-end and confirm a scanner-gated agent reaches the LLM and submits decisions (no `"timer tick without wake signal"` loop, no `stale_scan` abort).

8. **`scripts/shell/tests/agent-watch-invariants.sh`** — run to confirm watch/wake invariants still hold.

## Verification

### Automated

- `pnpm lint` — must pass (no type errors).
- `pnpm test` — all unit tests pass, including the new wake-context tests.
- `scripts/shell/tests/run-all-tests.sh` — full suite (unit + integration + functional) passes.
- `scripts/shell/tests/run-extra-tests.sh` — extra tiers pass (tiers 1–4 at minimum).

### Manual / staging

1. Deploy the fix to staging.
2. Create/start a scanner-gated agent (e.g. `thyper` on Hyperliquid) with a 15-min tick and 60s scan cadence — the exact condition that exposed the bug.
3. Confirm the agent log shows `"Processing market wake signal"` → `"routing to single-shot evaluator (scanner wake)"` → `"Hybrid evaluator complete"` with decisions submitted (not `"timer tick without wake signal"` / `stale_scan`).
4. Confirm the `agent-runtime` consumer-group lag does not grow unboundedly (or that wake-driven ticks no longer depend on it).
5. Confirm the agent executes trades (in shadow mode) as expected.

## Mitigation (why this should have been caught)

This bug should have been caught by tests before reaching staging. The following mitigations are added to prevent recurrence:

1. **Regression test for the two-group race.** Add a test that explicitly simulates the wake group consuming an `agent.wake` message and asserts the tick still sets `currentMarketWake` and routes to the hybrid evaluator. This is the exact failure mode observed on 08/05.

2. **Assertion on wake-consumption ratio.** Add a test/check that a scanner-gated agent's `"Processing market wake"` count tracks its `"Received market wake"` count (i.e. wakes are not silently lost). A large divergence (e.g. >10% of wakes not processed) should fail the test.

3. **Shell smoke test coverage.** Extend `scripts/shell/tests/agent-trade-test.sh` (or add a dedicated wake-invariant script) to assert that a scanner-gated agent reaches the LLM within a bounded time after a scanner wake, and that no `stale_scan` abort occurs. This runs via `run-all-tests.sh` / `run-extra-tests.sh`.

4. **Document the two-group semantics.** Add a code comment in `pollWakeSignals()` and `readOutboundMessages()` documenting that Redis Streams delivers each message to only one consumer group, and that wake context must be buffered (not re-read) to be visible to the tick.

## Out of Scope

- **Issue 2** (t1inch base discovery suppressed by antistaleness) — tracked separately.
- The `agent-runtime` consumer-group lag for `scan_completed` delivery (a contributing factor to `stale_scan`) — the primary fix here decouples wake-driven ticks from that lag, but a fuller fix for scan-state delivery is a follow-up.

## References

- Bug report: `docs/bug-reports/2026/08/05/001-scanner-gated-agents-stale-scan-blocks-trading.md`
- Eval report: `.ignore/eval/2026/08/05/REPORT.md` (§3.9)
- Key source: `apps/worker/src/agent.ts` (`pollWakeSignals` ~1390, `readOutboundMessages` ~1358, `runTick` ~2135, hybrid routing ~2431), `apps/worker/src/agents/outbound-message-reader.ts`, `apps/worker/src/agents/instance-event-publisher.ts`, `apps/worker/src/hybrid-agent-evaluator.ts`

## Outstanding Issues

The following non-blocking issues were identified during code review and are tracked for follow-up. None block the fix; all are LOW severity.

### [Fix] — `source` cast not validated in `bufferWakeEnvelope`
`bufferWakeEnvelope` defaults `source` to `'unknown'` for missing fields but does not validate an arbitrary `source` string against the known union (`watch_threshold | discovery_delta | regime_change | scanner | reminder`). A malformed envelope with an unknown `source` would be cast through and produce a `currentMarketWake` with an invalid source. This degrades gracefully (scanner-gated suppression gate handles non-scanner sources), but validating `source` in `bufferWakeEnvelope` (returning `null` for unknown sources) would match the runtime-group path's `AgentWakePayloadSchema` validation.

### [Fix] — Buffered reminder wakes set `currentMarketWake` instead of `currentReminder`
The buffered drain path sets `currentMarketWake` for ALL wake sources, including `reminder` wakes. The runtime-group path (`applyRuntimeMessage`) distinguishes reminders (sets `currentReminder`) from market wakes (sets `currentMarketWake`). The buffered path does not replicate this distinction. In practice `isScannerWake` is false for reminders and the scanner-gated suppression gate handles them, so this is benign, but it is a minor divergence worth aligning.

### [Fix] — Classic-mode buffer accumulation across ticks
In classic (non-enriched) mode, the prompt-enrichment splice does not run, so the buffer is only drained one entry per tick. If multiple wakes arrive between ticks, extra buffered wakes persist (bounded, processed one per tick). The `wakeSignalDigest` keeps the context-hash gate from skipping while entries remain, so wakes are eventually processed. Worth a comment but not a defect.

### [Test] — Full-chain integration test not added
The plan's test #5 (`hybrid-agent-evaluator.test.ts` — scanner wake routes to hybrid evaluator when consumed by the wake group) was not added. The race-condition regression is covered at the helper level (`runtime-composition.test.ts`) and the `hasBufferedWake → hasWakeSignal` chain is covered in `tick-gate-state.test.ts`, but an end-to-end test exercising `runTick()` → `buildTickGateState()` → `canRouteToHybridEvaluator()` as a connected path would strengthen coverage.

### [Verification] — Shell/E2E tests not run
`scripts/shell/tests/agent-trade-test.sh` and `scripts/shell/tests/agent-watch-invariants.sh` were not run (they require infra). They should be run in a staging environment to confirm end-to-end behavior, per the plan's Verification section.
