# Bug Report: User messages to a running agent are not processed until the next scheduled tick (and can be silently skipped)

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-01
- **Discovered By:** Manual report — messages sent to running agents (`nonso-pa` `ade92dbf-b534-4b08-9ade-a67306891cc3`, `tintel` `d744837c-793d-49a2-9947-e5dc376d356a`) returned `delivered: true` but produced no agent response for many minutes.
- **Summary:** An inbound user message is appended to the `agent:outbound:{agentId}` Redis stream but does not trigger an early tick and does not exempt the tick from the `context_hash` gate. The agent therefore only reacts to the message on its next *scheduled* tick — up to a full tick interval away (30 min on the `standard` cost preset, 15 min on the trading-skill cadence) — and even then the tick can be skipped as `context_unchanged`, so the user may receive no reply at all until an unrelated context change forces a tick.

---

## Root Cause

The agent runtime tick loop only reacts promptly to messages of type `agent.wake`. Two independent mechanisms both key on that type and both ignore user messages:

1. **No early tick.** `pollWakeSignals` in `apps/worker/src/agent.ts` calls `requestWakeDrivenTick(...)` only when `envelope.type === 'agent.wake'`. A `user.message` (or `agent.user.message`) on the stream did not schedule an early tick, so the message waited for the next timer tick. The tick interval comes from the cost preset (`packages/domain/src/cost-profile.ts` → `PRESET_TICK_INTERVALS`: `minimal` 90 min, `standard` 30 min, `premium` 10 min), so the worst-case delay was a full interval.

2. **Silently gated out.** `buildTickGateState` in `apps/worker/src/tick-gate-state.ts` set `hasWakeSignal` only for `agent.wake` (or a buffered wake). `hasWakeSignal` is the flag that bypasses the `context_hash` gate in `shouldSkipTick` (see bug `2026/06/12/006`). A user message does not change the decision-context hash (price/PnL/position/regime/watch/wake digests are all unchanged), so when a scheduled tick finally ran it was skipped with `reason: context_unchanged, gate: context_hash` and the LLM was never dispatched — no reply.

Confirmed on the live stack: `tintel`'s runtime consumer group showed the message sitting undrained (`lag: 9`) and its most recent tick logged `agent.scout.held`; `nonso-pa` was idling between ticks on a 30-minute cadence (verified via the live V8 inspector: `effectiveTickIntervalMs = 1_800_000`, `tickInFlight = false`, next tick timer scheduled ~20 min out).

This is **not a regression** in the strict sense — git history shows the intake endpoint never emitted a wake and `requestWakeDrivenTick` was only ever called for `agent.wake`. The behaviour became noticeable when agents began running on longer cost-preset cadences; on short intervals (and on the first ticks, which always escalate) a reply usually arrived quickly enough to mask the gap.

---

## Fix

Runtime-only change — a user message is now treated as a first-class wake trigger.

### `apps/worker/src/tick-gate-state.ts`
`hasWakeSignal` is now `true` when `incomingMessages` contains `user.message` or `agent.user.message` (in addition to `agent.wake` / `hasBufferedWake`). This bypasses the `context_hash` gate so a tick carrying a user message always reaches LLM dispatch.

### `apps/worker/src/agent.ts` (`pollWakeSignals`)
Added an `else if (isUserMessageType(...))` branch: when the wake-poll consumer group sees a `user.message` / `agent.user.message`, it calls `requestWakeDrivenTick('Received user message between ticks')` to schedule an early tick. It deliberately does **not** buffer the message as a market wake (there is no wake context to render); the independent `agent-runtime` consumer group still delivers the message to the tick, where the gate-state change ensures it is not skipped.

### Shared predicates (testability + DRY)
Extracted `isEarlyTickTriggerType`, `isUserMessageType`, and the `USER_MESSAGE_TYPE` / `AGENT_USER_MESSAGE_TYPE` / `AGENT_WAKE_TYPE` constants into `tick-gate-state.ts`, used by both the gate-state computation and the `pollWakeSignals` branch. This removes duplicated message-type string literals across the two call sites and makes the early-tick / user-message classification unit-testable in isolation (the `pollWakeSignals` loop itself remains module-scoped and untested; the extracted predicate now carries the behavioural contract).

### Rejected alternative
Emitting a synthetic `agent.wake` from the API intake (`POST /agents/:id/message`) was considered and rejected: `AgentWakePayloadSchema` (`packages/domain/src/agent-protocol.ts`) is a discriminated union over `source` with no `user_message` variant, and the message broker validates payloads against it, so a synthetic wake would be rejected without a domain-schema change. The runtime already observes `user.message` on the stream, so the fix stays entirely in the worker with no schema or API change.

---

## Files Changed

- `apps/worker/src/tick-gate-state.ts` — set `hasWakeSignal` for user messages; added shared `isEarlyTickTriggerType` / `isUserMessageType` predicates and message-type constants.
- `apps/worker/src/agent.ts` — schedule an early tick on a user message in `pollWakeSignals` (via `isUserMessageType`).
- `apps/worker/src/tick-gate-state.test.ts` — updated one stale test that asserted `hasWakeSignal: false` for `agent.user.message`; added two cases asserting `hasWakeSignal: true` for `user.message` and `agent.user.message`.
- `apps/worker/src/tick-gates.test.ts` — added an end-to-end test: `buildTickGateState` with a `user.message` → `shouldSkipTick` returns `skip: false` even when the decision context is unchanged.
- `apps/worker/src/tick-message-types.test.ts` (new) — unit tests for `isEarlyTickTriggerType` / `isUserMessageType`, covering wake, both user-message channels, routine messages, and non-string inputs.
- `apps/worker/src/tick-thinking.test.ts` — added `user_message` branch coverage in `classifyTickThinking`, including precedence (regime flip and drawdown outrank a user message; user message outranks the generic `new_runtime_event`).

---

## Verification

- `pnpm lint` (`tsc --noEmit`, repo root) passes clean.
- `npx vitest run` on `tick-message-types.test.ts` + `tick-thinking.test.ts` + `tick-gate-state.test.ts` + `tick-gates.test.ts` → 170 passed (including all new cases).
- `runtime-composition.test.ts` → 126 passed (confirms the new `tick-gate-state.ts` exports introduce no ripple).
- Full `apps/worker` suite: 3396 passed, 21 skipped, 2 failed — the 2 failures (`tools/shell.test.ts`, `tools/code.test.ts`, "does not misclassify ordinary permission stderr as sandbox infrastructure failure") are **pre-existing and unrelated**; confirmed by stashing the four changed files and re-running, where they fail identically. They are OS-specific permission-stderr assertions with no connection to tick gating or wake handling.

---

## Notes / Follow-ups

- The `session` gate (trading hours) and `regime` gate are still **not** bypassed by a user message — only the `context_hash` gate is. A user message to an agent that is outside its configured trading hours (session gate enabled) may still be deferred. If prompt replies are required regardless of trading hours, that is a separate decision.
- Wake throttling (`wakeMinIntervalMs`) still applies to the early tick, so a burst of user messages will not force back-to-back LLM ticks; the 10/min API rate limit also caps abuse.
- `pollWakeSignals` / `requestWakeDrivenTick` live in the monolithic `agent.ts` module scope and are not independently exported, so the loop wiring itself is not unit-tested. The classification it depends on (which message types trigger an early tick / count as a user message) is now extracted into `isEarlyTickTriggerType` / `isUserMessageType` and unit-tested. A full loop-level test would need further extraction of `pollWakeSignals`; the behavioural guarantees (a user message is not gated out, and its type is classified as an early-tick trigger) are covered by the gate and predicate tests.
- Product follow-up: consider making user-message responsiveness explicit in the UX (e.g. surface expected processing latency) and revisiting whether conversational agents should run on a shorter cadence than trading polling presets.
