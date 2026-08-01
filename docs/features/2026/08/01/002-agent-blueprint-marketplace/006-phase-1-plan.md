# 010 - Agent Blueprint Marketplace Phase 1 Plan

**Status:** Draft  
**Created:** 2026-08-01  
**Depends on:** [003-target-state-brief.md](./003-target-state-brief.md), [004-adr-list.md](./004-adr-list.md), [005-delivery-map.md](./005-delivery-map.md)

## Phase Goal

Ship the reusable marketplace core for blueprints so the platform has one installable, typed, attributable asset for reusable agents and bots.

## Assumptions

1. Backward compatibility is not required.
2. Database and Redis state may be reset.
3. Phase 1 should optimize for the clean final model, not for migration bridges.

## Phase 1 Outcomes

1. A typed blueprint contract exists in shared domain code.
2. Blueprints are first-class marketplace assets in the database and API.
3. Save-as-blueprint and instantiate-from-blueprint are server-owned flows.
4. Agents and bots can be attributed back to source blueprints.
5. A thin UI exists for browse, publish, fork, and use.

## Out of Scope

1. paid blueprint entitlements
2. public ratings and reviews
3. evaluation-derived ranking as a primary signal
4. shared marketplace abstractions unless Phase 1 proves they are necessary

## Work Packages

### 1. Lock the contract in code

**Goal**
Encode the blueprint model and agent strategy identity in shared domain types.

**Main changes**
1. Add typed blueprint schemas in `packages/domain/src/config/schema.ts`.
2. Export the new blueprint types from `packages/domain/src/config/index.ts`.
3. Add a first-class strategy section for agent blueprint payloads rather than relying on metadata sidecars.
4. Add domain tests in `packages/domain/src/config/schema.test.ts`.

**Validation**
1. blueprint payload tests cover agent and bot kinds
2. invalid payloads fail at the schema boundary
3. strategy identity is queryable without inspecting metadata strings

### 2. Evolve the database model

**Goal**
Make the existing `blueprints` table the marketplace asset model.

**Main changes**
1. Expand `packages/db/src/schema/blueprints.ts` with kind, lifecycle, lineage, and ranking fields.
2. Add `blueprint_likes` and `blueprint_usage_events` schema files and exports.
3. Add lightweight attribution support for agent instances if required by the accepted ADRs.
4. Generate the Drizzle migration under `packages/db/drizzle/` for the clean replacement model.

**Validation**
1. schema compiles and Drizzle artifacts generate cleanly
2. new fields support publish, fork, like, and ranking use cases
3. no dual-write or compatibility-only fields are introduced without explicit justification

### 3. Expand the blueprint API

**Goal**
Turn blueprints into an authoritative authoring and marketplace backend.

**Main changes**
1. Extend `apps/api/src/routes/blueprints.ts` with list, filter, sort, publish, delist, archive, fork, like, and instantiate flows.
2. Reuse or parallel the ranking logic proven in `apps/api/src/routes/skills.ts`.
3. Preserve preset helper routes only where they feed the typed blueprint contract.
4. Add route tests in `apps/api/src/routes/blueprints.test.ts`.

**Validation**
1. route tests cover lifecycle and access control
2. score recomputation works for blueprint usage events and likes
3. browse and authoring routes operate on typed fields, not opaque blobs only

### 4. Add server-side projection rules

**Goal**
Make blueprint save and apply behavior complete and deterministic.

**Main changes**
1. Add projection helpers near `apps/api/src/routes/agents.ts` and bot creation handlers.
2. Include template-eligible policy and config fields in the projection.
3. Exclude secrets, private bindings, runtime state, and per-user destinations.
4. Add tests proving both inclusion and exclusion rules.

**Validation**
1. saved blueprints preserve material behavior fields
2. excluded fields do not leak into stored blueprint payloads
3. the browser does not own template selection logic

### 5. Add instantiation and attribution flows

**Goal**
Allow users to create runnable instances by supplying only missing private bindings.

**Main changes**
1. Add `instantiate-agent` and `instantiate-bot` flows to the blueprint backend.
2. Preserve bot snapshots in `bots.configSnapshot` and source attribution via `bots.blueprintId`.
3. Persist agent attribution in the chosen Phase 1 shape.
4. Require only missing private inputs during instantiation.

**Validation**
1. a blueprint can create a runnable agent or bot with only private binding inputs added
2. attribution is persisted for later usage and ranking signals
3. missing required bindings fail with clear API errors

### 6. Add thin but real UI flows

**Goal**
Expose the new asset model in the product without waiting for rich merchandising.

**Main changes**
1. Add a `blueprints` feature area in the web app.
2. Extend `apps/web/src/lib/api-client.ts` with blueprint marketplace methods.
3. Add browse, publish, fork, and use flows.
4. Add save-as-blueprint entry points from agent and bot surfaces.

**Validation**
1. users can complete publish to fork to instantiate from the UI
2. UI tests cover route registration and payload application behavior
3. thin flows are functional even if presentation remains basic

## Sequencing

1. domain contract
2. database model
3. backend routes and scoring
4. projection rules
5. instantiation and attribution
6. thin UI flows
7. end-to-end verification

## Verification Matrix

### Contract

1. Blueprint payload validation passes for valid agent and bot templates.
2. Invalid strategy identity or kind combinations are rejected.

### Data model

1. Blueprints support lifecycle, lineage, likes, and usage events.
2. Agent and bot attribution are stored in a queryable way.

### Behavior

1. Save-as-blueprint excludes private and runtime-only fields.
2. Instantiate-from-blueprint requires only missing private bindings.
3. Copied instances preserve material behavior.

### Product flow

1. A user can browse blueprints.
2. A user can publish and fork a blueprint.
3. A user can create a new agent or bot from a blueprint without manual payload assembly.

## Acceptance Criteria

1. Blueprints are the canonical marketplace asset in both code and docs.
2. Phase 1 ships a typed, attributable, reusable blueprint model end to end.
3. The implementation does not carry compatibility scaffolding that only exists to preserve obsolete state.
4. Later phases can build on the asset model without reopening the core contract.

## Risks

1. Missing template-eligible policy can still create silent drift between original and copied instances.
2. Agent attribution must be decided early enough to support usage and ranking later.
3. A thin UI can still fail if backend projection rules are incomplete.

## Deferred To Phase 2

1. entitlements and purchase flow
2. richer discovery and merchandising
3. evaluation-derived public quality signals
4. refactors that extract generic marketplace helpers after the Phase 1 behavior is proven
