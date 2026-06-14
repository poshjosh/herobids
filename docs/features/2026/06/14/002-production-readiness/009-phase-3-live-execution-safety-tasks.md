# Phase 3 — Live Execution Safety Task List

**Plan:** [008-phase-3-live-execution-safety.md](../002-production-readiness/008-phase-3-live-execution-safety.md)

**Goal:** Turn the revised Phase 3 live-execution-safety plan into an execution-ready task list with strict sequencing, explicit dependency edges, and a bounded swap-live safety parity pass.

---

## Tasks

### T1: Add durable live order submission state for orderbook flow

**Status:** completed
**Approach:** End-to-end
**Effort:** Large (1-2 sessions)
**Depends on:** None

Introduce the durable pre-submit state needed for live orderbook crash recovery without yet changing recovery behavior.

Scope:
- extend the order persistence model with explicit submit lifecycle state
- persist deterministic `clientOrderId` and orderbook submit intent before venue submit
- record submit-attempt and acknowledgement transitions durably
- keep the shape restart-readable for both bots and agents

**Files:** `packages/db/src/schema/orders.ts`, `packages/db/src/repositories.ts`, `packages/engine/src/live-executor.ts`, `packages/engine/src/live-executor.test.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`

**Acceptance:** Live orderbook execution persists submit intent and state transitions durably before and after venue submit, and the persisted state can be reloaded on restart.

---

### T2: Support minimal live limit-order submission in the executor

**Status:** completed
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T1

Teach the live executor to accept minimal live limit orders instead of rejecting them locally.

Scope:
- allow `limit` orders in `LiveExecutor`
- submit real limit `OrderCommand`s through `OrderbookVenuePort`
- persist limit price and any minimal timing attributes required by runtime handling
- preserve explicit rejection for unsupported non-minimal live order shapes

**Files:** `packages/engine/src/live-executor.ts`, `packages/engine/src/live-executor.test.ts`, `packages/domain/src/ports/venue.ts` if minimal command typing needs extension, `packages/db/src/schema/orders.ts`, `packages/db/src/repositories.ts`

**Acceptance:** A live limit order is acknowledged and persisted as open work instead of being rejected, while unsupported advanced shapes remain explicit rejections.

---

### T3: Persist and rehydrate incomplete live work on actor startup

**Status:** completed
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1, T2

Build the startup plumbing that loads incomplete live orders and pending live work back into actor state.

Scope:
- load incomplete live plans and non-terminal orders for bots and agents
- reconstruct pending live order state in memory on actor startup
- keep swap recovery evidence loadable alongside orderbook live work
- do not retry or repair yet; just rehydrate deterministically

**Files:** `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`, `packages/db/src/repositories.ts`

**Acceptance:** Actor startup restores incomplete live work into memory without mutating venue state or guessing recovery actions.

---

### T4: Add live timeout policy and stale limit-order cancellation

**Status:** completed
**Approach:** Vertical slice
**Effort:** Large (1-2 sessions)
**Depends on:** T2, T3

Implement the timeout path for live orderbook orders, starting with stale resting limit orders.

Scope:
- add typed timeout config for live order handling
- track order age from submit-attempt or acknowledgement time
- cancel stale resting limit orders through the venue port
- persist timeout-driven cancellation results and escalation reasons
- keep market-order completion gaps classified as recovery-required rather than silently waiting forever

**Files:** `packages/engine/src/live-timeout-manager.ts`, `packages/engine/src/live-timeout-manager.test.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`, `packages/domain/src/config/schema.ts`, `config/default.yaml`

**Acceptance:** Stale live limit orders are cancelled or escalated by policy, and market-order completion gaps become explicit recovery cases instead of indefinite waits.

---

### T5: Expand venue lookup surfaces needed for safe recovery

**Status:** completed
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T1, T3

Add or tighten the minimum venue lookup surfaces required for crash recovery to use the best available evidence before any retry.

Scope:
- assess gaps in orderbook venue lookup by `clientOrderId`, venue ref, open orders, and recent fills
- add the minimum new port or adapter surfaces genuinely required for recovery
- keep guarantees honest when a venue cannot prove absence

**Files:** `packages/domain/src/ports/venue.ts`, `packages/venues/src/hyperliquid.ts`, `packages/venues/src/bybit.ts`, related venue tests

**Acceptance:** Recovery code has the strongest available lookup surfaces it needs, and unsupported proof-of-absence cases remain explicit ambiguity rather than hidden assumptions.

---

### T6: Implement live recovery state machine with halt-on-ambiguity behavior

**Status:** completed
**Approach:** End-to-end
**Effort:** Large (1-2 sessions)
**Depends on:** T3, T4, T5

Add the orderbook live recovery logic that decides whether incomplete work should resume, finalize, cancel, or halt for manual intervention.

Scope:
- add recovery state handling for prepared, submit-attempting, acknowledged, and partially filled live work
- query venue state before any retry
- halt and alert on unresolved ambiguity
- emit recovery journal events for every branch

**Files:** `packages/engine/src/live-recovery.ts`, `packages/engine/src/live-recovery.test.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`, `packages/engine/src/journal.ts`

**Acceptance:** On restart, incomplete live orderbook work is recovered through deterministic state-machine logic, and ambiguous states never trigger blind duplicate submission.

---

### T7: Add operator-configurable crash policy for confirmed orderbook exposure

**Status:** completed
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T4, T6

Implement the crash policy branch for orderbook live trading using confirmed exposure only.

Scope:
- add operator config for `auto_go_flat` vs `alert_manual_intervention`
- identify confirmed open exposure and open orders during fatal crash or unrecoverable restart states
- cancel open orders where needed before flattening
- reuse existing `go_flat` execution paths where they satisfy the crash scenario
- halt and alert on ambiguous state even when auto-flatten is configured

**Files:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`, `packages/engine/src/planner.ts`, `packages/engine/src/journal.ts`

**Acceptance:** The configured crash policy is explicit, only confirmed exposure is auto-flattened, and ambiguous crash states stop for operator intervention.

---

### T8: Wire live slippage and execution-quality alerting for orderbook fills

**Status:** completed
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T2, T6

Turn the existing slippage helper and config into real live alerting on confirmed fills.

Scope:
- persist or carry the reference price needed for live fill comparison
- compute slippage on confirmed orderbook fills
- emit `live.slippage_alert` when threshold is breached
- keep alerting tied to real completion evidence rather than executor assumptions

**Files:** `packages/engine/src/journal.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`, nearby live fill handling tests

**Acceptance:** Confirmed live orderbook fills emit slippage alerts with real computed basis points when configured thresholds are exceeded.

---

### T9: Add bounded swap-live safety parity for pending confirmation recovery

**Status:** in-progress
**Approach:** Vertical slice
**Effort:** Medium (1-2 sessions)
**Depends on:** T3, T4, T6

Implement the limited swap-live hardening explicitly allowed by the revised plan.

Scope:
- persist restart-readable swap recovery evidence at the earliest safe point supported by the current executor contract
- add timeout handling for pending confirmation
- re-check chain or venue confirmation state on restart
- halt and alert on ambiguous swap state
- do not rewrite swap execution into a full orderbook-style lifecycle engine

**Files:** `packages/engine/src/swap-live-executor.ts`, `packages/domain/src/ports/swap-venue.ts`, `packages/venues/src/swap-confirmation-poller.ts`, `packages/venues/src/jupiter-confirmation.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`

**Acceptance:** A live swap pending confirmation across restart is recovered through confirmation and transaction evidence, and ambiguous swap state never causes blind resubmission.

---

### T10: Extend crash policy and execution-quality alerting to confirmed swap exposure

**Status:** in-progress
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T7, T8, T9

Finish the bounded swap parity pass by applying the operator-configured crash policy and execution-quality alerting to confirmed swap exposure.

Scope:
- apply crash-policy branching to confirmed post-swap exposure only
- keep ambiguous swap state in halt-and-alert flow
- compute swap execution-quality deviation using quote or decision-time expectation
- emit alerts without claiming stronger swap lifecycle guarantees than the current model supports

**Files:** `packages/engine/src/journal.ts`, `packages/engine/src/swap-live-executor.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/agent-trading-actor.ts`, `packages/venues/src/swap-confirmation-poller.ts`

**Acceptance:** Confirmed live swap exposure follows the configured crash policy, and materially adverse swap execution emits execution-quality alerts without reopening Phase 2 execution design.

---

### T11: Add focused regression coverage and repo validation

**Status:** completed
**Approach:** End-to-end
**Effort:** Large (1-2 sessions)
**Depends on:** T6, T7, T8, T9, T10

Add the regression tests and final validation needed to close the phase safely.

Scope:
- crash-window tests for pre-ack and post-ack orderbook paths
- stale limit-order timeout and cancellation tests
- halt-on-ambiguity recovery tests
- swap pending-confirmation restart tests
- slippage-alert tests for both orderbook fills and swaps
- final `pnpm lint` and focused test runs

**Files:** `packages/engine/src/live-executor.test.ts`, `packages/engine/src/live-recovery.test.ts`, `packages/engine/src/live-timeout-manager.test.ts`, `apps/worker/src/trading-actor.test.ts`, `apps/worker/src/agent-trading-actor.test.ts`, relevant swap confirmation tests

**Acceptance:** The critical live-safety regressions are covered by focused tests, and the repo passes the required validation commands for the touched surfaces.

---

## Parallelization Notes

- **T1** must land first because every recovery and timeout behavior depends on durable live state.
- **T2** follows immediately once the durable orderbook state exists.
- **T3** can begin as soon as the persistence model is stable enough to reload incomplete work.
- **T4** and **T5** can overlap after T3 because timeout policy and venue lookup expansion are adjacent but separable.
- **T6** is the main recovery slice and depends on both timeout classification and lookup surfaces.
- **T7** and **T8** can proceed in parallel once orderbook recovery is real.
- **T9** begins only after the orderbook recovery model is settled, so swap parity can reuse it instead of inventing a second mechanism.
- **T10** is the close-out pass for bounded swap parity.
- **T11** is the final consolidation step.

```text
T1 (durable orderbook submission state)
  -> T2 (minimal live limit orders)
  -> T3 (rehydrate incomplete live work)

T3 -> T4 (timeouts + stale cancellation)
T3 -> T5 (venue lookup expansion)

T4 + T5 -> T6 (live recovery state machine)

T6 -> T7 (orderbook crash policy)
T6 -> T8 (orderbook slippage alerting)

T6 -> T9 (bounded swap safety parity)
T7 + T8 + T9 -> T10 (swap crash-policy + alerting close-out)

T6 + T7 + T8 + T9 + T10 -> T11 (regression coverage + repo validation)
```