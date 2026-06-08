# 025 — Trading Binding Native Bot Startup Follow-Through

Extract the unfinished work from `docs/features/2026/06/08/trading-binding-native-bot-startup/` into a pending execution plan that matches the codebase as it exists today.

## Status

`draft`

## Purpose

Finish the binding-first startup migration without redoing the parts that are already landed.

This plan is intentionally narrower than the original feature doc. It only covers the remaining work required to make bot startup and restart truly `tradingBindingId`-first inside the worker runtime.

## Already Implemented

These pieces are already in place and should not be reworked unless needed for a small consistency cleanup:

1. API bot creation already accepts `tradingBindingId` as the public input in `apps/api/src/schemas.ts`.
2. API bot creation already resolves `tradingBindings.sourceVenueAccountId` and persists both `bots.tradingBindingId` and `bots.venueAccountId` in `apps/api/src/routes/bots.ts`.
3. API bot creation already fails clearly when the binding cannot provide a source venue account, using `binding.missing_venue_account`.
4. Agent broker bot creation already selects a trading binding and persists both `tradingBindingId` and `venueAccountId` through `BotRepository.createBot()`.
5. Trading readiness and runtime descriptor composition already use `trading_bindings` / `capability_grants` rather than direct venue-account selection.

## Remaining Gaps In Current Code

The remaining work is concentrated in the worker startup path.

### 1. Broker callback contract is still venue-account-first

In `apps/worker/src/agents/agent-message-broker.ts`:

- `BotStartCallback` still requires `(botId, userId, venueAccountId, config)`.
- `BotRestartCallback` still requires `(botId, userId, venueAccountId, config)`.
- The create-and-start path still calls `botStart(..., binding.sourceVenueAccountId, ...)`.
- The explicit start path still calls `botStart(..., bot.venueAccountId, ...)`.

This means startup routing still depends on a caller-supplied legacy account identifier.

### 2. Worker queue payload is still venue-account-first

In `apps/worker/src/index.ts`:

- `botStartCallback` enqueues `start-instance` with `config: { ...config, venueAccountId, userId }`.
- `botRestartCallback` enqueues `restart-instance` with `config: { ...config, venueAccountId, userId }`.

The queue contract still treats `venueAccountId` as authoritative.

### 3. Runtime startup still refuses to run without `venueAccountId`

The runtime start callback in `apps/worker/src/index.ts` still does this:

- reads `rawConfig['venueAccountId']`
- throws `Bot <id> has no venueAccountId in job config — refusing to start`

That is the core unfinished migration point.

### 4. Credential resolution and live-gate still bind directly to raw job config

Startup still performs these operations from the raw job `venueAccountId`:

- venue-account lookup for orderbook credential resolution
- venue-account lookup for 1inch credential resolution
- venue-account lookup for Jupiter wallet address resolution
- live-gate input assembly
- market-data recording metadata

All of these should consume a worker-resolved startup context instead of trusting queue payload.

### 5. Restart and rehydration paths still leak legacy assumptions

The remaining entrypoints are inconsistent:

1. `apps/api/src/routes/bots.ts` restart enqueue includes both `tradingBindingId` and `venueAccountId`.
2. `apps/api/src/routes/credentials.ts` restart enqueue includes only `botId`.
3. Worker persisted rehydration still restores running instances with `config: { ...row.config, venueAccountId: row.venueAccountId, userId: row.userId }` and does not include `tradingBindingId`.

The worker needs one canonical way to recover startup context regardless of which producer emitted the job.

### 6. Error surfaces are still mixed

Current behavior mixes:

- API error code `binding.missing_venue_account`
- broker-thrown generic `Error` strings
- runtime startup error `Bot <id> has no venueAccountId in job config`

This makes the failure mode look like caller-input failure instead of binding-resolution failure.

## Scope

Finish the worker-side migration so that:

1. start/restart routing is keyed by `tradingBindingId`
2. worker startup derives legacy `venueAccountId` internally
3. restart and rehydration follow the same resolution path
4. errors become binding-native instead of legacy-input-native

## Non-Goals

1. Do not remove `bots.venueAccountId`.
2. Do not migrate fills, positions, orders, decisions, reconciliation, or dashboard aggregation away from `venueAccountId`.
3. Do not redesign credential ownership away from `venue_accounts`.
4. Do not redesign Jupiter or 1inch metadata storage in this pass.
5. Do not reopen the API create path beyond small consistency extraction if it clearly reduces drift.

## Proposed End State

After this follow-through work:

1. `BotStartCallback` and `BotRestartCallback` are `tradingBindingId`-first.
2. Queue producers emit `tradingBindingId` whenever they know it.
3. Worker startup can start from:
   - job `tradingBindingId`
   - persisted bot row `tradingBindingId`
   - transitional legacy payloads while compatibility remains enabled
4. Worker resolves `venueAccountId` internally before credential and live-gate logic.
5. Restart and rehydration share the same startup-context resolution path.
6. Binding failures are reported as binding-level startup failures, not as missing queue fields.

## Implementation Plan

### Slice 1 — Change broker and worker callback contracts to binding-first

#### Goal

Make the enqueue boundary use `tradingBindingId` as the authoritative routing key.

#### Files

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/index.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/agents/agent-broker.test.ts`

#### Tasks

1. Change `BotStartCallback` from:

```ts
(botId: string, userId: string, venueAccountId: string, config: Record<string, unknown>) => Promise<void>
```

to:

```ts
(botId: string, userId: string, tradingBindingId: string, config: Record<string, unknown>) => Promise<void>
```

2. Change `BotRestartCallback` the same way.
3. Update broker create-and-start to pass `binding.bindingId` into `botStart()`.
4. Update broker explicit start to pass `bot.tradingBindingId` into `botStart()`.
5. Update `botStartCallback` in `apps/worker/src/index.ts` to enqueue:

```ts
{
  command: 'start',
  botId,
  config: { ...config, tradingBindingId, userId }
}
```

6. Update `botRestartCallback` similarly.
7. Preserve backward compatibility for older jobs that still carry `venueAccountId` during the transition.

#### Validation

1. Update broker tests so the expected callback argument is `bindingId`, not `venueAccountId`.
2. Run the focused broker test file.
3. Run `pnpm lint`.

#### Expected Result

Queue producers stop requiring a caller-supplied `venueAccountId` for routing.

---

### Slice 2 — Add a worker startup-context resolver

#### Goal

Move all binding-to-legacy translation into one worker-local helper.

#### Files

- `apps/worker/src/index.ts` or a new helper file such as `apps/worker/src/startup-context.ts`
- `packages/db/src/repositories.ts` only if a small shared query helper genuinely reduces duplication

#### Required resolver output

The resolver should return a typed object containing at least:

```ts
{
  tradingBindingId: string
  provider: string
  connectionId: string
  sourceVenueAccountId: string | null
  venueAccount: VenueAccountRow | null
  botId: string
  userId?: string
}
```

#### Resolution order

The resolver should use the safest available source in this order:

1. `rawConfig.tradingBindingId`
2. persisted `bots.tradingBindingId` loaded by `botId`
3. transitional fallback only when necessary for older jobs

Do not trust a naked queue `venueAccountId` when a binding can be resolved.

#### Tasks

1. Load the bot row by `botId` when needed to fill missing config fields.
2. Resolve the trading binding by `tradingBindingId`.
3. Verify the binding exists and is still usable for startup.
4. Resolve `sourceVenueAccountId`.
5. Load the `venue_accounts` row when the provider path still depends on it.
6. Centralize the provider-specific requirement check:
   - orderbook venues still require a source venue account
   - 1inch still requires a source venue account
   - Jupiter still requires a source venue account because wallet address comes from `venueAccountRef`

#### Required failures

The resolver should fail fast with binding-native errors for:

1. binding not found
2. binding revoked / unusable for startup
3. binding missing `sourceVenueAccountId` when the provider path still requires it
4. source venue account row missing even though the binding points at one

#### Validation

1. Add unit tests for the resolver if extracted.
2. Run the focused worker test file(s).
3. Run `pnpm lint`.

#### Expected Result

There is one authoritative startup translation path:

`tradingBindingId -> trading binding -> sourceVenueAccountId -> venue account -> credential lookup inputs`

---

### Slice 3 — Migrate runtime startup to resolved context

#### Goal

Stop reading `venueAccountId` directly from job config as the startup precondition.

#### Files

- `apps/worker/src/index.ts`
- `apps/worker/src/live-gate.ts` only if a small naming/input cleanup is needed

#### Tasks

1. Remove the current direct precondition:

```ts
const venueAccountId = rawConfig['venueAccountId']
if (!venueAccountId) throw ...
```

2. Resolve startup context before any credential logic.
3. Derive `venueAccountId` from the resolved context and feed that derived value into existing downstream logic.
4. Replace raw `venueAccounts` lookups with lookups based on resolved context.
5. Keep current live-mode fail-closed behavior intact.
6. Keep current paper-mode behavior intact.
7. Keep current adapter selection logic intact.

#### Orderbook-specific requirements

1. Continue to resolve credentials from the resolved venue-account row.
2. Continue to allow paper-mode startup without linked credentials where current behavior already allows it.

#### Swap-specific requirements

1. Continue 1inch credential lookup through the resolved venue-account row.
2. Continue Jupiter wallet address lookup through resolved `venueAccountRef`.
3. Do not redesign swap credential anchoring in this pass.

#### Validation

1. Add or update worker startup tests for `tradingBindingId`-only payloads.
2. Re-run the relevant worker test files.
3. Run `pnpm lint`.

#### Expected Result

The runtime can start a bot from `tradingBindingId` alone, while still supporting legacy downstream credential and venue-account dependencies.

---

### Slice 4 — Align restart and rehydration entrypoints

#### Goal

Make every startup producer feed the same worker resolution path.

#### Files

- `apps/worker/src/index.ts`
- `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/credentials.ts`
- any worker runtime helper used to restore running bots on boot

#### Tasks

1. Update persisted rehydration to include `tradingBindingId` when reconstructing runtime config for running bots.
2. Keep `venueAccountId` optional in the reconstructed config during the transition, not authoritative.
3. Ensure `/bots/:id/config` restart enqueue remains binding-first by including `tradingBindingId`.
4. Ensure `credentials.ts` restart jobs still work when they only provide `botId`; worker startup should hydrate missing config and binding context from DB.
5. Confirm there is no remaining producer that only works because raw `venueAccountId` was pre-injected.

#### Validation

1. Add coverage for restart jobs with no config.
2. Add coverage for rehydration of a persisted running bot.
3. Run targeted worker and API tests.

#### Expected Result

Start, restart, and boot-time rehydration all converge on the same startup-context resolver.

---

### Slice 5 — Normalize error surfaces

#### Goal

Replace legacy-input errors with binding-native startup failures.

#### Files

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/index.ts`
- `apps/api/src/routes/bots.ts` only if a small consistency rename is chosen
- tests asserting error codes / messages

#### Tasks

1. Remove worker errors that imply the queue caller forgot to supply `venueAccountId`.
2. Standardize the worker-side failure family around binding resolution.
3. Decide whether to keep API code `binding.missing_venue_account` for compatibility or rename it to `binding.missing_source_venue_account` and update tests consistently.
4. Ensure broker and runtime logs state whether failure occurred during:
   - binding selection
   - startup-context resolution
   - credential resolution

#### Validation

1. Update assertion text/code in worker and API tests.
2. Run focused test files.
3. Run `pnpm lint`.

#### Expected Result

Operators can distinguish binding failures from malformed queue payloads.

---

### Slice 6 — Add focused regression coverage

#### Goal

Lock in the binding-first contract before moving on to `022-agent-tool-improvements`.

#### Required scenarios

1. Agent broker create-and-start enqueues startup by `tradingBindingId`.
2. Agent explicit start enqueues startup by `bot.tradingBindingId`.
3. Worker startup accepts a job with `tradingBindingId` and no `venueAccountId`.
4. Worker startup resolves `venueAccountId` internally before credential lookup.
5. Worker startup fails clearly when the binding is missing.
6. Worker startup fails clearly when the binding is unusable for startup.
7. Worker startup fails clearly when the binding requires but lacks `sourceVenueAccountId`.
8. Restart jobs with only `botId` still work by hydrating bot config and binding context from DB.
9. Persisted running-bot rehydration still works.

#### Files to update

- `apps/worker/src/agents/agent-broker.test.ts`
- worker startup tests near `apps/worker/src/index.ts`
- `apps/api/src/routes/bots.test.ts` only if API error semantics are adjusted
- `apps/api/src/routes/credentials.test.ts` if restart behavior assertions need to change

#### Final validation

1. Run focused worker tests.
2. Run focused API tests affected by restart/error changes.
3. Run `pnpm lint`.

## File-Level Execution Order

1. `apps/worker/src/agents/agent-message-broker.ts`
2. `apps/worker/src/index.ts`
3. optional startup-context helper file
4. tests for broker and worker startup
5. `apps/api/src/routes/bots.ts` only if error normalization or restart payload cleanup is needed
6. `apps/api/src/routes/credentials.ts` only if restart payload expectations or comments need to change

## Acceptance Checklist

- [ ] Agent-created bot start routing is `tradingBindingId`-first.
- [ ] Explicit bot start routing is `tradingBindingId`-first.
- [ ] Worker startup no longer requires queue `venueAccountId` as its primary precondition.
- [ ] Worker derives legacy `venueAccountId` internally from binding context.
- [ ] Restart and rehydration use the same binding-resolution path.
- [ ] Bindings missing source venue account fail with binding-native errors.
- [ ] Existing downstream `venueAccountId` consumers remain compatible.
- [ ] Focused worker/API tests cover the new contract.
- [ ] `pnpm lint` passes.

## Why This Should Be Done Before 022

`022-agent-tool-improvements` will increase the number of agent-originated bot lifecycle actions.

If the runtime contract remains `venueAccountId`-first while tooling becomes more capable, the system will:

1. keep leaking legacy routing assumptions into agent flows
2. keep producing misleading startup errors
3. make later lifecycle tools harder to reason about and test

Completing this follow-through first keeps lifecycle behavior coherent before expanding agent tool surface area.