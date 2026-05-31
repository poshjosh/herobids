# Phase 4: Live Rollout PR Sequence

**Parent plan:** [010-phase-4-live-rollout-plan.md](010-phase-4-live-rollout-plan.md)

**Latest rollout status:** [015-phase-4-live-rollout-status-2026-05-30.md](015-phase-4-live-rollout-status-2026-05-30.md)

**Purpose:** Break Phase 4 into reviewable PRs that each change one decision boundary, keep validation narrow, and avoid mixing live-capital rollout work with unrelated refactors.

**Execution rule:** Each PR must leave the repo in a green state on its own. Do not start the next PR until the current PR's focused validation passes.

---

## Slice Strategy

The split is deliberate:

1. Front-load operator gating and credential policy so unsafe live behavior is impossible before the executor exists.
2. Keep the live executor engine-only before wiring it into the worker.
3. Integrate runtime behavior only after the executor contract is stable.
4. Add operator read surfaces after there is real live-path state to observe.
5. Treat real-money rollout as a post-merge operational step, not as something hidden inside a large implementation PR.

---

## PR 1: Live Rollout Config And Startup Gates

**Suggested title:** `phase-4/pr1-live-gates`

**Goal:** Add operator-owned live-rollout config and fail-closed startup checks, while leaving live execution itself unimplemented.

**Includes**

- Add `liveRollout` to operator config and schema.
- Validate:
  - live mode can only run when `liveRollout.enabled` is true
  - only allowlisted venues can enter live mode
  - live mode is rejected for non-orderbook venues
  - inconsistent reconciliation config causes startup rejection
- Clamp instance live notional against operator max cap.
- Keep the current live-mode throw in place after gate validation.

**Primary files**

- `config/default.yaml`
- `packages/domain/src/config/schema.ts`
- `apps/worker/src/config.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/config.test.ts`
- `apps/worker/src/trading-actor.test.ts` or `apps/worker/src/runtime.test.ts`

**Do not mix into this PR**

- `LiveExecutor`
- journal event additions
- credential audit plumbing
- API monitoring routes

**Focused validation**

- Config/schema tests for `liveRollout`
- Worker tests proving live startup is rejected for disabled gate, unsupported venue, and unsafe reconciliation settings

**Merge condition**

- Live mode is still unavailable, but it now fails for explicit policy reasons instead of by an unconditional placeholder throw alone.

---

## PR 2: Credential Audit And DB-Only Live Credential Policy

**Suggested title:** `phase-4/pr2-live-credential-audit`

**Goal:** Make live credential handling auditable and remove environment fallback from the live path.

**Includes**

- Emit journal events for credential create, rotate, delete.
- Emit worker-side audit events for credential decrypt and live-order credential use.
- Reject live startup if the venue account has no linked DB credential or decrypt fails.
- Document restart-time reload behavior after credential rotation.

**Primary files**

- `apps/api/src/routes/credentials.ts`
- `apps/worker/src/index.ts`
- `packages/engine/src/journal.ts`
- `packages/db/src/journal-pg.ts`
- credential route and worker tests

**Do not mix into this PR**

- live order submission
- actor executor selection changes
- live monitoring API

**Focused validation**

- API tests for create/rotate/delete audit events without secret leakage
- Worker tests for DB-credential requirement and decrypt failure handling in live mode

**Merge condition**

- Live mode is still not executing orders, but credential provenance and audit are now enforceable and visible.

---

## PR 3: Engine-Level `LiveExecutor`

**Suggested title:** `phase-4/pr3-live-executor`

**Goal:** Add the live executor on the existing engine boundary without wiring it into the worker yet.

**Includes**

- Add `packages/engine/src/live-executor.ts`.
- Use `OrderbookVenuePort` for real order submission.
- Generate deterministic `clientOrderId` / idempotency keys.
- Support market-only live orders for the first rollout.
- Return acknowledged/open orders without synthetic fills.
- Reject unsupported live order types explicitly.

**Primary files**

- `packages/engine/src/live-executor.ts`
- `packages/engine/src/index.ts`
- `packages/engine/src/executor.ts` if the result shape needs clarification
- `packages/engine/src/live-executor.test.ts`

**Do not mix into this PR**

- worker actor lifecycle changes
- API routes
- reconciliation diff classification
- credential audit work

**Focused validation**

- Engine unit tests for submit success, venue rejection, partial submit handling, idempotent order IDs, and no fabricated fills

**Merge condition**

- The engine has a production-ready executor surface for live order submission, but no runtime path uses it yet.

---

## PR 4: Worker Live Wiring And In-Flight Recovery

**Suggested title:** `phase-4/pr4-live-actor-wiring`

**Goal:** Replace the live placeholder in the worker with real executor selection and preserve the no-trading-until-ready contract.

**Includes**

- Select `LiveExecutor` when `execution.mode === 'live'`.
- Preserve startup order:
  - DB rehydration
  - incomplete-plan venue reconciliation
  - first reconciliation pass
  - private stream ready
  - then scan loop
- Prevent overlapping live plans for the same symbol while a prior live plan is unresolved.
- Use private-stream events as the primary live completion signal.
- Pause on stream disconnect and crash on reconnect exhaustion.

**Primary files**

- `apps/worker/src/trading-actor.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/trading-actor.test.ts`
- `apps/worker/src/runtime.test.ts`

**Do not mix into this PR**

- API monitoring surface
- live slippage alerting
- reconciliation taxonomy expansion unless strictly required for runtime correctness

**Focused validation**

- Worker tests for live executor selection
- Startup blocking tests
- Recovery tests for incomplete live plans
- Stream disconnect/reconnect/crash tests

**Merge condition**

- A live-mode actor can run in tests with a fake venue and respects the full startup gate and recovery contract.

---

## PR 5: Live Journal Taxonomy, Slippage Alerts, And Operator Read Surface

**Suggested title:** `phase-4/pr5-live-monitoring`

**Goal:** Make live behavior observable through the existing journal and API without adding a dashboard.

**Includes**

- Add live-path journal events:
  - `instance:live_blocked`
  - `instance:live_armed`
  - `order:submitted_to_venue`
  - `order:acknowledged`
  - `order:fill_confirmed_from_stream`
  - `order:completion_recovered`
  - `live:slippage_alert`
- Compute live slippage from submission-time reference price vs realized fill price.
- Add thin API read surface for:
  - live readiness/state
  - private-stream state
  - open live orders
  - recent fills
  - recent slippage alerts
  - last reconciliation result

**Primary files**

- `packages/engine/src/journal.ts`
- `packages/db/src/journal-pg.ts`
- `packages/db/src/repositories.ts`
- `apps/api/src/routes/views.ts` or a dedicated adjacent route module
- `apps/api/src/schemas.ts`
- `apps/api/src/types.ts`
- API and repository tests

**Do not mix into this PR**

- deeper reconciliation diff classification
- rollout scripts or results notes

**Focused validation**

- Journal tests for new event types
- API tests for live-status queries
- Tests proving slippage alerts are emitted at the configured threshold

**Merge condition**

- Operators can inspect live readiness and recent live-path behavior entirely through API + journal queries.

---

## PR 6: Reconciliation Classification For Real-Money Drift

**Suggested title:** `phase-4/pr6-live-drift-classification`

**Goal:** Make live reconciliation evidence more actionable by classifying real-money drift without hiding raw diffs.

**Includes**

- Extend reconciliation persistence/metadata to distinguish when possible:
  - fee/funding adjustments
  - unexplained balance deltas
  - open-order drift
  - position-size drift
- Preserve raw venue/local snapshots so classification never replaces source evidence.
- Add tests proving unexplained deltas are surfaced loudly instead of silently normalized.

**Primary files**

- reconciliation-related engine and db persistence files already touched by live monitoring
- targeted tests near reconciliation repositories and worker reconciliation coverage

**Do not mix into this PR**

- executor changes
- credential changes
- rollout docs/results

**Focused validation**

- Reconciliation tests for classified vs unexplained deltas
- API or repository tests for querying the richer metadata

**Merge condition**

- Real-money reconciliation output is specific enough to support manual monitoring and incident review.

---

## PR 7: Sandbox Smoke Harness And Rollout Runbook

**Suggested title:** `phase-4/pr7-live-rollout-runbook`

**Goal:** Prepare the repo for the staged live rollout without bundling operational validation into earlier code PRs.

**Includes**

- Add or update docs for:
  - Hyperliquid sandbox smoke flow
  - capped-notional first-production rollout checklist
  - actor restart / recovery verification
  - credential rotation verification
- If needed, add a minimal script or command wrapper for the sandbox smoke path, but only if it exercises the already-merged code without adding new behavior.

**Primary files**

- docs under `docs/features/2026/05/initial/`
- optionally one small script under `scripts/` if it reduces rollout ambiguity

**Do not mix into this PR**

- new runtime logic
- executor semantics
- schema changes unless the script truly requires them

**Focused validation**

- Dry-run the documented sandbox smoke steps
- Confirm the runbook references the actual API/journal surfaces added in earlier PRs

**Merge condition**

- The repository contains an explicit operator path for sandbox smoke and first-capital rollout.

---

## Post-Merge Operational Sequence

These are not implementation PRs. They happen after PR 7 is merged.

1. Run Hyperliquid sandbox smoke with the real live executor code path.
2. Run one capped-notional production instance on a single symbol during a manual monitoring window.
3. Force one actor restart and verify rehydration + incomplete-plan recovery.
4. Rotate the linked credential and verify audit events plus restart-time credential reload.
5. Save rollout evidence in a separate progress/results document next to the Phase 4 plan rather than editing the plan or this PR sequence heavily.

---

## Notes On Combining PRs

Default recommendation: keep all 7 PRs separate.

Only combine if review overhead becomes the bottleneck:

- Safe combination: PR 5 + PR 6
- Avoid combining: PR 3 + PR 4, because engine-level executor behavior and worker lifecycle behavior need different review lenses
- Avoid combining: PR 1 + PR 2, because config gating and credential auditing are separate failure domains