# 1inch Launch Safety

**Related plans:**

1. [011-phase-3-swap-live-safety-parity.md](./011-phase-3-swap-live-safety-parity.md)
2. [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md)
3. [012-jupiter-launch-safety.md](./012-jupiter-launch-safety.md)

## Parallelism

This plan can proceed in parallel with [012-jupiter-launch-safety.md](./012-jupiter-launch-safety.md) after `011` lands. Both venue-specific plans are independent of each other.

## Purpose

Close the remaining 1inch-specific launch gap for MVP production readiness.

Like the Jupiter plan, this is not a greenfield venue plan. The 1inch adapter is already implemented end to end. The remaining work is to make its launch-safety proof explicit at the places where EVM swap execution usually fails under scrutiny:

1. approval semantics
2. spender reset edge cases
3. router-scoped transaction interpretation
4. live validation outside CI

## Problem

The current 1inch slice is materially stronger than the older backlog implied:

1. `OneInchSwapAdapter` quotes, approves, executes, fetches balances, and parses recent transactions
2. the adapter already has substantial unit coverage
3. worker factory wiring for 1inch credential resolution exists
4. router-aware transaction filtering is already supported through config

But the launch blocker remains because the proof is still incomplete in the places that matter most for real EVM execution:

1. the live integration test exists but is skipped in CI and therefore is not part of normal launch evidence
2. the approval flow is implemented, but the most failure-prone branches need stronger explicit coverage and validation
3. the zero-reset path for non-zero-to-non-zero allowance restrictions must be treated as launch-critical behavior, not incidental implementation detail
4. transaction interpretation depends on router-scoped transfer inference, which needs clear proof against false positives and false negatives
5. generic swap parity work in `011` is still required before 1inch can be called launch-safe on restart and ambiguity handling

For clarity: `routerAddress` is optional in the current code path, but it should be treated as required for MVP 1inch live launch. Without it, `fetchRecentTransactions()` falls back to broader wallet-activity inference that is weaker for recovery, ambiguity handling, and operator evidence.

So the remaining gap is not adapter absence. It is venue-specific safety proof at the EVM execution boundary.

## Scope

In scope:

1. explicit approval-flow and reset-approval regression coverage
2. stronger proof around transaction interpretation and router filtering
3. worker and config validation for 1inch live prerequisites
4. a repeatable non-CI live validation path for the actual 1inch venue stack
5. final venue-specific readiness proof once generic swap parity lands

Out of scope:

1. redesigning the 1inch adapter architecture
2. adding new EVM chains as part of this slice
3. broad wallet-truth or reconciliation redesign
4. generic swap restart safety outside the work already covered by `011`
5. CI automation that depends on permanent live secrets

## Current Verified Baseline

From the code as it exists today:

1. `packages/venues/src/oneinch-swap.ts` implements quote, approval, swap execution, balances, and recent-transaction parsing
2. `packages/venues/src/oneinch-swap.test.ts` already covers raw amount conversion, quote handling, approval-before-swap ordering, rate limiting, and transaction parsing behavior
3. the adapter includes an explicit zero-reset allowance path when approval fails with on-chain revert and an existing non-zero allowance is present
4. `packages/venues/src/oneinch.integration.test.ts` exists as a manual live integration harness
5. `apps/worker/src/venue-adapter-factory.test.ts` already covers key 1inch credential-resolution failure cases
6. `packages/domain/src/config/schema.ts` and worker config support `routerAddress` for more truthful transaction filtering

The remaining gap is not lack of implementation. It is incomplete venue-specific launch evidence.

## Dependencies

This plan depends on `011` for the generic swap-live safety guarantees:

1. pending-confirmation restart recovery
2. timeout classification for unresolved confirmation
3. halt-on-ambiguity behavior
4. crash policy on confirmed post-swap exposure
5. execution-quality alerting

Without that shared work, 1inch can still execute but cannot honestly be called launch-safe under restart and ambiguity scenarios.

## Target State

After this slice:

1. the 1inch approval path has explicit launch-grade coverage, including reset-approval fallback behavior
2. transaction interpretation is proven against router-scoped false positives and false negatives
3. worker wiring and config prerequisites for 1inch live mode are tested directly
4. there is a repeatable operator-run validation path for real 1inch execution outside CI
5. once `011` is complete, the release checklist can mark 1inch as `complete` without caveats about unproven approval or integration behavior

## Resolved Decisions

1. `routerAddress` is optional in code today, but required for 1inch MVP live launch.
2. For 1inch, authoritative confirmation truth belongs in the shared confirmation/recovery path from `011`, not in `fetchRecentTransactions()`.
3. For launch safety, 1inch must provide one canonical operator-run validation command, with a short manual checklist as a companion runbook rather than the primary truth source.

## Implementation Plan

### Step 1: Tighten approval-flow regression coverage

**Goal:** make the most failure-prone EVM execution path explicit and stable.

Add or strengthen tests for:

1. insufficient allowance → approval happens before swap submission
2. sufficient allowance → approval is skipped cleanly
3. first approval revert with existing allowance → zero-reset then re-approve succeeds
4. zero-reset failure → adapter fails closed with explicit error
5. re-approve after reset failure → adapter surfaces clear failure instead of proceeding
6. transient approval failure without existing allowance → no destructive reset attempt is made

This is the single most important venue-specific proof gap.

Likely files:

1. `packages/venues/src/oneinch-swap.test.ts`
2. `packages/venues/src/oneinch-swap.ts`

### Step 2: Prove router-scoped transaction interpretation

**Goal:** ensure `fetchRecentTransactions()` does not claim swap truth from unrelated wallet activity.

Decision for this slice:

1. the MVP launch path assumes `routerAddress` is configured
2. tests and docs should treat missing `routerAddress` as a degraded, non-launch-safe mode rather than an equally valid production configuration

Focus on:

1. when `routerAddress` is configured, only router-related transfer groups are interpreted as swap activity
2. unrelated transfers, LP deposits, or token movements are excluded
3. dominant sent/received asset inference does not silently misclassify multi-transfer activity
4. missing or ambiguous transfer groups are treated conservatively

This matters because 1inch recovery and observational telemetry rely on chain transaction interpretation, and false confidence here is dangerous.

Likely files:

1. `packages/venues/src/oneinch-swap.test.ts`
2. `packages/venues/src/oneinch-swap.ts`

### Step 3: Validate worker and config prerequisites for 1inch live mode

**Goal:** prove that unsafe 1inch live startup is blocked before execution begins.

For MVP launch readiness, this step should make the `routerAddress` decision explicit even if the current implementation still parses without it.

Focus on:

1. missing linked credential fails closed
2. missing `CREDENTIAL_ENCRYPTION_KEY` fails closed
3. invalid `routerAddress` fails closed at config validation time, and missing `routerAddress` is documented/tested as non-launch-safe for 1inch live release evidence
4. adapter factory wiring produces a correct `OneInchSwapAdapter` when prerequisites are present
5. allowed-venue and live-gate checks remain aligned with swap launch policy

Some of this already exists, but the tests should form a complete launch story rather than scattered coverage.

Likely files:

1. `apps/worker/src/venue-adapter-factory.test.ts`
2. `apps/worker/src/live-gate.test.ts`
3. `apps/worker/src/agent-trading-actor.test.ts` if actor-level live prerequisites need stronger proof

### Step 4: Tie 1inch into the shared swap parity model

**Goal:** avoid creating venue-specific recovery behavior while still proving that 1inch is safe under the shared model.

Once `011` lands, add focused validation that proves:

1. 1inch execution evidence enters the shared pending-confirmation recovery path
2. restart recovery uses the shared confirmation evidence surface for definitive confirmation and uses recent-transaction evidence only as supporting telemetry
3. ambiguous on-chain state halts rather than resubmits
4. confirmed post-swap exposure follows the configured crash policy

This should reuse the common swap safety infrastructure rather than branching into custom 1inch recovery logic.

Likely files:

1. `packages/engine/src/swap-live-executor.test.ts`
2. `apps/worker/src/agent-trading-actor.test.ts`
3. `packages/venues/src/oneinch-swap.test.ts` where transaction evidence helpers need direct proof

### Step 5: Add a non-CI live validation harness

**Goal:** establish real launch evidence without pretending CI can safely own live 1inch credentials.

Preferred outcome:

1. one canonical operator-run validation command for Base + 1inch
2. one short manual checklist that explains prerequisites, expected outputs, and evidence capture for that command
3. explicit prerequisites: API key, encrypted credential, RPC URL, funded wallet, and configured `routerAddress`
4. expected evidence: quote success, approval behavior, swap submission, transaction confirmation, persisted execution evidence
5. one known-safe test pair and notional size for repeated operator checks

The existing skipped integration test is a good start, but it is not yet a full launch validation story.

Likely files:

1. `packages/venues/src/oneinch.integration.test.ts`
2. `scripts/ts/agent-trade-test.ts` if a reusable 1inch-specific mode makes sense
3. a short execution note if needed

## Failure Modes To Prove False Before Launch

1inch must not be called launch-safe until there is explicit evidence that each of these failure modes is false or safely handled:

1. **Swap executes without required approval.** The adapter must not submit the swap transaction before allowance is sufficient.
2. **Reset-approval logic damages a usable allowance state.** Zero-reset must only run in the specific revert case it was designed for.
3. **Approval failure is swallowed and swap proceeds anyway.** Any approval failure must fail closed.
4. **Recent-transaction parsing mistakes unrelated transfers for swap truth.** Router filtering and transfer grouping must not overclaim.
5. **Pending EVM swap disappears across restart.** A submitted swap must remain recoverable through the shared swap parity path. (Shared safety guarantee — closed by `011`, proven here for 1inch-specific evidence.)
6. **Ambiguous chain state triggers blind resubmission.** Uncertain 1inch state must halt and alert, not retry speculatively. (Shared safety guarantee — closed by `011`, proven here for 1inch-specific evidence.)
7. **Worker startup permits unsafe live mode.** Missing credential, key, or required config must block live execution.

The point is to disprove concrete bad outcomes, not just to show a happy path works.

## Acceptance Criteria

This slice is done when all of the following are true:

1. approval and reset-approval branches have explicit focused test coverage
2. transaction interpretation is proven conservative when router evidence is absent or unrelated
3. worker tests prove 1inch live prerequisites directly
4. generic swap parity work from `011` is sufficient for 1inch restart and ambiguity safety
5. there is one repeatable real-world validation path for 1inch outside CI
6. the release checklist can mark `1inch swap trading` as `complete` without caveats about unproven approval or integration behavior

For release purposes, item 5 means a canonical command exists and the companion checklist documents how to run it and what evidence to capture.

## Suggested Validation

1. focused `oneinch-swap.test.ts`
2. targeted `oneinch.integration.test.ts` run outside CI
3. worker tests for adapter factory and live gate
4. focused swap executor and actor tests once `011` lands
5. `pnpm lint`

## Relationship To Other Plans

This plan is venue-specific follow-up to `011`.

1. `011` solves the shared swap safety model
2. this doc proves the remaining 1inch-specific EVM execution boundary

The intended order is:

1. land `011`
2. land the focused 1inch proof and validation work from this doc
3. then update the release checklist

## Relationship To Release Checklist

Closing this doc, together with `011`, should move `1inch swap trading` in [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md) from `incomplete` to `complete`.