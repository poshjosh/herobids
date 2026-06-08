# Trading Binding Native Bot Startup

## Status
`draft`

## Purpose

Turn the implementation plan into an execution-ready task list with strict sequencing, file-level edits, and validation order.

This task list is scoped to the narrow goal:

- agent-created bots are routed by `tradingBindingId`
- startup accepts `tradingBindingId`
- worker resolves legacy `venueAccountId` internally when needed
- `bots.venueAccountId` remains a derived compatibility field

## Execution Strategy

Use small, validating slices.

Order of work:

1. change the startup contract
2. add worker-side binding resolution
3. switch startup and credential resolution to resolved context
4. unify create-time derivation of `venueAccountId`
5. tighten errors
6. add tests and run repo validation

Do not start by changing schema or downstream analytics/reconciliation consumers.

## Task List

### Slice 1: Make startup contract binding-first

#### Goal

Queue/startup should accept `tradingBindingId` as the primary routing input.

#### Files

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/agents/index.ts` if it re-exports the callback type

#### Tasks

- [ ] Change `BotStartCallback` signature from `(botId, userId, venueAccountId, config)` to `(botId, userId, tradingBindingId, config)`.
- [ ] Update the broker call site to pass `binding.bindingId` instead of `sourceVenueAccountId`.
- [ ] Update `botStartCallback` in the worker entrypoint to enqueue lifecycle jobs with:
  - `botId`
  - `userId`
  - `tradingBindingId`
  - config
- [ ] Keep backward-compatible parsing in the runtime for now: if older jobs still include `venueAccountId`, do not break them.

#### Validation

- [ ] Run focused typecheck for touched files if available, otherwise `pnpm lint`.

#### Expected result

The queue payload no longer depends on broker callers supplying a `venueAccountId`.

### Slice 2: Add a worker startup context resolver

#### Goal

Worker startup should translate `tradingBindingId` into the legacy data it still needs.

#### Files

- `apps/worker/src/index.ts`
- optionally extract to a helper file under `apps/worker/src/` if the entrypoint becomes too large
- `packages/db/src/repositories.ts` only if a small shared query helper meaningfully reduces duplication

#### Tasks

- [ ] Introduce a startup resolution helper, for example `resolveStartupContext(db, tradingBindingId)`.
- [ ] The resolver should fetch at minimum:
  - binding row
  - connection state
  - provider
  - `sourceVenueAccountId`
  - resolved `venueAccounts` row when present
  - credential linkage facts needed by current startup code
- [ ] Make the resolver fail fast with explicit binding-native errors when:
  - binding is missing
  - binding is revoked
  - connection is revoked
  - provider path still requires a source venue account and it is missing

#### Validation

- [ ] Add or update a narrow test around the resolver if it is extracted.
- [ ] Run `pnpm lint` after the resolver compiles.

#### Expected result

Startup has one authoritative place to translate `tradingBindingId` into runtime context.

### Slice 3: Replace raw job `venueAccountId` dependency in runtime startup

#### Goal

Runtime startup should consume resolved context, not trust raw queue fields.

#### Files

- `apps/worker/src/index.ts`
- `apps/worker/src/live-gate.ts` only if the input shape or naming needs a small adjustment

#### Tasks

- [ ] Replace the current startup precondition that reads `rawConfig['venueAccountId']` directly.
- [ ] Read `tradingBindingId` from job config first.
- [ ] Call the startup context resolver before credential loading.
- [ ] Derive `venueAccountId` from the resolved context for the existing credential path.
- [ ] Preserve current live/paper behavior.
- [ ] Preserve current adapter wiring and mark-source behavior.

#### Orderbook-specific tasks

- [ ] Continue to load DB credentials from the resolved venue account row.
- [ ] Preserve current paper fallback when no credential is linked and paper mode allows it.

#### Swap-specific tasks

- [ ] Keep 1inch credential lookup via resolved venue account row.
- [ ] Keep Jupiter wallet address lookup via resolved `venueAccountRef`.
- [ ] Do not redesign swap metadata storage in this pass.

#### Validation

- [ ] Run worker-focused tests if available.
- [ ] Run `pnpm lint`.

#### Expected result

Startup can proceed from `tradingBindingId` alone, provided the binding still resolves to the legacy venue-account data current provider startup requires.

### Slice 4: Centralize creation-time derivation of legacy `venueAccountId`

#### Goal

API and agent-created bot flows should derive and persist legacy `venueAccountId` consistently from the binding.

#### Files

- `apps/api/src/routes/bots.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `packages/db/src/repositories.ts`
- optional small shared helper in `packages/db/src/` or `apps/api/src/` if it avoids drift cleanly

#### Tasks

- [ ] Identify the smallest shared place to derive `sourceVenueAccountId` from `tradingBindingId`.
- [ ] Use that same derivation rule in both:
  - API bot creation
  - agent broker create-and-start path
- [ ] Keep `BotRepository.createBot()` explicit: it should receive both `tradingBindingId` and the derived `venueAccountId`.
- [ ] Do not reintroduce fake fallbacks such as `bindingId` pretending to be a venue account ID.

#### Validation

- [ ] Re-run API bot route tests.
- [ ] Re-run any broker tests added in this feature.

#### Expected result

All bot creation paths write a valid and consistent `(tradingBindingId, venueAccountId)` pair.

### Slice 5: Standardize binding-native error surfaces

#### Goal

Errors should describe binding readiness/translation failure, not missing caller input.

#### Files

- `apps/api/src/routes/bots.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/index.ts`
- tests that assert error codes/messages

#### Tasks

- [ ] Replace misleading errors such as `venueAccountId is required`.
- [ ] Standardize on binding-centric failures, for example:
  - `binding.not_found`
  - `binding.not_ready_for_startup`
  - `binding.missing_source_venue_account`
- [ ] Keep log messages explicit about whether failure occurred in:
  - broker selection
  - startup resolution
  - credential resolution

#### Validation

- [ ] Update assertions in route and worker tests.
- [ ] Run `pnpm lint`.

#### Expected result

Operators and tests can distinguish caller-input errors from binding-resolution failures.

### Slice 6: Add focused tests in dependency order

#### Goal

Cover the new startup contract and protect the legacy compatibility boundary.

#### Test order

1. resolver/unit tests
2. broker tests
3. worker startup tests
4. API route tests
5. integration/regression checks

#### Files to add or update

- `apps/api/src/routes/bots.test.ts`
- worker tests near startup and broker code
- `apps/worker/src/live-gate.test.ts` only if startup context changes require it

#### Required scenarios

- [ ] Agent broker selects runtime descriptor default trading binding.
- [ ] Broker enqueues startup by `tradingBindingId`.
- [ ] Worker startup accepts job payload with `tradingBindingId` and no `venueAccountId`.
- [ ] Worker startup resolves binding -> source venue account internally.
- [ ] Worker startup fails clearly when binding is missing.
- [ ] Worker startup fails clearly when binding is revoked or not ready.
- [ ] Worker startup fails clearly when `sourceVenueAccountId` is required but missing.
- [ ] API create bot still persists both IDs when binding has a source venue account.
- [ ] Existing compatibility behavior for downstream `bots.venueAccountId` consumers remains intact.

#### Validation

- [ ] Run the narrow test files after each slice, not only at the end.
- [ ] Finish with `pnpm lint`.
- [ ] Run targeted `pnpm test` scopes for the touched worker and API tests.

## File-By-File Edit Order

Use this order to reduce churn and keep each validation step narrow.

1. `apps/worker/src/agents/agent-message-broker.ts`
2. `apps/worker/src/index.ts`
3. optional startup resolver helper file if extracted
4. `packages/db/src/repositories.ts`
5. `apps/api/src/routes/bots.ts`
6. worker tests
7. API tests
8. final repo validation

## Validation Sequence

### After Slice 1

- [ ] Typecheck touched files or run `pnpm lint`

### After Slice 2

- [ ] Resolver-specific tests
- [ ] `pnpm lint`

### After Slice 3

- [ ] Worker startup tests
- [ ] `pnpm lint`

### After Slice 4

- [ ] API route tests
- [ ] Broker tests
- [ ] `pnpm lint`

### After Slice 5

- [ ] Re-run updated tests with error assertions
- [ ] `pnpm lint`

### Final validation

- [ ] `pnpm lint`
- [ ] targeted `pnpm test` for touched worker and API files
- [ ] optional broader `pnpm test` if the touched area fans out more than expected

## Acceptance Checklist

- [ ] Queue/startup is `tradingBindingId`-first.
- [ ] Worker resolves `venueAccountId` internally when current provider startup still needs it.
- [ ] Agent-created bots no longer require the broker caller to supply `venueAccountId`.
- [ ] `bots.venueAccountId` remains valid and derived.
- [ ] No fake `venueAccountId` fallbacks are written to the database.
- [ ] Binding-missing / binding-not-ready / binding-missing-source-account errors are explicit.
- [ ] Worker and API tests cover the new contract.
- [ ] `pnpm lint` passes.

## Known Caveats To Preserve During Implementation

- Jupiter swap startup still depends on `venue_accounts.venueAccountRef`.
- 1inch startup still depends on venue-account-backed credential resolution.
- Reconciliation, dashboard, credential-dependent lookup, and analytics remain `venueAccountId`-centric and should not be migrated in this pass.

## Suggested Deliverable Split

If this is implemented across multiple commits or PRs, split it like this:

1. Startup contract + worker resolver skeleton
2. Runtime startup migration to resolved binding context
3. Creation-path unification + error cleanup
4. Tests and final compatibility pass