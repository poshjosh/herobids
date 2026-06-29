# Follow-Up: Delete `capability_grants` Safely

This document is a followup to these 2:

- docs/features/2026/06/28/002-merge-connections-bindings/001-plan.md

- docs/features/2026/06/28/002-merge-connections-bindings/002-option-a-exact-connection-routing-and-atomic-agent-assignment.md

## Goal

Finish Option A by removing the old `capability_grants` / `capability_grant_audit` model entirely.

This follow-up exists because the repo is currently in a mixed state:

- exact connection routing is largely implemented
- `agent_connections` and `providers` exist
- trading setup writes `connections.resolvedVenueAccountId`
- bot creation and worker startup already use exact `connectionId` routing
- agent create / patch already use atomic, declarative `connectionIds`

But several live API and UI surfaces still depend on the old grant model. Dropping the tables immediately would break compile-time imports and runtime SQL queries.

This plan migrates the remaining readers and writers first, then deletes the legacy tables.

## Non-Goal

Do not preserve compatibility with the old grant model.

- Do not keep `capability_grants` as a shadow source of truth.
- Do not keep `grant-service.ts` alive behind an adapter.
- Do not keep readiness semantics that treat a generic active connection as trading-ready.
- Do not add fallback logic that infers readiness or routing from `provider` alone.

## Out Of Scope — Do Not Touch (Critical Naming Collision)

The worker's in-memory tool-access policy engine shares similar names with the DB grant model but is a **completely unrelated concept**. It governs sandbox tool tiers (`brokered` / `direct` / `never`), not connection assignment or trading readiness.

The following symbols in `apps/worker/src/agents/capability-policy.ts` and its consumers **must remain untouched** by this plan:

- the `CapabilityGrant` *type* (the sandbox tool-policy interface, distinct from the `platform.ts` interface)
- `DEFAULT_CAPABILITY_GRANTS`
- `buildCapabilityGrants()`
- `CapabilityPolicyEngine`, `buildCapabilityPolicyEngine()`
- consumers: `apps/worker/src/agent.ts`, `agent-message-broker.ts`, `agents/index.ts`, and their tests

Renaming or deleting any of these will break the entire agent tool sandbox.

This plan targets only:

- the Drizzle schema symbols `capabilityGrants` and `capabilityGrantAudit`
- the underlying tables `capability_grants` and `capability_grant_audit`
- the `CapabilityGrant` interface exported from `packages/domain/src/platform.ts` (the platform contract, NOT the worker type)

Every checklist item and validation grep below is scoped to those symbols only.

## Earlier Review Findings To Carry Forward

These findings came from the earlier code review and are part of the required scope for this deletion plan.

### High

1. `apps/api/src/routes/capabilities/trading.ts` still reads trading assignments from `capability_grants` and reports trading readiness from `grantStatus === active && connectionStatus === active`. That is incomplete because trading readiness must also require `connections.resolvedVenueAccountId`.
2. `apps/api/src/routes/capabilities/index.ts` still builds aggregate readiness from `capability_grants`, so the aggregate endpoint and the runtime descriptor are currently derived from different data models.
3. `apps/api/src/grant-service.ts` still creates, revokes, audits, and resolves ownership through `capability_grants` / `capability_grant_audit`. The old implementation is still active, not just dead code.

### Medium

4. `apps/api/src/routes/connections.ts` still uses `capability_grants` to find affected agents on connection revoke and still carries a TODO about grant revocation.
5. `apps/web/src/features/agents/AgentCapabilityPage.tsx` and `apps/web/src/features/agents/EditAgentModal.tsx` assume a `connectionStatus` field on the generic connections list, but `/capabilities/trading/connections` returns `status`. The current UI is therefore using the wrong contract surface.
6. `packages/domain/src/platform.ts` still exports `CapabilityGrant` and still describes grants as the shared platform concept. The contract rename is not complete.
7. The migration that introduced `agent_connections` explicitly deferred dropping `capability_grants` and `capability_grant_audit`. Do not edit that historical migration in place; add a new migration for the actual drop.

## Current Safe Assumption

Assume that any code path still importing the Drizzle symbols `capabilityGrants` or `capabilityGrantAudit` is a blocker for schema deletion.

Before writing the drop migration, run a repo-wide search and reduce code usage to zero outside:

- historical docs
- historical migrations
- changelog text that intentionally records history

Use a grep that targets the DB symbols only and explicitly excludes the worker tool-policy collision:

```
rg "capabilityGrants|capability_grants|capabilityGrantAudit|capability_grant_audit" apps packages tests
```

Do NOT search for `CapabilityGrant`, `DEFAULT_CAPABILITY_GRANTS`, or `buildCapabilityGrants` — those are the worker sandbox policy and are out of scope (see "Out Of Scope" above).

## Implementation Order

Do these phases in order. Do not drop the tables before Phase 5.

---

## Phase 1: Move Capability Readiness Fully Onto `agent_connections`

### Objective

Make all capability and trading readiness routes derive from the same model already used by the runtime descriptor:

- `agent_connections`
- `connections`
- `providers.capabilities`
- `connections.resolvedVenueAccountId`

### Files

- `apps/api/src/routes/capabilities/index.ts`
- `apps/api/src/routes/capabilities/trading.ts`
- `packages/db/src/agent-runtime-descriptor.ts`
- tests near those files

### Changes

1. Replace `capabilityGrants` joins in capability routes with `agentConnections` joins.
2. Derive capability families from `providers.capabilities`, not `capability_grants.capabilityFamily`.
3. For trading, treat an active connection with `resolvedVenueAccountId = null` as not ready and not eligible.
4. Use one deterministic connection-selection rule for readiness endpoints and runtime defaults.
5. Remove grant-centric reason strings such as "no grants have been created for this capability family" and replace them with assignment-centric language.

### Implementation Notes

- Prefer a shared helper or helper pattern between the routes and `resolveRuntimeCapabilityDescriptor()` so readiness semantics cannot drift again.
- The trading readiness route must not report `ready` unless all of the following are true:
  - agent connection row is active
  - connection row is active
  - provider capabilities include `trading`
  - `resolvedVenueAccountId` is non-null
- If multiple active rows are present, the default connection must be deterministic. Reuse the existing selection/ordering rule already implemented in `resolveRuntimeCapabilityDescriptor()` rather than inventing a new one — readiness endpoints and the runtime descriptor must select the same effective row from the same ordering.

### Acceptance Criteria

- No capability or readiness route imports `capabilityGrants`.
- Trading readiness is impossible when `resolvedVenueAccountId` is null.
- Aggregate readiness and runtime descriptor agree on the same effective readiness result.

### Validation

Add or update tests for:

1. active trading assignment + null `resolvedVenueAccountId` => not ready
2. active trading assignment + non-null `resolvedVenueAccountId` => ready
3. provider capability family derivation through `providers.capabilities`
4. deterministic default connection selection when multiple active rows exist

---

## Phase 2: Delete Legacy Grant Service Behavior

### Objective

Remove the last live write-path abstraction built on `capability_grants`.

### Files

- `apps/api/src/grant-service.ts`
- `apps/api/src/grant-service.test.ts` (imports `capabilityGrants` + `capabilityGrantAudit`; delete alongside the service)
- `apps/api/src/routes/capabilities/trading.ts` (imports from `../../grant-service.js`)
- `apps/api/src/routes/agents.ts`
- tests near those files

### Changes

1. Delete `grant-service.ts` once no live route needs it.
2. Remove or rewrite any legacy bind / unbind action endpoints that still depend on grant IDs or grant audit.
3. If connection-assignment audit is still required, switch the capability page audit path to `agent_connection_audit`.
4. Do not reintroduce imperative grant mutation helpers if `PATCH /agents/:id` already provides the declarative contract.

### Implementation Notes

- The web capability page already patches `connectionIds` directly. That should remain the public assignment model.
- If `POST /agents/:id/capabilities/trading/action` still exists only for `bind` / `unbind`, delete it rather than preserve it for compatibility.
- If an audit endpoint remains, it must resolve through `agent_connections` and `agent_connection_audit`, not legacy grant IDs.

### Acceptance Criteria

- No production route imports `createGrant`, `revokeGrant`, `getBindingAudit`, `assertGrantOwnership`, or `assertBindingOwnership` from the legacy service.
- `grant-service.ts` is removed or reduced to zero production usage and then deleted.

### Validation

1. Route tests for assignment and unassignment still pass through `PATCH /agents/:id`.
2. Any remaining audit route returns `agent_connection_audit` data only.

---

## Phase 3: Move Connection Revoke Logic Off The Old Table

### Objective

Stop using `capability_grants` in connection lifecycle behavior.

### Files

- `apps/api/src/routes/connections.ts`
- `packages/db/src/agent-runtime-descriptor.ts`
- tests near those files

### Changes

1. Replace the `capabilityGrants` lookup used to find affected agents after connection revoke with an `agentConnections` lookup (`connections.ts` currently queries `capabilityGrants.agentId WHERE connectionId = id AND status = 'active'` around line 271).
2. Remove `capabilityGrants` from the `@herobids/db` import on line 6 of `connections.ts` once the query is migrated — leaving the unused import will block the Phase 6 schema-export deletion from compiling.
3. Remove the stale `TODO(21.3)` text about cascade-revoking grants (around line 282).
4. Decide whether revoke should:
   - leave `agent_connections` active and let readiness derive `revoked` from the connection row, or
   - explicitly revoke matching `agent_connections` rows and write `agent_connection_audit`

### Recommendation

Prefer leaving assignment rows intact unless product requirements explicitly need assignment revocation. The important invariant is that revoked connections are not executable and all affected agents receive a runtime refresh.

### Acceptance Criteria

- Connection revoke publishes runtime refreshes without touching `capability_grants`.
- No TODO remains that references future cleanup of the old grant model.

### Validation

1. Revoke a connection with active agent assignments and assert affected agents are refreshed.
2. Readiness becomes revoked / ineligible after connection revoke.

---

## Phase 4: Fix The Remaining UI Contract Drift

### Objective

Carry forward the earlier review findings so the deletion does not land on top of a broken capability-assignment UI.

### Files

- `apps/web/src/features/agents/AgentCapabilityPage.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/lib/api-client.ts`
- tests near those files

### Changes

1. Stop expecting `connection.connectionStatus` on the generic `/capabilities/trading/connections` response.
2. Use the actual `status` field from `ConnectionSummary` for generic connection readiness on that endpoint.
3. Keep `grantStatus` only for agent-scoped assignment rows.
4. Concrete fix: `EditAgentModal.tsx` line ~100 filters on `status === 'active' && connectionStatus === 'active'`. Because `connectionStatus` is `undefined` on this endpoint, the second conjunct is always falsy and **every** connection is rejected. Drop the `connectionStatus === 'active'` conjunct (filter on `status === 'active'` only).
5. Verify whether `AgentCapabilityPage.tsx` shares the same `connectionStatus` defect before applying the same fix — do not assume it; confirm the actual field it reads.

### Acceptance Criteria

- The edit flow shows active connections.
- The capability page does not treat every generic connection row as not ready because of a missing property.

### Validation

1. Web tests for capability page connection rendering.
2. Web tests for edit-agent modal connection selection.

---

## Phase 5: Rename Shared Contracts And Remove Old Schema Exports

### Objective

Finish the contract rename before the actual schema drop.

### Files

- `packages/domain/src/platform.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/capability-grants.ts`
- `packages/db/src/schema/capability-grant-audit.ts`
- any code or tests still importing those symbols

### Changes

1. Replace the `CapabilityGrant` interface exported from `packages/domain/src/platform.ts` (line ~101) with `AgentConnection` or the final chosen contract name. This is the platform contract only — it is NOT the worker `CapabilityGrant` tool-policy type, which must remain unchanged.
2. Remove `capabilityGrants` and `capabilityGrantAudit` exports from the schema index.
3. Delete schema files for the old tables once code usage has reached zero.
4. Update test helpers and fixtures that still truncate, seed, or assert against the old tables.

### Known Likely Cleanup Targets

- `apps/api/src/__tests__/functional/helpers.ts`
- `apps/api/src/__tests__/functional/capability-model.functional.test.ts`
- `apps/api/src/routes/capabilities/trading.test.ts`
- `apps/api/src/routes/agents.test.ts`
- `apps/worker/src/__tests__/integration/agent-native-decision.integration.test.ts` (imports `capabilityGrants` and seeds/updates it at lines ~36, 207, 347, 502 — must reseed via `agent_connections`)

> Reminder: do NOT touch `apps/worker/src/agents/capability-policy.ts` or its tests (`capability-policy.test.ts`, `capability-sandbox.test.ts`, `agent-broker.test.ts`). Their `CapabilityGrant` / `DEFAULT_CAPABILITY_GRANTS` references are the sandbox tool-policy, not the DB model. See "Out Of Scope".

### Acceptance Criteria

- Production code no longer imports `capabilityGrants` or `capabilityGrantAudit`.
- Test code no longer needs those tables except where historical migration behavior is explicitly under test.

### Validation

1. `rg "capabilityGrants|capability_grants|capabilityGrantAudit|capability_grant_audit" apps packages tests`
2. Review remaining matches and confirm they are only historical references that should remain.

---

## Phase 6: Add The Real Drop Migration

### Objective

Remove the old tables from the database after all code paths are migrated.

### Files

- `packages/db/drizzle/*` new migration
- `packages/db/src/schema/index.ts`
- Drizzle snapshot / journal files generated by the repo workflow

### Changes

1. Generate a new migration; do not rewrite the already-committed migration (`0027`) that deferred the drop.
2. Drop in dependency order — `capability_grant_audit` has an FK to `capability_grants`, so it must be dropped **first**:
   - `capability_grant_audit`
   - `capability_grants`
   Use `DROP TABLE ... CASCADE` only if Drizzle does not emit explicit FK/index drops; prefer explicit ordering over relying on `CASCADE`.
3. Remove any remaining indexes / constraints tied to those tables (e.g. `idx_capability_grants_connection_id`, `uq_capability_grants_active`, the `capability_grant_audit_*` indexes seen in the `0026`/snapshot history) if Drizzle does not already generate them cleanly.

### Pre-Drop Safety Gate (Mandatory)

This is an irreversible destructive migration. Before the drop runs, prove backfill is complete — do not "assume" it:

1. Assert every active `capability_grants` row has a corresponding `agent_connections` row (a query returning zero orphaned active grants).
2. Assert `capability_grant_audit` history has been backfilled into `agent_connection_audit` if that history must be retained.
3. If either assertion can fail in any target environment, archive the rows (dump to file or an archive table) before dropping.

### Rollback Posture

State this explicitly in the migration PR description: the drop is **irreversible** (no down-migration recovers the data). Operational requirement: take a database backup immediately before applying in any non-ephemeral environment. If audit history has regulatory/retention value, the archive step above is required, not optional.

### Implementation Notes

- The current deferred comments in the earlier migration (`0027`) are documentation of history, not the vehicle for the final delete.
- The new migration runs only after the Pre-Drop Safety Gate confirms `agent_connections` is authoritative.

### Acceptance Criteria

- Schema files no longer define the old tables.
- A fresh database and a migrated seeded database both end in the same target schema.
- The pre-drop backfill assertions pass before the drop executes.

### Validation

1. Generate and inspect the migration (confirm audit dropped before grants).
2. Apply migrations to a seeded local DB and confirm the pre-drop assertions pass.
3. Confirm both old grant tables are absent.
4. Run `pnpm build` to confirm schema-export removal compiles cleanly across all packages.

---

## Phase 7: Final Validation Sweep

### Objective

Prove that the old table can be deleted without hidden regressions.

### Validation Order

1. Focused API tests for capability readiness and trading routes.
2. Focused API tests for connection revoke behavior.
3. Focused web tests for agent capability page and edit flow.
4. Focused worker tests for startup context and agent routing assumptions.
5. `pnpm lint`
6. `pnpm build` (full build — required because schema exports and a domain contract were removed; type-check alone via lint is not sufficient proof the table drop compiles everywhere).
7. Broader targeted suites that still touch connection assignment or readiness.

### Manual UAT

1. Create two same-provider connections for one user.
2. Leave one generic with `resolvedVenueAccountId = null`.
3. Assign both to one agent.
4. Confirm readiness picks only the trading-ready connection as effective ready.
5. Revoke the ready connection and confirm readiness flips to not ready.
6. Create a bot from the intended connection and verify `bot.connectionId` matches `bot.venueAccountId` through `connections.resolvedVenueAccountId`.

## Final Ship Checklist

Before calling this complete:

1. No production code imports the Drizzle symbol `capabilityGrants`.
2. No production code imports the Drizzle symbol `capabilityGrantAudit`.
3. No production route derives readiness from the old model.
4. Trading readiness requires non-null `resolvedVenueAccountId`.
5. Connection revoke no longer queries the old table (and the `capabilityGrants` import is removed from `connections.ts`).
6. The capability assignment UI uses the correct connection status fields (`EditAgentModal` no longer filters on the non-existent `connectionStatus`).
7. The `platform.ts` `CapabilityGrant` interface no longer exposes the old model. (The worker `capability-policy.ts` `CapabilityGrant` type is intentionally left untouched — out of scope.)
8. The pre-drop backfill safety gate passes, and a new migration drops `capability_grant_audit` then `capability_grants`.
9. Focused tests pass (including the migrated `agent-native-decision.integration.test.ts`).
10. `pnpm lint` passes.
11. `pnpm build` passes.

## Short Version

Do not delete `capability_grants` first.

Delete it last, after the remaining live readers and writers are moved to:

- `agent_connections`
- `connections`
- `providers.capabilities`
- `connections.resolvedVenueAccountId`

If you drop the table before that migration, the current app will fail in capability readiness, connection revoke refresh, and any remaining legacy grant-service path.

---

# Appendix: Outstanding Issues (Post-Implementation)

All 7 phases have been implemented and committed. The following non-blocking issues remain.

## Phase 1 Outstanding Issues

### Re-Review — Medium (not blocking)
1. **M1** — `TradingAssignmentRow` extends `RuntimeAssignmentRow` but query selects `id` not `assignmentId`, creating latent type gap (harmless now, no code accesses `.assignmentId` on these rows)
2. **M2** — `chooseLatestAssignment` in `trading.ts` duplicates shared `chooseLatest` — can be unified by aliasing column as `assignmentId`

### Re-Review — Low (not blocking)
3. **L1** — O(n log n) sort used where O(n) scan suffices (no perf impact — tiny arrays)
4. **L2** — No unit tests for `chooseLatest` / `deriveReadiness`

---

## Phase 2 Outstanding Issues

### Medium (not blocking)
1. **setup.test.ts:311-312** — Duplicate assertion in Jupiter trading test; should assert venueAccount and resolvedVenueAccountId instead
2. **trading-provisioner.ts vs setup.test.ts** — Test mock returns `connectionId` property not in `TradingProvisionResult`; misleading
3. **setup.ts:38** — Stale JSDoc references "trading binding" instead of resolvedVenueAccountId

### Low (not blocking)
4. **setup.test.ts:148** — Stale `tradingBinding` assertion key still referenced
5. **connections.test.ts** — Missing assertion that generic POST /connections returns `resolvedVenueAccountId = null`
6. **trading-provisioner.ts:16-17** — Transition comment (good practice, no action needed)
7. **L3** — Stale dist build artifacts (gitignored, `pnpm build` regenerates)
8. **L4** — `_redisClient` parameter dead in `tradingCapabilityRoutes` (harmless)
9. **L5** — Audit endpoint returns ascending chronological order; UI might prefer descending

---

## Phase 3 Outstanding Issues

### Low (not blocking)
1. Missing code comment explaining why `agent_connections` rows aren't also marked `revoked` on connection revoke
2. UPDATE and SELECT not wrapped in a transaction during connection revoke — benign race, self-healing

---

## Phase 4 Outstanding Issues

### Medium (not blocking)
1. **M3** — `i18n-regressions.test.ts` references stale key `agents.capabilityPage.noBindings` (should be `noConnections`); regression test vacuously passes

### Low (not blocking)
2. **L1** — Test name "excludes a connection whose status is revoked (connectionStatus revoked is irrelevant)" is slightly misleading
3. **L2** — `ConnectionSummary` type declares `connectionStatus` as required but generic endpoint doesn't return it — shared type for two different endpoints

---

## Phase 5 Outstanding Issues

### Medium (not blocking)
1. Stale compiled output in `packages/db/dist/schema/` — orphaned `.d.ts`/`.js` for deleted capability-grants/capability-grant-audit. Run `pnpm --filter @herobids/db clean` + `pnpm build` to purge.
2. `agent-native-decision.integration.test.ts` TRUNCATE still references `capability_grants` — now resolved in Phase 6.

### Low (not blocking)
3. Stale comment in `apps/api/src/routes/agents.ts:483` mentioning `CapabilityGrant` (worker sandbox type — distinct from platform contract). Clarify with note.

---

## Phase 6 Outstanding Issues

### Medium (not blocking)
1. `capabilityGrantRows` is dead test data in `agents.test.ts` — 7 tests pass it but mock doesn't use it. Rename to `agentConnectionRows` at call sites.
2. Stale "capability grant" / "binding" comments in `agents.test.ts` (lines ~624, ~688, ~710)

### Low (not blocking)
3. Pre-existing build errors in `@herobids/api` (unrelated to this migration):
   - `credentials.ts:85` — `'venue' does not exist in type` (insert schema mismatch)
   - `credentials.ts:189` — `'provider' does not exist in type 'CredentialRotatedPayload'`
   - `credentials.ts:274` — `Property 'venue' does not exist`
   - `agents.ts:26` — `'venueAccounts' is declared but never read`
   - `trading.ts:149` — `'budgets' is declared but never read`

---

## Phase 8 Outstanding Issues (pre-existing)

### Medium (not blocking — follow-up sweep)
1. Test descriptions in unchanged test files still use "trading binding"
2. **M3** — Stale "grant"/"binding" terminology in domain types and test descriptions (partially addressed)
3. **N1** — Skill assignment sync is outside agent mutation transaction — rare partial-write risk

### Low
4. Stale comment in `apps/api/src/index.ts` line 207
5. Script comments in `agent-trade-test.ts` and `bot-trade-test.ts` use "trading binding"
6. **N2** — Test descriptions use stale "binding" language