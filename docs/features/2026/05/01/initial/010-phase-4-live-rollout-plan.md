# Phase 4: Live Rollout

**Goal:** Enable one orderbook trading instance to place real orders safely on Hyperliquid with fail-closed startup gates, auditable credential use, and operator-visible reconciliation/slippage evidence.

**Parent:** [003-design-decisions.md](003-design-decisions.md) Section 3.5, Section 13, Section 14, Section 18, and Section 20

**Depends on:** [009-phase-3-plan.md](009-phase-3-plan.md) exit criteria and the current Phase 2/3 worker runtime, reconciliation, private-stream, and backtesting infrastructure

**Latest rollout status:** [015-phase-4-live-rollout-status-2026-05-30.md](015-phase-4-live-rollout-status-2026-05-30.md)

**Scope note:** This phase covers bot-driven live execution on one orderbook venue. Swap live execution, multi-venue live routing, manual-user execution, and any frontend/dashboard remain deferred. The first live strategy should be whichever strategy has the strongest replay + shadow evidence; this plan does not assume LLM goes live before the existing mechanical baseline proves the path.

**Phase-gating note:** Phase 4 may proceed on the mechanical live path while the LLM-specific Phase 3 follow-ups in [009b-not-addressed.md](009b-not-addressed.md) remain open. This plan is not approval to promote `strategy.type: llm` to live; LLM live consideration still requires those follow-ups to close in addition to the replay/shadow evidence already required by Phase 3.

---

## Current Repo Anchors (2026-05-26)

These are the concrete seams the implementation must build on.

- `apps/worker/src/trading-actor.ts`
  - `executionMode` already allows `'live'` in types, but constructor-time executor selection still throws `Live execution mode is not yet implemented. Use paper or shadow mode.`
  - startup already blocks on the first reconciliation pass and private-stream readiness for shadow/live paths.
  - incomplete execution-plan recovery already queries venue state in shadow/live mode.
- `packages/engine/src/executor.ts`
  - the executor boundary already exists as `execute(plan, currentPrice)`.
  - `PaperExecutor` and `ShadowExecutor` prove the engine expects a drop-in executor, not a second runtime path.
- `packages/venues/src/hyperliquid.ts`
  - order submission, cancel, positions, balances, open orders, recent fills, and private stream support already exist.
  - this is the only venue adapter sufficiently complete for the first live rollout.
- `apps/worker/src/index.ts`
  - worker startup already resolves DB-backed credentials for orderbook venues, but still falls back to environment variables.
  - live rollout should tighten this boundary instead of inventing a parallel credential path.
- `apps/api/src/routes/credentials.ts`
  - credential create/list/get/rotate/delete already exists with AES-256-GCM encryption at rest.
  - audit/journal coverage for decrypt/use/rotate is still missing.
- `config/default.yaml`
  - reconciliation thresholds and stream reconnect config already exist.
  - live rollout needs explicit operator gating rather than piggybacking on generic execution settings.

---

## Resolved Implementation Decisions (2026-05-26)

1. **First live venue is Hyperliquid only.**
   - Phase 4 validates one real orderbook path before any swap live execution or cross-venue live routing.

2. **Live execution is a new engine executor, not a new actor/runtime stack.**
   - Reuse the current `TradingActor`, `runTradingCycle()`, plan repository, order repository, and reconciliation path.

3. **Initial live order types are market-only / taker execution.**
   - Queue-position modeling remains deferred, so Phase 4 should not introduce resting live limit-order logic as the default live path.

4. **Live mode is fail-closed and DB-credential-backed.**
   - No environment-variable credential fallback in live mode. A linked `venue_accounts.credential_id` record is required.

5. **Live readiness is enforced at startup, not left to operator memory.**
   - Reconciliation must block on startup drift beyond threshold, private stream must be connected, and live mode must be explicitly enabled in operator config.

6. **Credential audit reuses the existing journal/event system.**
   - Do not add a second audit store for Phase 4. Journal the metadata needed to prove decrypt/use/rotate behavior end-to-end.

7. **Manual monitoring uses API + journal read models, not a new dashboard.**
   - Any new operator surface should stay thin and query-oriented.

8. **Phase 4 engineering exit is safe monitored operation, not profitability proof.**
   - Market profitability is strategy-dependent. The implementation target is safe real-order execution with observable slippage, fee, and drift behavior.

---

## Concrete Execution Plan

### 1. Add explicit live-mode policy and fail-closed gating

**Files to add/modify**

- `config/default.yaml`
- `packages/domain/src/config/schema.ts`
- `apps/worker/src/config.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/config.test.ts`
- `apps/worker/src/runtime.test.ts` or `apps/worker/src/trading-actor.test.ts`

**Change**

- Add an operator-owned `liveRollout` config section with the minimum controls needed for safe first-capital rollout:
  - `enabled`
  - `allowedVenues`
  - `requireDbCredentials`
  - `maxInitialOrderNotional`
  - `maxConsecutiveVenueErrors`
  - `slippageAlertBps`
- Reject live instance startup when any of the following is true:
  - `liveRollout.enabled === false`
  - `execution.mode === 'live'` for a non-allowlisted venue
  - live mode would fall back to environment credentials instead of a DB-linked credential
  - venue type is not `orderbook`
- Clamp instance-level `risk.maxOrderNotional` against the operator-level `liveRollout.maxInitialOrderNotional` cap so the first rollout cannot exceed the operator's allowed blast radius.
- Require fail-closed reconciliation semantics in live mode:
  - `driftAlertOnly` must not allow live startup through unresolved drift.
  - If operator config is inconsistent with live safety requirements, reject startup rather than silently overriding behavior.

**Dependencies**

- None. This is the first step because it defines the guardrails the rest of the implementation must obey.

**Risk / open question**

- Whether live-mode safety should override a permissive reconciliation config or reject the config outright.
- Preferred behavior: reject inconsistent config so the operator sees the live-safety mismatch explicitly.

**Focused validation**

- Config tests proving `liveRollout` defaults/validation behave as expected.
- Worker/actor tests proving live startup is rejected when the live gate is disabled, the venue is unsupported, or credentials would come from env fallback.

### 2. Implement `LiveExecutor` on the existing executor boundary

**Files to add/modify**

- Add `packages/engine/src/live-executor.ts`
- Modify `packages/engine/src/index.ts`
- Add `packages/engine/src/live-executor.test.ts`
- Modify `packages/engine/src/executor.ts` only if the current `ExecutionResult` shape needs an acknowledged-but-unfilled representation clarified

**Change**

- Implement `LiveExecutor` against the existing `Executor` interface using `OrderbookVenuePort`.
- Generate deterministic client order IDs / idempotency keys so restarts and retries can correlate venue state back to local plans.
- Submit planned market orders to the venue and map acknowledgements into `ManagedOrder` rows with real `venueRefId` values.
- Do **not** fabricate fills in live mode. A live execution result may contain acknowledged/open orders and zero fills; fills arrive asynchronously from the private stream or reconciliation.
- Return precise accepted/rejected order surfaces in the result so partial-submit scenarios are observable and journaled rather than hidden behind a blanket failure.
- Reject or explicitly fail unsupported planned order types in the first live rollout path instead of letting them fall through to unsafe default behavior.

**Dependencies**

- Depends on Step 1 because live-mode policy determines which plans are allowed to reach the real venue.

**Risk / open question**

- Whether to allow live limit orders in the first rollout.
- Preferred behavior: market-only for Phase 4, because queue-position simulation and maker fill assumptions remain explicitly deferred.

**Focused validation**

- Engine unit tests covering successful submit, venue rejection, partial submit, and idempotent client-order-ID correlation.
- Tests proving live execution returns no synthetic fills and leaves fill confirmation to stream/reconciliation paths.

### 3. Wire live execution into actor lifecycle and in-flight recovery

**Files to add/modify**

- `apps/worker/src/trading-actor.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/trading-actor.test.ts`
- `apps/worker/src/runtime.test.ts`

**Change**

- Replace the current live-mode throw with `LiveExecutor` selection.
- Preserve the existing startup sequence in live mode:
  - rehydrate local state
  - reconcile incomplete plans against the venue
  - run the first reconciliation pass
  - open the private stream
  - only then arm the scan loop
- Promote private-stream order/fill updates from "nice to have persistence" to the primary completion signal for live orders.
- Keep reconciliation as the recovery/backstop path when stream events are delayed or missed.
- Prevent a new live decision from creating overlapping real orders for the same symbol while an earlier live plan is still unresolved.
- On private-stream disconnect:
  - pause the scan loop immediately
  - attempt reconnect under the existing reconnect policy
  - if reconnect ultimately fails, crash the actor and let lease reassignment + startup reconciliation recover it

**Dependencies**

- Depends on Step 2.

**Risk / open question**

- Whether existing order/fill persistence is sufficient to correlate private-stream events to execution plans without additional metadata.
- Preferred behavior: use deterministic `clientOrderId` plus `venueRefId` as the primary correlation path; do not rely on symbol/time heuristics.

**Focused validation**

- Worker tests proving live mode now selects the live executor and keeps the no-trading-until-ready invariant.
- Recovery tests proving incomplete live plans are reconciled against venue orders/fills instead of being marked failed blindly.
- Stream-state tests proving disconnect pauses the actor and max reconnect failure crashes it.

### 4. Extend live observability, drift classification, and thin operator monitoring

**Files to add/modify**

- `packages/engine/src/journal.ts`
- `packages/db/src/journal-pg.ts`
- `packages/db/src/repositories.ts`
- `apps/api/src/routes/views.ts` or a new adjacent live-status route module
- `apps/api/src/schemas.ts`
- `apps/api/src/types.ts`
- Tests under `apps/api/src/routes/` and any affected repository tests

**Change**

- Add explicit live-path event taxonomy to the journal, including at minimum:
  - `instance:live_blocked`
  - `instance:live_armed`
  - `order:submitted_to_venue`
  - `order:acknowledged`
  - `order:fill_confirmed_from_stream`
  - `order:completion_recovered`
  - `live:slippage_alert`
- Compute live slippage by comparing the submission-time reference price against the actual average fill price.
- Extend reconciliation-side metadata or classification so real-money diffs can distinguish, when possible:
  - fee/funding adjustments
  - unexplained balance deltas
  - open-order drift
  - position-size drift
- Add a thin operator monitoring surface, queryable through the API, that summarizes:
  - current execution mode
  - last reconciliation result and timestamp
  - private-stream state
  - open live orders
  - recent fills
  - recent slippage alerts
  - last heartbeat / crash state

**Dependencies**

- Depends on Steps 2 and 3 because live monitoring must reflect real live-order behavior, not placeholders.

**Risk / open question**

- Some venue-side balance changes may not be perfectly classifiable from the available APIs.
- Preferred behavior: persist raw diff data and emit a loud `unexplained_balance_delta`-style signal rather than smoothing it over.

**Focused validation**

- API tests proving live-status/readiness queries surface the expected fields.
- Repository or reconciliation tests proving live-only diff metadata is persisted and queryable.
- Journal tests proving live event taxonomy stays append-only and compatible with existing query paths.

### 5. Audit credential lifecycle and rotation in the live path

**Files to add/modify**

- `apps/api/src/routes/credentials.ts`
- `apps/worker/src/index.ts`
- `packages/engine/src/journal.ts`
- `packages/db/src/journal-pg.ts`
- Credential-route and worker tests

**Change**

- Emit journal events for credential create, rotate, delete, decrypt, and live-order use.
- Record metadata only: credential ID, venue, user/account reference, actor/process, timestamp, and outcome. Never persist decrypted secrets.
- Thread journal/audit hooks into worker credential resolution so decrypt/use is observable in the same durable audit stream as trading events.
- Make credential-rotation behavior explicit:
  - rotated credentials do not hot-swap silently into an already running live actor
  - restarting the actor reloads the new credential
  - missing or undecryptable credentials block live startup

**Dependencies**

- Depends on Steps 1 and 3, because live-mode credential policy and actor startup behavior must be settled first.

**Risk / open question**

- Whether credential-use audit should be emitted once per actor credential load or once per live order submit.
- Preferred behavior: one `credential:decrypted` event on load plus a lightweight `credential:used` event per live order submission.

**Focused validation**

- API tests proving rotate/delete operations emit audit events without leaking secrets.
- Worker tests proving live credential decrypt/use is journaled and that startup fails cleanly when decrypt fails.

### 6. Execute staged rollout and verify safe real-money behavior

**Files to add/modify**

- `docs/features/2026/05/01/initial/010-phase-4-live-rollout-plan.md` remains the implementation plan
- Add a short follow-up progress or results document after execution, rather than widening this plan file with post-hoc notes

**Change**

- Validate the completed implementation in stages:
  - **Stage A:** Hyperliquid sandbox smoke using the live executor code path against non-production credentials
  - **Stage B:** one production live instance, one symbol, capped notional, manual monitoring window
  - **Stage C:** observe at least one normal fill, one actor restart/recovery path, and one credential rotation cycle before broadening scope
- Use the journal + API monitoring surfaces from Steps 4 and 5 as the source of truth for rollout evidence.
- Treat unexplained balance drift, repeated stream failures, or repeated venue errors as rollout blockers, not incidents to ignore for the sake of momentum.

**Dependencies**

- Depends on Steps 1 through 5.

**Risk / open question**

- Profitability cannot be validated by implementation alone; market conditions may be flat or adverse during the rollout window.
- Preferred engineering exit: safe bounded real-order operation with clear reconciliation and credential-audit evidence.

**Focused validation**

- Explicit non-CI live validation runs described below.

---

## Test Strategy

### Unit tests

- `packages/engine/src/live-executor.test.ts`
  - successful submit
  - venue rejection
  - partial-submit behavior
  - no synthetic fill generation in live mode
  - unsupported live order-type rejection
- `apps/worker/src/trading-actor.test.ts`
  - live startup blocked when live gate is disabled
  - live startup blocked when env fallback credentials would be used
  - live startup blocked when reconciliation/stream readiness requirements are not met
  - live stream disconnect pauses the actor and reconnect failure crashes it
- credential/audit tests
  - create/rotate/delete events are journaled without secret leakage
  - decrypt/use events are emitted on the worker path
- reconciliation/journal tests
  - live slippage metadata persists correctly
  - unexplained balance deltas are surfaced, not hidden

### Integration-style tests

- worker/runtime tests proving `execution.mode: 'live'` now selects `LiveExecutor` and preserves the existing no-trading-until-ready invariant
- Hyperliquid-adapter integration coverage against sandbox credentials for real submit/fetch/cancel round-trips
- API route tests for any new live-status or live-readiness query surface

### Explicit validation runs (non-CI)

- Run one sandbox end-to-end live-path smoke test against Hyperliquid testnet/demo credentials.
- Run one capped-notional production live test on a single symbol with manual monitoring.
- Force at least one actor restart during the rollout window and verify startup reconciliation + incomplete-plan recovery behave correctly.
- Rotate the linked credential during the rollout window and verify audit events plus restart-time reload behavior.

### Required repo-level validation before Phase 4 is considered complete

- `pnpm test`
- `pnpm lint`

---

## Configuration Additions

### Operator config (`config/default.yaml` + `packages/domain/src/config/schema.ts`)

Add a dedicated live-rollout section instead of overloading generic execution config:

```yaml
liveRollout:
  enabled: false
  allowedVenues:
    - hyperliquid
  requireDbCredentials: true
  maxInitialOrderNotional: "50"
  maxConsecutiveVenueErrors: 3
  slippageAlertBps: 50
```

```typescript
export const LiveRolloutConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedVenues: z.array(z.enum(['hyperliquid'])).default(['hyperliquid']),
  requireDbCredentials: z.boolean().default(true),
  maxInitialOrderNotional: z.string().default('50'),
  maxConsecutiveVenueErrors: z.number().int().min(1).default(3),
  slippageAlertBps: z.number().min(0).default(50),
});
```

### Instance config (`trading_instances.config`)

No new live-only instance blob is required for the first rollout.

- `execution.mode: live` remains the runtime switch.
- Strategy-specific params remain under `strategy.params`.
- Instance-level risk caps remain under `risk`, but live runtime clamps them against operator-level `liveRollout` safety caps.

---

## Exit Criteria (Phase 4)

- [ ] `LiveExecutor` exists and submits real Hyperliquid orders without fabricating fills.
- [ ] `TradingActor` can start in live mode only when operator live gating, reconciliation, and private-stream readiness all pass.
- [ ] Live mode rejects environment-variable credential fallback and requires a linked DB credential record.
- [ ] Private-stream or reconciliation events complete live order/fill persistence end-to-end.
- [ ] Operator can query current live readiness/state/recent live events through the API and journal.
- [ ] Credential decrypt/use/rotate actions are journaled and verifiable end-to-end.
- [ ] One capped-notional live instance completes monitored real orders on Hyperliquid with slippage and reconciliation evidence persisted.
- [ ] Real-world live deltas surface as explicit evidence in reconciliation/journal paths rather than silent state mutation.
- [ ] All existing tests pass (`pnpm test`) and type-check passes (`pnpm lint`).

---

## Backlog (deferred beyond core Phase 4 scope)

- [ ] Swap live execution (Jupiter or other swap venue)
- [ ] Live maker/limit-order support with venue-specific queue assumptions
- [ ] Automated capital scaling after the first bounded rollout
- [ ] Richer fee/funding attribution for venues that expose dedicated funding history endpoints
- [ ] Frontend/dashboard and WebSocket push for operator monitoring
- [ ] Multi-venue live routing and portfolio-level capital allocation across accounts