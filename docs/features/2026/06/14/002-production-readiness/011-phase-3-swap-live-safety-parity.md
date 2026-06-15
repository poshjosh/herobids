# Phase 3 — Swap Live Safety Parity

**Parent task list:** [009-phase-3-live-execution-safety-tasks.md](./009-phase-3-live-execution-safety-tasks.md)

## Purpose

Take the remaining Phase 3 swap-live launch blockers out of the umbrella task list and turn them into one focused implementation slice.

This document is the concrete plan for T9 and T10 from the parent task list. It exists because the remaining production gap is no longer "live execution safety" in general. It is now specifically bounded swap-live recovery, crash handling, and execution-quality truth.

## Why This Needs Its Own Doc

Orderbook safety work is already landed. The unresolved launch-critical gap is narrower:

1. pending-confirmation swap recovery across restart
2. timeout classification for unresolved swap confirmation
3. halt-on-ambiguity behavior for swaps
4. crash-policy handling for confirmed post-swap exposure
5. execution-quality alerting for swap outcomes

Keeping that work inside `009` is fine for status tracking, but not ideal for implementation. This doc isolates the next shipping slice without reopening Phase 2 swap execution design.

## Scope

In scope:

1. persist restart-readable swap recovery evidence at the earliest safe point supported by the current executor contract
2. classify pending confirmation by timeout instead of waiting forever
3. reload and re-check pending swap confirmation on actor startup
4. halt and alert when swap state is ambiguous
5. apply configured crash policy to confirmed post-swap exposure only
6. emit swap execution-quality alerts from quote or decision-time expectation
7. add focused regression coverage for the swap recovery branches

Out of scope:

1. redesigning swaps into a full orderbook-style lifecycle engine
2. new swap routing or quoting features
3. dedicated-wallet reconciliation redesign
4. paper-swap runtime support
5. venue-specific product expansion beyond recovery and safety

## Dependencies Already Satisfied

This slice assumes the following Phase 3 foundations are already in place:

1. live work can be rehydrated on startup
2. timeout classification exists for orderbook live work
3. orderbook live recovery already uses halt-on-ambiguity
4. crash policy is already operator-configurable for confirmed orderbook exposure
5. execution-quality alerting already exists for orderbook fills

That means swap parity should reuse the same safety posture rather than invent a second recovery model.

## Target State

After this slice:

1. a live swap that was submitted before a crash can be reloaded on restart with enough evidence to avoid blind resubmission
2. a pending-confirmation swap is re-checked through confirmation evidence instead of being assumed failed or retried automatically
3. a timed-out confirmation becomes explicit recovery-required state
4. ambiguous swap state halts and alerts instead of guessing
5. confirmed post-swap exposure follows the configured crash policy
6. materially adverse swap execution emits execution-quality alerts with real comparison data

## Current Verified Gaps

From the verified release checklist, the remaining gaps are:

1. `SwapLiveExecutor` handles quote-then-execute but does not yet provide full durable restart recovery parity for pending confirmation
2. `SwapConfirmationPoller` exists and Jupiter confirmation is implemented, but restart recovery is not yet closed end-to-end
3. Jupiter and 1inch both depend on this slice for launch safety, even though their adapters already exist

## Implementation Plan

### Step 1: Make swap recovery evidence restart-readable

**Goal:** persist enough swap execution evidence that restart logic can tell whether a swap was prepared, submitted, still pending confirmation, or already confirmed.

Persist or reload at minimum:

1. actor identity and plan context
2. venue type and binding context
3. quote-time expectation used for execution-quality comparison
4. transaction or execution reference once known
5. confirmation-pending timestamps and recovery status

Design constraint:

1. do not force swaps into the exact orderbook submission-state machine
2. persist only the evidence needed to classify recovery truthfully

Likely files:

1. `packages/engine/src/swap-live-executor.ts`
2. `apps/worker/src/trading-actor.ts`
3. `apps/worker/src/agent-trading-actor.ts`
4. `packages/db/src/repositories.ts` if persistence surface changes are needed

### Step 2: Add bounded pending-confirmation timeout and restart recovery

**Goal:** pending swap confirmation must become an explicit recovery path, not an indefinite wait or implicit retry.

Behavior:

1. track pending-confirmation age
2. classify timeout as recovery-required
3. on startup, reload pending swaps and re-check confirmation through the best available surface
4. if confirmation is proven, finalize normally
5. if absence is unprovable or state conflicts, halt and alert
6. never blindly resubmit on uncertainty

For venue handoff clarity:

1. definitive confirmation should come from the strongest venue-specific confirmation surface available to the shared model
2. observational wallet-activity surfaces such as `fetchRecentTransactions()` may support ambiguity analysis, but must not be promoted to authoritative confirmation truth by themselves

Likely files:

1. `packages/engine/src/swap-live-executor.ts`
2. `packages/domain/src/ports/swap-venue.ts`
3. `packages/venues/src/swap-confirmation-poller.ts`
4. `packages/venues/src/jupiter-confirmation.ts`
5. `apps/worker/src/trading-actor.ts`
6. `apps/worker/src/agent-trading-actor.ts`

### Step 3: Apply crash policy to confirmed swap exposure only

**Goal:** reuse the existing operator-configurable crash policy without overstating what swap recovery can prove.

Rules:

1. only confirmed post-swap exposure is eligible for crash-policy branching
2. ambiguous swap state stays in halt-and-alert flow
3. no auto-flatten behavior should run from uncertain confirmation state

Likely files:

1. `packages/engine/src/swap-live-executor.ts`
2. `apps/worker/src/trading-actor.ts`
3. `apps/worker/src/agent-trading-actor.ts`
4. `packages/engine/src/journal.ts`

### Step 4: Emit swap execution-quality alerts

**Goal:** surface materially adverse realized swap execution without pretending the swap lifecycle model is stronger than it is.

Alert basis may come from:

1. decision-time expectation
2. accepted quote
3. realized output amount or effective execution price

Rules:

1. alert only from confirmed completion evidence
2. tie alert payload to actual comparison inputs
3. keep the journal taxonomy aligned with existing live execution alerting

Likely files:

1. `packages/engine/src/journal.ts`
2. `packages/engine/src/swap-live-executor.ts`
3. `apps/worker/src/trading-actor.ts`
4. `apps/worker/src/agent-trading-actor.ts`

## Acceptance Criteria

This slice is done when all of the following are true:

1. a live swap pending confirmation survives restart without blind duplicate submission
2. pending confirmation timeout produces explicit recovery-required state
3. startup recovery re-checks confirmation before any retry decision
4. ambiguous swap state halts and alerts
5. confirmed swap exposure follows configured crash policy
6. confirmed materially adverse swap execution emits an execution-quality alert
7. focused regression tests cover restart recovery, timeout handling, ambiguity halt, and alerting branches

## Suggested Validation

1. focused `swap-live-executor` tests for restart recovery branches
2. actor tests covering pending-confirmation rehydration on startup
3. confirmation-poller tests for confirmed, still-pending, failed, and ambiguous results
4. `pnpm lint`

## Relationship To Release Checklist

Closing this doc should directly move these launch-gate items toward `complete`:

1. Jupiter swap trading
2. 1inch swap trading
3. swap pending-confirmation recovery and restart safety

Venue-specific follow-up proof for Jupiter lives in [012-jupiter-launch-safety.md](./012-jupiter-launch-safety.md).

Venue-specific follow-up proof for 1inch lives in [013-1inch-launch-safety.md](./013-1inch-launch-safety.md).

Risk contract integrity remains separate work after this slice.