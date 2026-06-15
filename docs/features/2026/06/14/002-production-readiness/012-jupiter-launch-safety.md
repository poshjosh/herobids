# Jupiter Launch Safety

**Related plans:**

1. [011-phase-3-swap-live-safety-parity.md](./011-phase-3-swap-live-safety-parity.md)
2. [005-phase-2-complete-swap-execution.md](./005-phase-2-complete-swap-execution.md)
3. [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md)

## Parallelism

This plan can proceed in parallel with [013-1inch-launch-safety.md](./013-1inch-launch-safety.md) after `011` lands. Both venue-specific plans are independent of each other.

## Purpose

Close the remaining Jupiter-specific launch gap for MVP production readiness.

This is not a plan to build Jupiter support from scratch. Jupiter live execution already exists. The remaining work is to make the Jupiter slice launch-safe and provable:

1. cover the adapter boundary directly with focused tests
2. prove live-mode wiring around signer and confirmation dependencies
3. validate the end-to-end Jupiter path against the bounded swap-safety model

## Problem

The current verified state is stronger than the earlier backlog implied:

1. `JupiterSwapAdapter` quotes and executes swaps through `SolanaSignerPort`
2. `JupiterConfirmationPoller` exists and has direct tests
3. worker startup can resolve swap assets from binding metadata
4. live gate allows swap venues when signing prerequisites are present
5. `SwapLiveExecutor` already provides deterministic submission-state evidence

But the Jupiter launch blocker still stands because the proof is uneven:

1. there is no `jupiter-swap.test.ts`
2. there is no dedicated Jupiter integration path that exercises quote → sign/broadcast → confirmation as one venue slice
3. generic swap parity work in `011` is still open, so Jupiter restart safety is not yet complete
4. there is not yet one clear validation pass that says Jupiter is ready under the actual MVP launch rules

So the gap is not missing product capability. It is missing launch-grade venue proof and final Jupiter-specific closure.

## Scope

In scope:

1. direct unit coverage for `JupiterSwapAdapter`
2. signer-boundary tests for live execution failure and success branches
3. confirmation-poller integration with the Jupiter execution path where practical
4. worker wiring validation for Jupiter live/shadow startup requirements
5. one focused validation path that proves Jupiter is launch-safe once swap parity lands

Out of scope:

1. redesigning the Jupiter adapter API
2. new swap routing features or quote strategies
3. full-chain external end-to-end tests that require permanent live credentials in CI
4. solving generic swap restart safety outside the shared work already planned in `011`
5. dedicated-wallet reconciliation or wallet-truth redesign

## Current Verified Baseline

From the code as it exists today:

1. `packages/venues/src/jupiter-swap.ts` implements quote, execute, balance fetch, transaction fetch, and venue probe behavior
2. `executeSwap()` fails closed when no `SolanaSignerPort` is present
3. `packages/venues/src/jupiter-confirmation.ts` plus `.test.ts` cover signer-backed and direct-RPC confirmation polling
4. `packages/engine/src/swap-live-executor.test.ts` proves generic swap executor behavior and deterministic submission-state emission
5. `apps/worker/src/resolve-swap-assets.test.ts` covers binding-metadata resolution for swap assets
6. `apps/worker/src/venue-adapter-factory.test.ts` already verifies that Jupiter adapter construction is wired at factory level

The missing proof is at the Jupiter adapter boundary and the final venue-specific launch validation layer.

For release evidence, the intended end state is one canonical operator-run Jupiter validation command, with a short manual checklist as supporting runbook rather than the primary truth source.

## Dependencies

This plan depends on `011` for the generic swap-live safety guarantees:

1. pending-confirmation restart recovery
2. timeout classification for unresolved confirmation
3. halt-on-ambiguity handling
4. crash policy on confirmed post-swap exposure
5. swap execution-quality alerting

Without those, Jupiter can be functionally real but still not production-launch safe.

## Target State

After this slice:

1. the Jupiter adapter has direct unit coverage for quote, execute, and error branches
2. the signer boundary is explicitly tested so live-mode failures are fail-closed and auditable
3. Jupiter confirmation behavior is tied into the actual execution path with focused validation
4. worker wiring for Jupiter startup and live prerequisites is covered by tests, not inference
5. once `011` is complete, Jupiter can be marked `complete` in the release checklist without hedging

## Implementation Plan

### Step 1: Add direct unit tests for `JupiterSwapAdapter`

**Goal:** cover the adapter boundary itself instead of relying only on generic swap executor tests.

Create `packages/venues/src/jupiter-swap.test.ts` with focused tests for:

1. quote success with human-readable ↔ raw unit conversion
2. quote failure on non-200 Jupiter API response
3. execution failure when no signer is configured
4. execution success when signer returns a transaction signature
5. signer failure propagation from `signAndSendTransaction`
6. balance fetch behavior for SPL tokens and native SOL merge logic
7. transaction fetch parsing if that surface is currently used by recovery code

This is the main missing proof gap called out by the checklist.

Likely files:

1. `packages/venues/src/jupiter-swap.test.ts`
2. `packages/venues/src/jupiter-swap.ts`

### Step 2: Add focused signer-boundary regression coverage

**Goal:** make the live-execution contract around signing explicit and stable.

Required branches:

1. no signer → `SWAP_SIGNING_UNAVAILABLE`
2. signer success → receipt with authoritative execution ref
3. signer transport or broadcast failure → propagated venue error
4. malformed or incomplete Jupiter API response → fail closed

The signer is the critical live boundary for Jupiter. If this edge is weak, the venue may appear implemented while still being unsafe under launch conditions.

Likely files:

1. `packages/venues/src/jupiter-swap.test.ts`
2. `packages/venues/src/solana-signer.ts` only if small testability improvements are needed

### Step 3: Validate worker wiring for Jupiter live prerequisites

**Goal:** prove that the worker only enables Jupiter live execution when the required wiring is actually present.

Focus on:

1. swap asset resolution from binding metadata
2. signer presence for live mode
3. factory construction of `JupiterSwapAdapter`
4. live-gate behavior for allowed swap venue plus signer-present conditions

Some of this is already covered indirectly. This step is about closing the last gaps so launch safety does not depend on reading multiple tests and inferring that the whole path is safe.

Likely files:

1. `apps/worker/src/venue-adapter-factory.test.ts`
2. `apps/worker/src/live-gate.test.ts`
3. `apps/worker/src/resolve-swap-assets.test.ts`
4. `apps/worker/src/agent-trading-actor.test.ts` if actor-level Jupiter startup coverage is still thin

### Step 4: Tie Jupiter validation to generic swap parity work

**Goal:** avoid inventing a separate Jupiter recovery model while still proving Jupiter-specific readiness.

Once `011` lands, add one focused validation path for Jupiter that proves:

1. quote and execute produce Jupiter-specific execution evidence
2. pending confirmation enters the shared recovery model
3. restart re-check uses Jupiter confirmation evidence
4. ambiguity halts instead of resubmitting

This should reuse the generic swap-live safety infrastructure rather than duplicating it under a venue-specific branch.

Likely files:

1. `packages/engine/src/swap-live-executor.test.ts`
2. `apps/worker/src/agent-trading-actor.test.ts`
3. `packages/venues/src/jupiter-confirmation.test.ts`

### Step 5: Add a non-CI launch validation harness

**Goal:** have a realistic manual or gated validation path for Jupiter without requiring permanent secrets in CI.

Preferred outcome:

1. one canonical operator-run validation command or script for Jupiter smoke checks
2. one short manual checklist that explains prerequisites, expected outputs, and evidence capture for that command
3. explicit prerequisites: Solana signer, funded wallet, RPC URL, binding metadata
4. expected outputs: quote success, signed submission, confirmation observed, fill/journal evidence persisted

This is not about adding a flaky CI test. It is about giving launch readiness a repeatable operator-run proof path.

Likely files:

1. `scripts/ts/agent-trade-test.ts` if it can support a Jupiter-specific mode cleanly
2. a focused production-readiness test note if needed

## Acceptance Criteria

This slice is done when all of the following are true:

1. `JupiterSwapAdapter` has direct unit coverage for quote, execute, signer-failure, and API-failure branches
2. worker tests prove Jupiter live wiring prerequisites instead of relying on inference
3. generic swap parity work from `011` is sufficient for Jupiter restart and ambiguity safety
4. there is one repeatable validation path for a real Jupiter launch check outside CI
5. the release checklist can mark `Jupiter swap trading` as `complete` without hedged language about missing venue-specific proof

For release purposes, item 4 means a canonical command exists and the companion checklist documents how to run it and what evidence to capture.

## Failure Modes To Prove False Before Launch

Jupiter must not be called launch-safe until the team has explicit evidence that each of these failure modes is false or safely handled:

1. **Unsigned live execution appears successful.** A live Jupiter path must never report success when no signer is configured.
2. **Signer or broadcast failure is swallowed.** If signing or broadcast fails, the error must surface clearly and the execution must not be misclassified as pending or filled.
3. **Quote conversion is numerically wrong.** Human-readable to raw-unit conversion must not overspend, under-size, or silently round in the wrong direction.
4. **Pending confirmation can be abandoned across restart.** A submitted Jupiter swap must not disappear from recovery tracking after crash or restart. (Shared safety guarantee — closed by `011`, proven here for Jupiter-specific evidence.)
5. **Ambiguous chain state causes blind resubmission.** If confirmation truth is unresolved, the runtime must halt and alert rather than retry the swap speculatively. (Shared safety guarantee — closed by `011`, proven here for Jupiter-specific evidence.)
6. **Worker wiring allows unsafe live startup.** Jupiter live mode must not start without the required signer, binding metadata, and allowed-venue conditions.
7. **Observed wallet balances are treated as authoritative proof.** Shared-wallet variance must not be misrepresented as strict holdings truth or used to justify unsafe automated recovery.

The point of this section is to force launch evidence against concrete bad outcomes, not just against happy-path behavior.

## Suggested Validation

1. focused `jupiter-swap.test.ts`
2. existing `jupiter-confirmation.test.ts`
3. focused worker tests for adapter factory and live gate
4. focused swap executor and actor tests once `011` lands
5. `pnpm lint`

## Relationship To Other Plans

This plan is narrower than `011`.

1. `011` solves generic swap-live safety parity across venues
2. this doc solves the remaining Jupiter-specific proof and launch-validation gap

The intended order is:

1. land `011`
2. land the focused Jupiter adapter and wiring proof from this doc
3. then update the release checklist

## Relationship To Release Checklist

Closing this doc, together with `011`, should move `Jupiter swap trading` in [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md) from `incomplete` to `complete`.