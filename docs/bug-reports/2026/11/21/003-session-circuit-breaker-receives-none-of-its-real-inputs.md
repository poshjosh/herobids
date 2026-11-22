# Bug Report: the session circuit breaker is fed from the wrong message level and from message types nothing emits, so drift, strategy-error and stream-disconnect signals never reach it
- **Status:** OPEN. Not fixed. No work started; waiting for the owner's greenlight.
- **Severity:** Medium. Nothing visibly fails. The breaker is on by default (`config/default.yaml`, `agentRuntime.sessionCircuitBreaker.enabled: true`), but for real traffic it never trips on drift, strategy errors or stream disconnects, so a safety control is silently inactive. Fixing it changes live behavior (see "Risk of fixing").
- **Date:** 2026-11-21
- **Environment:** code analysis only (herobids and traderton source). Not reproduced live.
- **Found while fixing:** `docs/bug-reports/2026/11/21/002-agent-portfolio-context-mislabels-initial-capital-as-available.md`. The portfolio refresher (`apps/worker/src/portfolio-refresh.ts`) had the same wrong-level read and was fixed there. This loop was left alone because it is outside that bug.
- **Related:** `docs/bug-reports/2026/07/07/003-agent-decision-retry-loop-no-circuit-breaker.md` (other breaker work; not the same component).
## Summary
The session circuit breaker (`SessionCircuitBreaker`, `apps/worker/src/runtime-resilience.ts`) should suppress LLM dispatch after repeated drift, strategy errors or stream disconnects. Its feed loop in `apps/worker/src/agent.ts` (about lines 2891-2915) reads the signal fields from the wrong level of each message. Two of its three branches also wait for message types that nothing in the system emits. Even with the read level fixed, the journal event names it records do not match the names the breaker recognizes.
## Root Cause
Line numbers are approximate.
1. **Wrong message level.** Every outbound message is an envelope `{ type, payload: {...} }` (`InstanceEventPublisher.publishStrict`, `apps/worker/src/agents/instance-event-publisher.ts` ~212-232). `applyRuntimeMessage` already reads `message['payload']`. The breaker loop reads `message['eventType']`, `message['resultType']` and `message['journalType']` at the top level, so each is always `undefined`.
2. **Per branch** (`agent.ts` ~2891-2915):
   - `instance.decision.accepted`: works. It checks only `type` and records `decision.accepted`.
   - `instance.reconciliation.notice`: dead. Nothing outside tests calls `emitReconciliationNotice`, so the message is never produced. The `eventType` read is also at the wrong level (the field is `payload.eventType`).
   - `instance.execution.result`: dead. Nothing outside tests calls `emitExecutionResult`. `resultType` does not exist in `ExecutionResultPayloadSchema` (`packages/domain/src/agent-protocol.ts` ~341; the fields are `fills`, `positionAfter`, `executionFailed` and others), so this is not a path error that can be fixed by moving the read.
   - `instance.journal.event`: the only live source. Traderton forwards journal events as `journal_event` notifications; `actor-event-relay.ts` (~198-212) republishes them with `emitJournalEventStrict`, which puts `journalType` in `payload.journalType`. The loop reads it at the top level, so nothing is recorded.
3. **Name mismatch after the read is fixed.** The journal branch maps `a.b` to `a_b` (`journalType.replace(/\./g, '_')`). The breaker (`runtime-resilience.ts` ~180-190) expects:
   - error events: `strategy_error`, `strategy_fatal`, `drift_detected`, `stream_disconnect`
   - recovery events: `fill.recorded` (full reset), `decision.accepted`, `reconciliation.match`
   What the live forwarded journal events would become:
   - `strategy.error`, `strategy.fatal`, `stream.disconnect` become `strategy_error`, `strategy_fatal`, `stream_disconnect`. These match.
   - `reconciliation.drift_detected` becomes `reconciliation_drift_detected`. The breaker expects `drift_detected`. No match.
   - `reconciliation.match` becomes `reconciliation_match`. The breaker expects `reconciliation.match`. No match.
4. **No live source for `fill.recorded`.** The fill-based full reset can only come from the dead execution-result branch. Traderton does not forward `fill.recorded` journal events to herobids (an agent actor forwards only `reconciliation.*`; see below).
5. **What traderton actually forwards** (read, not run):
   - Agent actor: only journal types starting with `reconciliation.` (`traderton/packages/worker/src/agent-trading-actor.ts` ~3097-3115).
   - Bot actor events for an agent-created bot, routed to that agent: `strategy.error`, `strategy.fatal`, `stream.disconnect` (`traderton/packages/worker/src/trading-actor.ts` ~1405, 1758, 1779; routing in `composition/create-trading-runtime.ts` ~898).
## Impact
- The breaker never trips on drift, strategy errors or stream disconnects from real traffic. The control fails open.
- Counters never reset on a fill, and drift counters are never reduced by a reconciliation match, so the recovery paths do not work either.
- Only `decision.accepted` reaches the breaker, and that only removes drift events that were never recorded.
- The existing tests in `runtime-resilience.test.ts` exercise the class directly with hand-fed event names. No test drives the loop in `agent.ts` with a real envelope, which is why this was not caught.
## Risk of fixing
Once the signals reach the breaker, agents that were never suppressed before can start tripping it (default thresholds: 10 strategy errors in 60 s, 5 drift or 5 stream disconnects in 300 s, cooldown 300 s, 3 trips to terminate). That is the intended behavior, but it is a live behavior change. Roll out with a heads-up and a way to see trips in logs, and decide the thresholds on purpose rather than by accident.
## Proposed fix (not approved, not started)
- Read signals from `payload` (with a fallback to the top level only if a producer is found that sends flat messages).
- Decide the event vocabulary once. Either map forwarded `reconciliation.drift_detected` to `drift_detected` and `reconciliation.match` to `reconciliation.match`, or change the breaker's constants. Prefer one mapping function with a test.
- Decide where recovery comes from. `fill.recorded` has no live source today. Options: add a signal that exists (for example `order.filled` or `fill.recorded` forwarded from traderton, or an accepted-execution signal herobids already receives), or drop the fill reset if it is not wanted.
- Remove or repurpose the two dead branches (`instance.reconciliation.notice`, `instance.execution.result`) once their replacements are decided.
- Tests: drive the loop with real envelopes, not hand-built event names. Include one test per signal and one that an agent trips after the configured number of drift events.
- Effort: medium. The code change is small. The vocabulary decision, the missing fill signal and the rollout make it larger than a path fix.
## Acceptance criteria
- A forwarded `reconciliation.drift_detected` journal event reaches the breaker as a drift event; enough of them within the window open the breaker.
- A forwarded `strategy.error`, `strategy.fatal` or `stream.disconnect` journal event reaches the breaker as the matching error event.
- A forwarded `reconciliation.match` reduces the drift count by one.
- The recovery on a fill works from a signal that actually exists, or the reset is removed on purpose and documented.
- No branch in the loop waits for a message type that nothing emits.
- Behavior tests drive the loop with real `{ type, payload }` envelopes. Run focused tests, then `pnpm lint`, `pnpm build`, `pnpm test`.
## Not verified
- Not reproduced live. No agent was observed failing to trip the breaker.
- Which journal event types traderton forwards for agents beyond what was read in the files above (for example `scanner.*`, noted in a traderton comment).
- Whether any other producer outside these two repos emits `instance.reconciliation.notice` or `instance.execution.result`.
- The portfolio refresher fix in report 002 covers execution results for its own purposes (fills and flat positions). It does not feed the breaker.
- Exact line numbers are approximate.
