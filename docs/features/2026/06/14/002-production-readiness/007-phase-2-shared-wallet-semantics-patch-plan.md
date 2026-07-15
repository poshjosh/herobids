# Phase 2b - Shared-Wallet Swap Semantics Patch Plan

## Why This Exists

`005-phase-2-complete-swap-execution.md` correctly drove the execution work that was actually needed:

- swap startup for agents
- live swap execution
- Jupiter signing
- confirmation polling
- fill persistence

It also encoded a stronger claim that does not hold for OpenAIdom' current product boundary: fills can be turned into authoritative "expected holdings" and then reconciled against the user's wallet as though the platform owns the whole wallet ledger.

That assumption is concrete in the current Phase 2 implementation, especially in:

- `packages/engine/src/swap-position-tracker.ts`
- `packages/engine/src/reconciliation/venue-state-loaders.ts`
- `packages/engine/src/reconciliation/reconcile.ts`
- `packages/engine/src/reconciliation/reconciler.ts`

This plan preserves the execution core and patches only the parts that over-claim wallet-accounting truth for shared wallets.

## Scope Boundary

In scope:

- keep live/shadow swap execution intact
- keep signing, broadcast, and transaction confirmation intact
- downgrade shared-wallet balance checks from authoritative reconciliation to observational telemetry
- remove naming that implies full-wallet accounting truth
- update tests and backlog/docs so Phase 2 status reflects reality

Out of scope:

- redesigning Phase 3 live-safety work
- inventing a dedicated-wallet product mode in this patch
- broad repo-wide language cleanup outside the Phase 2 surfaces

## Phase 2 File Disposition

The goal is not to reopen all of Phase 2. It is to keep the execution path and patch the semantic boundary.

| File from `005-phase-2-complete-swap-execution.md` | Disposition | Patch intent |
|---|---|---|
| `packages/db/src/schema/trading-bindings.ts` | keep | No semantic change needed for `swapAssets` metadata |
| `apps/worker/src/index.ts` | keep | Startup resolution remains valid |
| `apps/worker/src/resolve-swap-assets.ts` | keep | Binding metadata resolution remains valid |
| `packages/engine/src/swap-live-executor.ts` | keep | Execution correctness stays intact |
| `apps/worker/src/live-gate.ts` | keep | Live venue admission remains valid |
| `packages/venues/src/jupiter-swap.ts` | keep, comment-only if needed | Signing/broadcast remains authoritative execution behavior |
| `packages/venues/src/swap-confirmation-poller.ts` | keep, comment-only if needed | Confirmation remains authoritative for execution status |
| `packages/venues/src/jupiter-confirmation.ts` | keep, comment-only if needed | Confirmation parsing remains valid |
| `packages/engine/src/swap-position-tracker.ts` | patch | Stop presenting fill-derived balances as wallet truth |
| `packages/engine/src/reconciliation/venue-state-loaders.ts` | patch | Stop translating shared-wallet balance variance into synthetic reconciliation positions |

Adjacent files needed to land the change safely:

- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/trading-actor.ts`
- `packages/engine/src/reconciliation/reconcile.ts`
- `packages/engine/src/reconciliation/reconciler.ts`
- `packages/domain/src/ports/swap-venue.ts`
- `apps/worker/src/alerting/alert-policy.ts`
- `packages/engine/src/swap-position-tracker.test.ts`
- `packages/engine/src/reconciliation/venue-state-loaders.test.ts`
- `packages/engine/src/reconciliation/drift-category.test.ts`
- `packages/engine/src/reconciliation/reconciler.test.ts`
- `docs/features/2026/06/14/002-production-readiness/002-backlog.md`
- `docs/features/2026/06/14/002-production-readiness/005-phase-2-complete-swap-execution.md`

## Patch Slices

### Slice 0: Freeze The Doctrine Before More Code Moves

Create one short doctrine doc before changing behavior. Keep it narrow and product-specific.

Suggested new file:

- `docs/best-practices/shared-wallet-accounting-boundary.md`

Required statements:

- fills, decisions, confirmations, and infra billing are authoritative records
- `capitalUsd` is a risk-budget baseline, not a claim about wallet composition
- shared-wallet venue balances are observational telemetry
- OpenAIdom does not claim full-wallet accounting truth for shared user wallets
- strict holdings reconciliation is only valid for a future dedicated/managed-wallet mode

This doc is the guardrail for the rest of the patch.

### Slice 1: Reframe The Swap Tracker As Fill Projection, Not Wallet Truth

Files:

- `packages/engine/src/swap-position-tracker.ts`
- `packages/engine/src/swap-position-tracker.test.ts`

Concrete patch:

- Rename the internal concept away from `expectedBalance` and `expected holdings`
- Prefer names like `netFlow`, `projectedDelta`, or `fillProjection`
- Keep rehydration from fills exactly as-is: replaying fills into a per-actor projection is still useful
- Replace `computeDrift()` with an observational comparison API whose naming does not imply authoritative wallet truth
- Remove test names that describe external deposits or withdrawals as definitively "unexplained"

Target behavior after this slice:

- the tracker still answers "what net asset movement do this actor's recorded fills imply?"
- the tracker no longer answers "what does the wallet truly hold?"

### Slice 2: Stop Converting Shared-Wallet Variance Into Reconciliation Positions

Files:

- `packages/engine/src/reconciliation/venue-state-loaders.ts`
- `packages/engine/src/reconciliation/venue-state-loaders.test.ts`
- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/trading-actor.ts`

Concrete patch:

- Remove the path in `createSwapVenueStateLoader()` that maps tracker variance into synthetic `positions`
- For current shared-wallet swap accounts, always return:
  - empty `positions`
  - real balance snapshots
  - empty `recentFills`
  - empty `openOrders`
- Keep `SwapPositionTracker` in actors only as an actor-local fill projection if still useful for audit/debugging
- Stop wiring the tracker into reconciliation as though it were a source of authoritative venue-state expectations

Reason:

`createSwapVenueStateLoader()` currently turns wallet variance into orderbook-shaped reconciliation drift. That is the wrong abstraction boundary for shared wallets.

### Slice 3: Separate Observational Variance From Authoritative Drift

Files:

- `packages/engine/src/reconciliation/reconcile.ts`
- `packages/engine/src/reconciliation/reconciler.ts`
- `packages/engine/src/reconciliation/drift-category.test.ts`
- `packages/engine/src/reconciliation/reconciler.test.ts`
- `apps/worker/src/alerting/alert-policy.ts`

Concrete patch:

- Introduce an explicit distinction between:
  - authoritative drift: local state and venue state should match
  - observational variance: the platform observed a balance difference on a shared wallet
- Replace swap/shared-wallet wording like `unexplained_balance_delta` with language such as `observed_balance_variance`
- Ensure shared-wallet swap balance variance does not journal as `reconciliation.drift_detected` unless the code has an authoritative basis for that claim
- Route observational variance at lower alert severity than hard execution/risk failures

Implementation note:

Do not try to infer intent from wallet deltas. A manual withdrawal, external deposit, or unrelated activity in the same wallet is not a OpenAIdom reconciliation failure.

### Slice 4: Tighten Port And Adapter Semantics Without Reopening Execution Core

Files:

- `packages/domain/src/ports/swap-venue.ts`
- `packages/venues/src/jupiter-swap.ts`
- `packages/venues/src/swap-confirmation-poller.ts`
- `packages/venues/src/jupiter-confirmation.ts`

Concrete patch:

- Clarify in port comments that `fetchBalances()` and `fetchRecentTransactions()` are telemetry surfaces for shared wallets
- Clarify that transaction confirmation is authoritative for execution outcome, not for full-wallet accounting truth
- Avoid functional changes to signing, execution, or confirmation unless a comment or type still leaks the old assumption

Important non-goal:

Do not destabilize `SwapLiveExecutor`, Jupiter signing, or confirmation polling as part of this patch. Those are the good parts of Phase 2.

### Slice 5: Realign The Phase 2 Docs And Backlog To Match The New Truth

Files:

- `docs/features/2026/06/14/002-production-readiness/005-phase-2-complete-swap-execution.md`
- `docs/features/2026/06/14/002-production-readiness/002-backlog.md`

Concrete patch:

- In `005-phase-2-complete-swap-execution.md`, rewrite Target State items 6 and 7
- Replace "expected token holdings" language with "fill-derived asset projections" or equivalent
- Change the done signal so a manual wallet withdrawal is treated as observational variance in shared-wallet mode, not proof of reconciliation correctness
- In `002-backlog.md`, update the moved file names:
  - `004-phase-1-risk-foundation.md`
  - `005-phase-2-complete-swap-execution.md`
- Change Phase 2 status from fully completed to a split status such as:
  - execution core: done
  - shared-wallet semantics correction: pending or in progress

This avoids letting the backlog claim "done" while the semantics are still wrong.

## Order Of Work

1. Write the doctrine doc.
2. Patch `swap-position-tracker.ts` and its tests.
3. Patch `venue-state-loaders.ts` and stop feeding synthetic swap drift into reconciliation.
4. Patch `reconcile.ts`, `reconciler.ts`, and alert routing to distinguish observational variance from authoritative drift.
5. Update the Phase 2 doc and backlog.
6. Rerun the focused swap/reconciliation test set.
7. Run `pnpm lint`.

## Validation Plan

Focused test run:

```bash
pnpm test -- \
  packages/engine/src/swap-position-tracker.test.ts \
  packages/engine/src/reconciliation/venue-state-loaders.test.ts \
  packages/engine/src/reconciliation/drift-category.test.ts \
  packages/engine/src/reconciliation/reconciler.test.ts \
  packages/engine/src/swap-live-executor.test.ts \
  packages/venues/src/jupiter-confirmation.test.ts \
  apps/worker/src/live-gate.test.ts
```

Repo validation:

```bash
pnpm lint
```

## Acceptance Criteria

1. Shared-wallet swap code no longer describes fill-derived balances as authoritative wallet holdings.
2. Shared-wallet swap reconciliation no longer emits synthetic position drift from wallet balance variance.
3. Manual deposits, withdrawals, or unrelated wallet activity are treated as observational variance rather than definitive OpenAIdom reconciliation failure.
4. Live swap execution, signing, and confirmation behavior remain unchanged.
5. Alert routing distinguishes observational swap balance variance from real execution or risk failures.
6. `005-phase-2-complete-swap-execution.md` and `002-backlog.md` accurately describe what is done and what remains open.

## Deliberate Deferral

This patch deliberately does not implement a dedicated-wallet strict-reconciliation mode. If that product mode is needed later, add it as a separate plan with an explicit source of truth for wallet exclusivity instead of smuggling it back in through swap reconciliation.