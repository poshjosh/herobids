# Trading Binding Native Bot Startup

## Status
`draft`

## Goal

Make agent-created bots createable from `tradingBindingId` as the authoritative input, while startup resolves any legacy `venueAccountId` data it still needs inside the worker rather than requiring the agent runtime or broker caller to supply it.

This is a binding-first refactor, not a full removal of `venue_accounts` from the platform.

## Non-goals

- Do not remove `bots.venueAccountId` in this pass.
- Do not migrate fills, positions, reconciliation, dashboard aggregation, or credential-dependent APIs away from `venueAccountId` in this pass.
- Do not change user-visible bot creation semantics outside the binding-first input contract.
- Do not attempt a full capability/storage redesign for non-trading families.

## Current State

### Creation path

- API bot creation already accepts `tradingBindingId` as the public input in `apps/api/src/schemas.ts`.
- API route logic resolves `binding.sourceVenueAccountId` and writes both `tradingBindingId` and `venueAccountId` into `bots` in `apps/api/src/routes/bots.ts`.
- Agent broker creation is now binding-first at the selection layer, but still fails loudly when `sourceVenueAccountId` is missing.

### Startup path

- The worker queue contract still injects `venueAccountId` into the lifecycle job config in `apps/worker/src/index.ts`.
- Runtime startup still requires `venueAccountId` in job config and refuses to start without it.
- Credential resolution for orderbook venues and 1inch swap startup still loads the `venue_accounts` row first, then resolves credentials from that row.

### Downstream dependencies that remain venue-account-centric

- `bots.venueAccountId` is still a required foreign key.
- Credential dependent lookup uses `bots.venueAccountId`.
- Reconciliation endpoints fetch by `bot.venueAccountId`.
- Dashboard joins bots back to venue accounts.
- Orders, fills, positions, plans, and decisions still use `venueAccountId` as a first-class identifier.

## Key Design Decision

Treat `tradingBindingId` as the only required external/startup routing identifier for bot creation and lifecycle enqueueing.

Keep `venueAccountId` as a derived legacy field that the worker resolves from the binding when it needs:

- credential lookup
- live gate error context
- analytics/persistence compatibility
- downstream API compatibility

This means the worker becomes responsible for translating:

`tradingBindingId -> trading binding -> sourceVenueAccountId -> venue account -> credentials`

## Constraints And Caveats

### No hard blocker for the narrow goal

There is no architectural blocker to making startup binding-first.

### Important caveats

1. This pass is only safe if bindings that need venue-account-backed startup can still resolve a `sourceVenueAccountId`.
   Orderbook startup and 1inch startup still depend on `venue_accounts` as the current credential anchor.

2. Making startup binding-first does not mean the system is venue-account-free.
   Many downstream reads still rely on `bots.venueAccountId`, so that field should remain populated whenever it can be derived.

3. Bindings with `sourceVenueAccountId = NULL` remain a special case.
   In the current architecture they can only succeed if the worker grows an alternate credential/account resolution path from `trading_bindings` or `connections`. That is explicitly out of scope for this pass.

4. Live-mode gating still uses `venueAccountId` in its input and error surface.
   That is acceptable in this pass as long as the worker derives the value internally before calling the gate.

5. Swap startup still depends on venue-account-specific metadata.
  Jupiter startup currently requires `venue_accounts.venueAccountRef` to resolve the wallet address, and 1inch still resolves secrets through the venue-account credential linkage. This means binding-first startup is safe, but fully removing venue-account dependency from startup would require mirroring that metadata into binding-owned fields or adding a separate resolver path.

## Proposed End State For This Pass

After this work:

- broker/queue callers only need `tradingBindingId` for startup routing
- worker startup can run without `venueAccountId` being embedded in the lifecycle job payload
- worker resolves `venueAccountId` internally from the binding before credential/live-gate work
- `bots.venueAccountId` continues to be stored as a derived legacy field for compatibility
- bindings missing `sourceVenueAccountId` fail with a clear worker/API error rather than a misleading broker input error

## Implementation Plan

### Phase 1: Normalize the startup contract around `tradingBindingId`

#### Changes

- Update the worker-side `BotStartCallback` contract in `apps/worker/src/agents/agent-message-broker.ts` to accept `tradingBindingId` as the required routing identifier.
- Update the queue enqueue path in `apps/worker/src/index.ts` so `start-instance` jobs carry:
  - `botId`
  - `userId`
  - `tradingBindingId`
  - bot config
- Make `venueAccountId` optional in the startup job payload during the transition period.

#### Notes

- The authoritative identifier for startup should be `tradingBindingId`, not a copied legacy account ID.
- If both IDs are present, worker startup should prefer a resolved/validated view from the binding rather than trusting job payload blindly.

### Phase 2: Add a worker-side startup resolution step

#### Changes

- Introduce a worker-local resolution helper, likely in `apps/worker/src/index.ts` or a small extracted module, e.g. `resolveStartupContext(...)`.
- The helper should resolve from `tradingBindingId` to a startup context object containing at minimum:
  - `tradingBindingId`
  - `provider`
  - `connectionId`
  - `sourceVenueAccountId`
  - resolved `venueAccount` row when present
  - resolved credential linkage facts when present
- Resolution should use database reads, not assumptions from queue payload.

#### Expected behavior

- If `tradingBindingId` is missing, startup fails fast with a descriptive error.
- If the binding is missing or revoked, startup fails fast.
- If the binding exists but `sourceVenueAccountId` is missing for a provider path that still requires a venue account, startup fails fast with a clear binding-level error.

#### Rationale

- This moves legacy translation logic into the worker, which is the correct boundary for infrastructure-specific credential resolution.
- It also ensures API-created and agent-created bots converge on the same startup semantics.

### Phase 3: Make runtime startup consume resolved context instead of raw `venueAccountId`

#### Changes

- Replace the current startup precondition in `apps/worker/src/index.ts` that directly reads `rawConfig['venueAccountId']`.
- Startup should first resolve binding context, then derive `venueAccountId` from the resolved binding context where needed.
- Update credential resolution blocks to use the resolved context object rather than a naked queue field.

#### Orderbook startup

- Continue to load DB-backed credentials from the resolved venue account row for now.
- Preserve current paper/live behavior:
  - paper may continue without linked credentials where current logic allows
  - live remains fail-closed

#### Swap startup

- Continue current 1inch credential resolution via the resolved venue account row.
- Do not redesign swap credential anchoring in this pass.

### Phase 4: Preserve and validate the derived legacy field on `bots`

#### Changes

- Keep writing `bots.tradingBindingId` and `bots.venueAccountId` at creation time.
- Treat `venueAccountId` as derived from the binding, not user-supplied routing state.
- Centralize the derivation so API and agent creation use the same rule.

#### Recommended shape

- Add or extract a shared creation helper that takes:
  - `userId`
  - `tradingBindingId`
  - bot config
  - creator metadata
- The helper resolves `sourceVenueAccountId` from the binding and writes both IDs together.

#### Why

- This avoids divergent logic between `POST /bots` and agent-created bot paths.
- It also reduces the chance of mismatched `tradingBindingId` / `venueAccountId` pairs being written to the DB.

### Phase 5: Tighten validation and error messages

#### Changes

- Standardize the error for bindings that cannot supply a legacy venue account where one is still required.
- Replace user-facing or log-facing errors like “venueAccountId is required” with binding-native messages such as:
  - `binding.missing_source_venue_account`
  - `binding.not_ready_for_startup`
  - `binding.not_found`

#### Scope

- API bot creation path
- agent broker create-and-start path
- worker runtime start path

### Phase 6: Add compatibility tests

#### Unit tests

- Worker startup accepts a job carrying `tradingBindingId` without `venueAccountId` and resolves startup context internally.
- Worker startup fails clearly when:
  - binding is missing
  - binding is revoked
  - binding has no `sourceVenueAccountId` but current provider path still needs one
- Agent broker create-and-start selects the runtime descriptor default binding and enqueues startup by `tradingBindingId`.

#### API tests

- `POST /bots` with `tradingBindingId` continues to create a bot and persists both IDs when `sourceVenueAccountId` exists.
- `POST /bots` still returns a clear binding-level error when `sourceVenueAccountId` is missing.

#### Integration tests

- Agent-created bot path: broker -> queue -> worker startup succeeds with `tradingBindingId`-first routing.
- Rehydration path still works for persisted bots whose `venueAccountId` is present.

#### Regression tests

- Existing live-gate tests continue to pass.
- Existing credential-dependent APIs continue to behave unchanged because `bots.venueAccountId` remains populated.

## File-Level Plan

### Primary files to change

- `apps/worker/src/agents/agent-message-broker.ts`
  - change startup callback contract to be binding-first
  - pass `tradingBindingId` when enqueueing start

- `apps/worker/src/index.ts`
  - change lifecycle queue payload shape
  - add startup resolution helper
  - replace raw queue `venueAccountId` dependency with resolved startup context

- `apps/api/src/routes/bots.ts`
  - optionally extract binding-to-legacy-account derivation into a shared helper
  - preserve current DB behavior while unifying error semantics

- `packages/db/src/repositories.ts`
  - if needed, add a small query helper for binding/startup resolution
  - avoid spreading binding/venue-account derivation logic across multiple call sites

- `apps/api/src/routes/bots.test.ts`
  - keep API behavior covered

- `apps/worker/src/live-gate.test.ts`
  - adjust if the test harness needs startup context changes

- new worker tests near startup/broker code
  - add missing coverage for binding-first startup

### Secondary files to inspect but not necessarily change

- `apps/api/src/credential-dependents.ts`
- `apps/api/src/routes/reconciliation.ts`
- `apps/api/src/routes/dashboard.ts`
- `packages/domain/src/runtime-composition.ts`

These are downstream consumers of `venueAccountId`, but they should remain compatible in this pass.

## Acceptance Criteria

- [ ] Agent-created bot creation is routed by `tradingBindingId`, not by a caller-supplied `venueAccountId`.
- [ ] Lifecycle queue/startup can start a bot when the job contains `tradingBindingId` and omits `venueAccountId`.
- [ ] Worker startup resolves legacy `venueAccountId` internally before credential and live-gate logic.
- [ ] `bots.venueAccountId` remains populated as a derived field when the binding exposes `sourceVenueAccountId`.
- [ ] Bindings missing `sourceVenueAccountId` fail with a clear binding-level error instead of a misleading input error.
- [ ] `pnpm lint` passes.
- [ ] Focused worker/API tests cover the binding-first startup path.

## Risks

1. Hidden assumptions in worker startup may still treat `venueAccountId` as mandatory outside the visible credential/live-gate path.

2. Queue payload compatibility may affect rehydration or any out-of-band producers of lifecycle jobs.

3. If binding resolution logic is duplicated between API and worker, drift can reappear quickly.

4. A future provider that does not naturally map to `venue_accounts` will still require a broader follow-up migration.

## Rollout Strategy

1. Land binding-first startup contract and worker resolution behind backward-compatible payload parsing.
2. Keep reading `venueAccountId` from job payload temporarily for older jobs, but do not require it.
3. Switch broker/API enqueue paths to always send `tradingBindingId`.
4. Once tests are stable, remove any remaining “caller must supply venueAccountId” assumptions from agent-created bot flows.

## Explicit Out-Of-Scope Follow-Up

If the long-term goal becomes “remove `venue_accounts` from the core execution identity entirely”, that should be tracked as a separate feature. That follow-up would include:

- nullable or retired `bots.venueAccountId`
- binding-native reconciliation and dashboard aggregation
- credential resolution anchored directly on `connections`/bindings instead of venue accounts
- domain model migration away from `VenueAccountId` in orders/fills/positions/decisions

That is a larger cross-cutting migration and should not be folded into this implementation pass.