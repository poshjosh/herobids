# Advanced Live Limit Order Management

## Status

`draft`

## Purpose

Capture the broader live limit-order work as a separate pending feature so Phase 3 production-readiness can stay focused on the minimal safety-critical path.

This plan exists for the work beyond "make live limit orders safe":

- amend/replace workflows
- richer venue-specific order semantics
- stronger order-state recovery across restart windows
- a clearer cross-venue capability model for managed live orders

## Why This Is Separate From Phase 3

The production-readiness backlog already needs a minimal live limit-order path for Phase 3:

- submit a live limit order
- monitor it
- time it out or cancel it safely
- persist order and fill state correctly
- recover without blind duplicate submission

That is the shortest path to safe live trading.

This pending feature is intentionally broader. It addresses the next layer of exchange-grade order management once the minimal safety path is landed.

## Current Baseline

The current codebase has these relevant constraints:

1. `packages/engine/src/live-executor.ts` rejects all non-market live orders.
2. Live order completion depends on asynchronous venue updates rather than executor-generated fills.
3. There is no first-class timeout/cancel lifecycle for live orders yet.
4. Client order IDs exist, but crash-window recovery and idempotent resubmission policy are still incomplete.
5. There is no venue-normalized capability layer for advanced limit-order semantics such as amend-in-place, post-only, or time-in-force variants.

## Goal

Provide a robust live limit-order management layer that lets OpenAIdom place, monitor, amend, replace, cancel, and recover live limit orders across supported orderbook venues without hiding venue differences or weakening the core safety model.

## Scope

In scope:

1. live limit-order submission support in the executor path
2. persistent order-lifecycle state for open, partial, filled, cancelled, expired, and replaced orders
3. timeout and cancel workflows for stale limit orders
4. amend-in-place where the venue supports it
5. cancel-and-replace where amend-in-place is unavailable
6. venue capability surfacing for:
   - time in force
   - post only
   - reduce only
   - client order ID behavior
   - amend support
7. restart recovery for in-flight and partially filled live limit orders
8. slippage and execution-quality telemetry for completed limit orders
9. focused tests for lifecycle, partial fills, recovery, and capability fallbacks

## Non-Goals

1. Do not broaden this into swap-venue execution management.
2. Do not build smart routing or price-improvement logic across venues.
3. Do not add UI order-ticket features in this plan.
4. Do not attempt a universal abstraction that erases all venue-specific behavior.
5. Do not reopen paper or shadow executor behavior except where tests or shared types must stay consistent.
6. Do not treat this plan as a prerequisite for the minimal Phase 3 path.

## Product Decisions Encoded By This Plan

1. Venue differences remain explicit. The system should expose capability support rather than pretending all exchanges behave identically.
2. Safety beats convenience. If a venue does not support amend-in-place safely, the fallback is cancel-and-replace, not silent emulation.
3. Recovery logic must prefer durable local state plus venue lookup over blind retry.
4. Partial fills are first-class lifecycle states, not edge cases.

## Proposed End State

After this feature lands:

1. OpenAIdom can submit live limit orders on supported orderbook venues.
2. Each venue adapter exposes a clear capability descriptor for advanced order semantics.
3. The engine can decide whether to amend, cancel-and-replace, or reject a requested update based on venue support.
4. Open and partially filled limit orders survive worker restart and reconcile back into a correct local lifecycle state.
5. Timeout policies and terminal-state transitions are explicit and durable.
6. Journal and alerting surfaces can distinguish:
   - newly placed limit orders
   - partial fills
   - timed out orders
   - cancelled orders
   - replaced orders
   - recovery events

## Architecture Direction

The broader path should build on top of the minimal Phase 3 safety work rather than duplicating it.

The likely layering is:

1. minimal Phase 3 introduces safe live limit submission, timeout, cancellation, and durable recovery primitives
2. this feature extends those primitives with richer venue capabilities and order-management strategies

That keeps the critical path short while preserving a clean expansion path.

## Implementation Plan

### Slice 1 — Introduce a Venue Capability Model For Managed Limit Orders

#### Goal

Make advanced live order behavior capability-driven instead of hard-coded per call site.

#### Files

- `packages/domain/src/ports/orderbook-venue.ts`
- `packages/venues/src/*` relevant orderbook adapters
- `packages/engine/src/live-executor.ts`
- `packages/engine/src/*` any new live order management helpers

#### Tasks

1. Add a typed venue capability descriptor for live order management.
2. Include support flags or enums for:
   - limit order submission
   - amend in place
   - cancel and replace
   - post only
   - reduce only
   - supported time-in-force variants
3. Make adapters declare capabilities explicitly.
4. Fail closed when a requested behavior is unsupported.

#### Expected Result

The engine can reason about what a venue can safely do without encoding exchange-specific assumptions everywhere.

---

### Slice 2 — Add First-Class Live Limit Order Submission

#### Goal

Teach the live executor path to place limit orders as durable lifecycle records rather than local rejections.

#### Files

- `packages/engine/src/live-executor.ts`
- `packages/engine/src/live-executor.test.ts`
- `packages/engine/src/executor.ts`
- `packages/db/src/schema/orders.ts` if additional order metadata is needed
- `packages/db/src/repositories/*` as needed for persistence changes

#### Tasks

1. Accept limit orders in the live executor.
2. Persist venue-normalized limit-order attributes such as limit price and time-in-force.
3. Return acknowledged open orders without fabricating fills.
4. Preserve explicit local rejection when the requested order shape is unsupported by venue capabilities.

#### Expected Result

Live limit orders enter the same durable order lifecycle as market orders, but remain open until venue events or recovery logic move them forward.

---

### Slice 3 — Build an Order Lifecycle Manager

#### Goal

Centralize open-order monitoring and terminal-state transitions for live limit orders.

#### Files

- `packages/engine/src/` new order lifecycle manager module
- `apps/worker/src/trading-actor.ts`
- `apps/worker/src/agent-trading-actor.ts`
- `packages/engine/src/journal.ts`

#### Tasks

1. Introduce a dedicated lifecycle manager for live open orders.
2. Track states including:
   - open
   - partial
   - filled
   - cancelled
   - expired
   - replaced
3. Record transition timestamps and reasons.
4. Emit journal events for meaningful transitions.
5. Ensure partial fills update local order state incrementally and safely.

#### Expected Result

Open live limit orders are managed by a single lifecycle surface rather than scattered through stream, reconciliation, and actor code.

---

### Slice 4 — Add Timeout, Cancel, And Replace Policies

#### Goal

Support stale-order handling and the broader management actions that minimal Phase 3 deliberately defers.

#### Files

- `packages/engine/src/` new policy or manager modules
- `apps/worker/src/trading-actor.ts`
- `apps/worker/src/agent-trading-actor.ts`
- orderbook venue adapters that support cancel/amend

#### Tasks

1. Define configurable limit-order timeout policies.
2. Cancel stale orders when policy says they should not remain live.
3. Add amend-in-place for venues that support it.
4. Add cancel-and-replace fallback for venues that do not.
5. Persist replacement lineage so order history is reconstructable.

#### Expected Result

OpenAIdom can actively manage resting orders instead of only placing them and waiting.

---

### Slice 5 — Support Richer Venue Semantics

#### Goal

Expose advanced order controls without hiding which venues do and do not support them.

#### Files

- `packages/domain/src/ports/orderbook-venue.ts`
- `packages/venues/src/*`
- strategy or planning surfaces only where the new semantics are intentionally used

#### Tasks

1. Add typed support for time-in-force variants.
2. Add typed support for post-only and reduce-only where available.
3. Ensure unsupported combinations are rejected before submit.
4. Keep venue-specific logic adapter-local as much as possible.

#### Expected Result

The engine can opt into richer order semantics on capable venues without pretending those features are universal.

---

### Slice 6 — Strengthen Restart Recovery For Managed Open Orders

#### Goal

Recover open and partially filled limit orders safely after crash or restart.

#### Files

- `apps/worker/src/trading-actor.ts`
- `apps/worker/src/agent-trading-actor.ts`
- reconciliation or recovery helpers already used for live orders
- repositories that load persisted open orders and recent fills

#### Tasks

1. Rehydrate open orders from durable storage on startup.
2. Query venue state before attempting any repair action.
3. Match venue orders by `clientOrderId` and venue reference where available.
4. Resolve uncertain states into one of:
   - still open
   - partially filled
   - fully filled
   - cancelled
   - unrecoverable/manual intervention required
5. Avoid blind duplicate submission in all ambiguous crash windows.

#### Expected Result

Restart recovery becomes robust enough for actively managed live limit orders rather than only simple submit-and-wait flows.

---

### Slice 7 — Execution Quality And Alerting

#### Goal

Add observability for the richer lifecycle this feature introduces.

#### Files

- `packages/engine/src/journal.ts`
- `apps/worker/src/alerting/*`
- relevant dashboards or export surfaces if they already consume these events

#### Tasks

1. Emit order timeout, cancellation, replacement, and recovery events.
2. Extend slippage and fill-quality telemetry for completed limit orders.
3. Differentiate informational lifecycle events from failure alerts.
4. Make manual intervention states explicit.

#### Expected Result

Operators can tell the difference between normal managed-order behavior and actual execution failures.

## Validation Plan

Focused validation should include:

1. executor tests for limit-order submission acceptance and rejection paths
2. lifecycle-manager tests for open to partial to filled transitions
3. timeout and cancellation tests
4. amend-in-place tests on capable venues
5. cancel-and-replace fallback tests on non-amend venues
6. restart recovery tests covering uncertain submit and partial-fill windows
7. `pnpm lint`

## Acceptance Criteria

1. Live limit orders can be submitted and persisted on supported orderbook venues.
2. The system can safely track partial fills and terminal states.
3. Stale limit orders can be cancelled by policy.
4. Supported venues can amend orders in place; unsupported venues fall back to cancel-and-replace or explicit rejection.
5. Advanced semantics such as time-in-force and post-only are capability-gated rather than assumed.
6. Restart recovery never blind-resubmits a possibly live order.
7. Operators can distinguish timeout, cancellation, replacement, partial fill, and recovery events from true failures.

## Effort Estimate

Relative to the minimal Phase 3 limit-order path, this broader feature is materially larger.

Rough estimate:

- minimal Phase 3 limit-order support: medium slice inside the main phase
- this broader feature: roughly an additional 1 to 2 weeks after the minimal path, depending on how many venues must support amend and richer order semantics immediately

The extra effort is mostly in lifecycle edge cases, recovery behavior, capability modeling, and test coverage rather than in the initial submit path.

## Suggested Sequencing

1. Land minimal Phase 3 live limit-order safety first.
2. Reassess which venues truly need amend/post-only/time-in-force breadth immediately.
3. Start this pending feature only after the minimal live safety path is stable.