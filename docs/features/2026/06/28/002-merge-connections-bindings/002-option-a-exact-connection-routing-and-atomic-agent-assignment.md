# Option A: Exact Connection Routing And Atomic Agent Assignment

## Goal

Implement a non-backward-compatible, production-ready connection model where:

1. A `connection` is the durable identity used by APIs, agents, bots, and the worker runtime.
2. A trading-capable connection becomes executable only when it has an explicit `resolvedVenueAccountId`.
3. No trading execution path infers a venue account from `(userId, provider)`.
4. Agent connection assignment is atomic on `POST /agents` and declarative on `PATCH /agents/:id` via `connectionIds`.
5. Old `binding` vocabulary and `capability_grants` implementation details are removed rather than preserved.

This plan is written for direct implementation by an LLM. Follow the phases in order. Do not skip validations. Do not preserve compatibility layers.

## Fixed Decisions

These decisions are part of the implementation target and should not be revisited while executing this plan:

- Backward compatibility is out of scope.
- `capability_grants` is replaced by `agent_connections`.
- `connections` remains the durable provider linkage entity.
- Trading-ready connections store an explicit `resolvedVenueAccountId` FK.
- Plain `POST /connections` may create a connection with `resolvedVenueAccountId = null`.
- A trading connection with `resolvedVenueAccountId = null` is not executable and must not be treated as ready.
- Same-provider multiple connections remain allowed at the user level.
- Runtime routing must be exact by `connectionId`, never inferred by `provider`.

## End State

After this plan is implemented:

- `POST /setup/provider-link` creates a trading-ready connection and writes the exact `resolvedVenueAccountId`.
- `POST /connections` creates a generic connection only.
- `POST /bots` resolves the bot venue account from the selected connection row only.
- Agent-driven bot creation resolves the exact venue account from the selected connection row only.
- Worker startup validates `bot.connectionId`, `bot.venueAccountId`, and `connection.resolvedVenueAccountId` for consistency.
- `POST /agents` accepts `connectionIds` and creates agent plus connection assignments in one transaction.
- `PATCH /agents/:id` accepts `connectionIds` and declaratively syncs assignments.
- Readiness and runtime capability resolution derive capability families from `providers.capabilities` through `agent_connections`.
- E2E helpers and browser tests use `connectionId` and `connectionReadiness`, not `bindingId` and `bindingReadiness`.

## Anti-Goals

Do not do any of the following:

- Do not keep provider-based trading routing as a fallback.
- Do not keep `venueAccountId`-only broker paths for compatibility.
- Do not keep `capability_grants` as a shadow implementation.
- Do not add soft compatibility shims for old E2E helper payloads.
- Do not infer readiness from provider status alone when `resolvedVenueAccountId` is absent.

## Implementation Order

Implement the phases below in order. Do not start a later phase until the previous phase is complete and validated.

---

## Phase 1: Schema Foundations

### Objective

Introduce the schema needed for exact connection routing and atomic assignment.

### Changes

1. Add `providers` table.
2. Add `agent_connections` table.
3. Add `agent_connection_audit` table if the existing audit behavior is still needed.
4. Add `resolvedVenueAccountId` to `connections` as a nullable FK to `venue_accounts`.
5. Remove `capability_grants` and `capability_grant_audit` after backfill into `agent_connections`.

### Files

- [packages/db/src/schema/connections.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/connections.ts)
- [packages/db/src/schema/venue-accounts.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/venue-accounts.ts)
- [packages/db/src/schema/index.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/index.ts)
- `packages/db/src/schema/providers.ts` (new)
- `packages/db/src/schema/agent-connections.ts` (new)
- `packages/db/src/schema/agent-connection-audit.ts` (new, if retained)
- [packages/db/drizzle](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/drizzle)

### Implementation Notes

- Seed `providers` with the currently supported trading providers:
  - `hyperliquid`
  - `jupiter`
  - `1inch`
  - `bybit`
- `providers.capabilities` must drive capability-family derivation later.
- `connections.resolvedVenueAccountId` must be nullable because generic connections remain valid.
- The migration should backfill `agent_connections` from `capability_grants` and backfill `connections.resolvedVenueAccountId` where the current trading setup makes that derivation possible.

### Acceptance Criteria

- Schema builds cleanly.
- Migration can run on a seeded database.
- `providers` exists and is seeded.
- `agent_connections` exists and contains backfilled data.
- `connections.resolvedVenueAccountId` exists.
- `capability_grants` is no longer used by runtime code.

### Validation

1. Generate and inspect the migration.
2. Apply the migration to a seeded local DB.
3. Confirm seeded providers and backfilled rows exist.

---

## Phase 2: Trading Setup Becomes Authoritative

### Objective

Make trading setup the only path that produces a trading-ready connection.

### Changes

1. Update `POST /setup/provider-link` so that trading setup:
   - creates the credential
   - creates the connection
   - creates the venue account
   - writes `connections.resolvedVenueAccountId`
   - does all of the above in one transaction
2. Keep plain `POST /connections` generic:
   - no venue account provisioning
   - `resolvedVenueAccountId = null`

### Files

- [apps/api/src/routes/setup.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/setup.ts)
- [apps/api/src/trading-provisioner.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/trading-provisioner.ts)
- [apps/api/src/routes/connections.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/connections.ts)
- [apps/api/src/routes/setup.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/setup.test.ts)

### Implementation Notes

- `provider-link` should return the new connection with `resolvedVenueAccountId` present for trading-capable setup.
- Generic `/connections` creation must not silently become trading-ready.
- If the provider is trading-capable but setup has not created a venue account, readiness must remain unconfigured or not ready.

### Acceptance Criteria

- Trading setup writes `resolvedVenueAccountId`.
- Generic connection creation leaves `resolvedVenueAccountId = null`.
- No API path infers trading readiness from `provider` alone.

### Validation

1. Add or update route tests for provider-link.
2. Confirm the response and persisted connection contain `resolvedVenueAccountId` for trading setup.

---

## Phase 3: Remove Provider-Based Execution Routing

### Objective

Make all bot and worker execution routing exact by `connectionId`.

### Changes

1. Rewrite API bot creation to resolve venue account from the selected connection row only.
2. Rewrite agent broker bot creation to resolve venue account from the selected connection row only.
3. Delete legacy `venueAccountId` fallback behavior.
4. Delete repository helpers that resolve a venue account by `(userId, provider)`.

### Files

- [apps/api/src/routes/bots.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/bots.ts)
- [apps/worker/src/agents/agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts)
- [packages/db/src/repositories.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/repositories.ts)
- [apps/api/src/routes/bots.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/bots.test.ts)
- [apps/worker/src/agents/agent-broker.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-broker.test.ts)

### Implementation Notes

- Replace any query shaped like `WHERE venue_accounts.user_id = ? AND venue_accounts.venue = connection.provider`.
- Introduce exact connection-based lookup helpers if needed.
- If a selected connection has `resolvedVenueAccountId = null`, fail loudly.
- Do not preserve the current `payload.venueAccountId` branch in the broker.

### Acceptance Criteria

- Neither API bot creation nor worker broker creation can pick the wrong same-provider venue account.
- No runtime-critical code path uses provider-based venue-account selection.

### Validation

1. Add tests with two Hyperliquid connections for one user.
2. Prove connection A never resolves to venue account B.

---

## Phase 4: Startup Invariants

### Objective

Fail loud if persisted runtime state becomes inconsistent.

### Changes

1. Update startup context resolution to load:
   - bot row
   - selected connection row
   - selected venue account row
2. Validate consistency between:
   - `bot.connectionId`
   - `bot.venueAccountId`
   - `connection.resolvedVenueAccountId`
3. Refuse startup on mismatch.

### Files

- [apps/worker/src/startup-context.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/startup-context.ts)
- [apps/worker/src/startup-context.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/startup-context.test.ts)

### Implementation Notes

- This is not a warning path.
- Startup must fail if the bot row and connection row disagree.

### Acceptance Criteria

- Inconsistent bot or connection state aborts startup.
- Consistent state still starts successfully.

### Validation

1. Add explicit mismatch tests.
2. Confirm error messages are specific and actionable.

---

## Phase 5: Atomic Agent Connection Assignment

### Objective

Replace the old grant model and make agent connection assignment atomic on create and declarative on patch.

### Changes

1. Add `connectionIds?: string[]` to `POST /agents`.
2. Add `connectionIds?: string[]` to `PATCH /agents/:id`.
3. Validate every `connectionId` in the same transaction as the agent write:
   - exists
   - belongs to the user
   - has `status = 'active'`
4. On create:
   - create agent
   - create `agent_connections` rows in the same transaction
5. On patch:
   - insert missing active rows
   - revoke removed rows
   - leave retained active rows unchanged

### Files

- [apps/api/src/routes/agents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.ts)
- [packages/db/src/agent-runtime-descriptor.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/agent-runtime-descriptor.ts)
- [apps/api/src/routes/agents.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.test.ts)
- Functional tests under [apps/api/src/__tests__/functional](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/__tests__/functional)

### Implementation Notes

- This work lands on `agent_connections`, not `capability_grants`.
- Remove create-then-bind behavior from the API model entirely.
- Readiness and runtime descriptor generation must query `agent_connections` joined to `connections` and `providers`.
- Capability family is derived from `providers.capabilities`, not stored on the join row.

### Acceptance Criteria

- `POST /agents` is atomic with respect to connection assignment.
- `PATCH /agents/:id` is declarative.
- Invalid `connectionIds` reject the entire request.
- Readiness and runtime descriptor no longer depend on `capability_grants`.

### Validation

Add tests for:

1. valid `connectionIds`
2. missing connection
3. foreign-user connection
4. revoked connection
5. empty or omitted array
6. patch add
7. patch remove
8. patch keep

---

## Phase 6: Web Create And Edit Flows

### Objective

Make the web app use the atomic `connectionIds` contract directly.

### Changes

1. Update create-agent payload builder to include `connectionIds`.
2. Replace the single trading connection selector with multi-select connection assignment.
3. Remove the post-create bind request.
4. Update edit-agent flow to use declarative `connectionIds`.
5. Keep zero selected connections valid.

### Files

- [apps/web/src/features/agents/agent-payloads.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/agent-payloads.ts)
- [apps/web/src/features/agents/AgentsPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentsPage.tsx)
- [apps/web/src/features/agents/AgentCapabilityPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentCapabilityPage.tsx)
- [apps/web/src/lib/api-client.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/lib/api-client.ts)
- web tests near these files

### Implementation Notes

- Inline trading setup should refresh the connection picker after success.
- Newly created trading-ready connections should already carry `resolvedVenueAccountId` when created via provider-link.
- If bind or unbind UI remains on the capability page, it must operate on `agent_connections`, not `capability_grants`.

### Acceptance Criteria

- The create flow sends `connectionIds` in the initial request.
- No separate bind request occurs after creation.
- The edit flow also uses `connectionIds`.

### Validation

1. Update unit tests for payload builders.
2. Update page tests for the new selection flow.

---

## Phase 7: Finish The Public Contract Rename

### Objective

Remove old `binding` contract usage from helpers, E2E, and user-facing code.

### Changes

1. Replace `bindingId` with `connectionId` in E2E helpers.
2. Replace `bindingReadiness` with `connectionReadiness` in mocked readiness payloads.
3. Remove stale helper names and old test assertions.
4. Update UI copy and client types to use connection terminology only.

### Files

- [tests/e2e/helpers.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/tests/e2e/helpers.ts)
- [tests/e2e/journeys/07-mission-control-renders.spec.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/tests/e2e/journeys/07-mission-control-renders.spec.ts)
- [tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts)
- [packages/domain/src/platform.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/platform.ts)
- [apps/api/src/routes/capabilities/trading.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/trading.ts)

### Acceptance Criteria

- No browser or E2E helper posts `bindingId`.
- No browser or E2E helper expects `bindingReadiness`.
- User-facing capability flows use connection terminology consistently.

### Validation

1. Rerun the trading capability browser path.
2. Confirm helper and journey tests are green.

---

## Phase 8: Production Hardening

### Objective

Make the implementation safe to ship.

### Changes

1. Add fail-loud checks wherever a trading execution path sees `resolvedVenueAccountId = null`.
2. Add a consistency audit or migration-time verification for bots whose `venueAccountId` disagrees with their connection mapping.
3. Remove dead code, dead tests, and transition comments related to provider-based lookup or `capability_grants`.
4. Update feature docs and operator notes.

### Acceptance Criteria

- No trading execution path can silently proceed without an exact venue account mapping.
- Dead compatibility code is removed.
- Documentation reflects the final supported model.

### Validation

1. Run `pnpm lint`.
2. Run the narrowest route and worker test slices first.
3. Run broader suites after focused tests pass.
4. Do one manual UAT:
   - create two same-provider connections for one user
   - assign one to an agent
   - create a bot from that agent
   - verify the stored `bot.connectionId` and `bot.venueAccountId` pair is the intended pair

## File Checklist

Use this as a direct implementation checklist.

- [packages/db/src/schema/connections.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/connections.ts)
- [packages/db/src/schema/venue-accounts.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/venue-accounts.ts)
- [packages/db/src/schema/index.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/index.ts)
- [packages/db/drizzle](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/drizzle)
- [apps/api/src/routes/setup.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/setup.ts)
- [apps/api/src/trading-provisioner.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/trading-provisioner.ts)
- [apps/api/src/routes/connections.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/connections.ts)
- [apps/api/src/routes/bots.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/bots.ts)
- [apps/api/src/routes/agents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.ts)
- [apps/api/src/routes/capabilities/index.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/index.ts)
- [apps/api/src/routes/capabilities/trading.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/trading.ts)
- [apps/worker/src/agents/agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts)
- [apps/worker/src/startup-context.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/startup-context.ts)
- [packages/db/src/repositories.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/repositories.ts)
- [packages/db/src/agent-runtime-descriptor.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/agent-runtime-descriptor.ts)
- [apps/web/src/features/agents/agent-payloads.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/agent-payloads.ts)
- [apps/web/src/features/agents/AgentsPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentsPage.tsx)
- [apps/web/src/features/agents/AgentCapabilityPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentCapabilityPage.tsx)
- [apps/web/src/lib/api-client.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/lib/api-client.ts)
- [tests/e2e/helpers.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/tests/e2e/helpers.ts)
- [tests/e2e/journeys/07-mission-control-renders.spec.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/tests/e2e/journeys/07-mission-control-renders.spec.ts)
- [tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts)

## Test Matrix

Add or update the following tests:

1. Migration verification on seeded data.
2. `POST /setup/provider-link` persists `resolvedVenueAccountId` for trading setup.
3. `POST /connections` leaves `resolvedVenueAccountId = null`.
4. `POST /bots` with two same-provider connections resolves the exact selected venue account.
5. Worker `create_and_start` with two same-provider connections preserves the exact connection-account pair.
6. Startup fails on connection-account mismatch.
7. `POST /agents` with valid `connectionIds` succeeds atomically.
8. `POST /agents` with invalid or foreign `connectionIds` fails atomically.
9. `PATCH /agents/:id` declaratively adds and revokes assignments.
10. Readiness derives from `agent_connections + connections + providers` and treats null `resolvedVenueAccountId` as not ready for trading.
11. E2E helpers use `connectionId` and `connectionReadiness` only.

## Final Ship Checklist

Before considering the work done:

1. All provider-based trading routing is deleted.
2. All `capability_grants` runtime usage is deleted.
3. All create-then-bind web behavior is deleted.
4. All E2E helper binding vocabulary is deleted.
5. Focused tests pass.
6. `pnpm lint` passes.
7. Manual UAT confirms exact routing with two same-provider connections.
