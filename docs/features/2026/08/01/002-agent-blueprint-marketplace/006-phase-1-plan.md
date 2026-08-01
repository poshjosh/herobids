# 002 - Agent Blueprint Marketplace Phase 1 Plan

**Status:** Draft  
**Created:** 2026-08-01  
**Depends on:** [003-target-state-brief.md](./003-target-state-brief.md), [004-adr-list.md](./004-adr-list.md), [005-delivery-map.md](./005-delivery-map.md), [007-field-classification.md](./007-field-classification.md)  
**Prerequisite:** [003-agent-bot-config-harmonization](../003-agent-bot-config-harmonization/001-plan.md) — the shared `StrategyIdentity`, `RiskPosture`, and `ExecutionDefaults` value objects must land first; this plan builds the blueprint contract on them.

## Phase Goal

Ship the reusable marketplace core for blueprints so the platform has one installable, typed, attributable asset for reusable agents and bots.

## Assumptions

1. Backward compatibility is not required for any environment, including production.
2. Database and Redis state are reset on deploy via [scripts/shell/run/reset-and-run.sh](../../../../../../scripts/shell/run/reset-and-run.sh) (local) and [infra/hetzner/scripts/reset-and-run.sh](../../../../../../infra/hetzner/scripts/reset-and-run.sh) (server). No data migration or dual-write is required.
3. Phase 1 should optimize for the clean final model, not for migration bridges.

## Phase 1 Outcomes

1. A typed blueprint contract exists in shared domain code.
2. Blueprints are first-class marketplace assets in the database and API.
3. Save-as-blueprint and instantiate-from-blueprint are server-owned flows.
4. Agents and bots can be attributed back to source blueprints.
5. A thin user-facing discovery flow exists on the existing agents page as a browse-and-sort surface backed by published blueprints.

## Sub-Phase Split

The risky, novel work in Phase 1 is faithful projection and instantiation, not marketplace mechanics (the latter is already proven by skills). To validate the hard part first, Phase 1 is split:

- **Phase 1a — Faithful copy core.** Typed contract, schema for the asset + versioning + attribution, server-side projection, and instantiation. Exit when a copy is provably faithful per [007-field-classification.md](./007-field-classification.md).
- **Phase 1b — Marketplace mechanics.** Lifecycle, likes, forks, usage events, scoring, and the agents-page browse/sort surface. Reuses the proven skills pattern.

Work packages below are tagged `[1a]` or `[1b]`.

## Out of Scope

1. paid blueprint entitlements
2. public ratings and reviews
3. evaluation-derived ranking as a primary signal
4. shared marketplace abstractions unless Phase 1 proves they are necessary

## Work Packages

### 1. Lock the contract in code `[1a]`

**Goal**
Encode the blueprint model and agent strategy identity in shared domain types.

**Main changes**
1. Add typed blueprint schemas in `packages/domain/src/config/schema.ts`, composed from the shared `StrategyIdentity`, `RiskPosture`, and `ExecutionDefaults` value objects delivered by the harmonization prerequisite. Do not invent new strategy/risk/execution shapes here.
2. Export the new blueprint types from `packages/domain/src/config/index.ts`.
3. Rely on the first-class `StrategyIdentity` from the harmonization work for agent blueprints rather than the old `unifiedConfig` metadata sidecar (`extractPresetMeta` in `apps/api/src/routes/agents.ts`), which the harmonization plan removes.
4. Add domain tests in `packages/domain/src/config/schema.test.ts`.

**Payload structure**
The blueprint payload is a discriminated union on `kind` with a shared core plus a kind-specific extension:
- **Shared core:** `StrategyIdentity`, `RiskPosture`, `ExecutionDefaults` (the harmonized value objects), plus marketplace metadata and lineage on the blueprint row.
- **Agent extension:** prompt, skills, style, model policy, technical/intelligence config, wake preferences, escalation policy, capital defaults.
- **Bot extension:** venue/symbol/venueType/swapAssets shape expectations (minus the instance-only venue-account binding).

**Column vs payload decision**
The typed recipe lives in a validated JSONB payload (replacing opaque `configData`). A small set of query facets is denormalized to indexed blueprint columns for filter/sort: `kind`, `strategyId`, `style`, `tags`. All other recipe fields stay in the typed payload. This satisfies the "queryable without metadata guessing" success criterion without exploding the schema.

**Validation**
1. blueprint payload tests cover agent and bot kinds
2. invalid payloads fail at the schema boundary
3. strategy identity is queryable via a typed column, not a metadata string
4. the shared core reuses the harmonized value objects verbatim (no forked strategy/risk/execution definitions)

### 2. Evolve the database model `[1a]` (schema, versioning, attribution) / `[1b]` (likes, usage)

**Goal**
Make the existing `blueprints` table the marketplace asset model.

**Main changes**
1. Expand `packages/db/src/schema/blueprints.ts` with `kind`, query-facet columns (`strategyId`, `style`, `tags`), lifecycle (`publicationStatus`, `publishedAt`, `delistedAt`, `archivedAt`), lineage (`forkOf`/`sourceBlueprintId`), ranking (`likeCount`, `forkCount`, `popularityScore`, `trendingScore`), and `currentRevisionId`. Replace the legacy `visibility` column with `publicationStatus` — no backward-compat shim is needed.
2. Add a `blueprint_revisions` table mirroring `skill_revisions` (immutable versioned payload snapshots, `uniqueIndex(blueprintId, version)`). Versioning is retained, not dropped — published blueprints must be forkable and reproducible by revision.
3. Add `blueprint_likes` and `blueprint_usage_events` schema files and exports, mirroring the skills equivalents.
4. Add symmetric attribution on both instance tables: give `agents` and `bots` each a nullable `blueprintId` FK (`onDelete: 'set null'`) plus a `blueprintRevisionId` FK. `bots` already has `blueprintId` + `configSnapshot`; it gains `blueprintRevisionId` so both actors record the exact revision instantiated. ADR 004 requires attribution to be persisted, so this is not optional.
5. Generate the Drizzle migration under `packages/db/drizzle/` for the clean replacement model.

**Validation**
1. schema compiles and Drizzle artifacts generate cleanly
2. new fields support publish, fork, like, ranking, and revision use cases
3. agent and bot rows can both carry queryable blueprint attribution
4. no dual-write or compatibility-only fields are introduced

### 3. Expand the blueprint API `[1b]`

**Goal**
Turn blueprints into an authoritative authoring and marketplace backend.

**Main changes**
1. Extend `apps/api/src/routes/blueprints.ts` with list, filter, sort, publish, delist, archive, fork, like, and instantiate flows.
2. Duplicate the ranking helpers (`scoreFromMetrics`, periodic recompute) from `apps/api/src/routes/skills.ts` for now — they are private to the skills route. Extracting a shared helper is deferred to Phase 2 per the delivery map; duplication is the intended Phase 1 choice.
3. Preserve preset helper routes (`/blueprints/presets`, `/from-preset`, `/defaults`) only where they feed the typed blueprint contract. These currently emit bot strategy configs; map them onto the bot blueprint `kind` and do not use them for agent blueprints.
4. Add route tests in `apps/api/src/routes/blueprints.test.ts`.

**Validation**
1. route tests cover lifecycle and access control
2. score recomputation works for blueprint usage events and likes
3. browse and authoring routes operate on typed fields, not opaque blobs only

### 4. Add server-side projection rules `[1a]`

**Goal**
Make blueprint save and apply behavior complete and deterministic.

**Main changes**
1. Add projection helpers near `apps/api/src/routes/agents.ts` and bot creation handlers.
2. Include every template-eligible field and exclude every instance-only field per [007-field-classification.md](./007-field-classification.md). That table is the authoritative manifest for this work package.
3. Handle the three split fields explicitly (`unifiedConfig`, `executionMode`, `notificationPolicy`) as specified in the classification doc.
4. Add tests proving inclusion, exclusion, and correct split-field decomposition, asserting field-by-field against the classification table.

**Validation**
1. saved blueprints preserve every template-eligible behavior field
2. excluded fields do not leak into stored blueprint payloads
3. split fields are decomposed correctly (authored half kept, runtime/private half dropped)
4. the browser does not own template selection logic

### 5. Add instantiation and attribution flows `[1a]`

**Goal**
Allow users to create runnable instances by supplying only missing private bindings.

**Main changes**
1. Add `instantiate-agent` and `instantiate-bot` flows to the blueprint backend.
2. Preserve bot snapshots in `bots.configSnapshot` and source attribution via `bots.blueprintId` + `bots.blueprintRevisionId`.
3. Persist agent attribution via `agents.blueprintId` + `agents.blueprintRevisionId` (the committed shape from WP2). Attribution records the exact revision instantiated.
4. Require only missing private inputs during instantiation. Return the resolved template-eligible field set (including inherited risk limits) so the installer can review and edit before creating the instance, per the editable-copy rule in [007-field-classification.md](./007-field-classification.md).
5. Force `executionMode: paper` on instantiation unless the installer supplies a live connection binding and explicitly opts in.
6. Gate instantiation on `kind`: a `bot` blueprint creates a bot, an `agent` blueprint creates an agent.

**Validation**
1. a blueprint can create a runnable agent or bot with only private binding inputs added
2. agent and bot attribution (blueprint id + revision) is persisted for later usage and ranking signals
3. missing required bindings fail with clear API errors
4. inherited risk limits are surfaced to the installer and are editable before instantiation

### 6. Add thin but real UI flows `[1b]`

**Goal**
Expose the new asset model in the product without making blueprint browsing the primary user mental model.

**Main changes**
1. Extend the existing agents page ([apps/web/src/features/agents/AgentsPage.tsx](../../../../../../apps/web/src/features/agents/AgentsPage.tsx)) with scope tabs mirroring the skills marketplace pattern: `All agents` (published, blueprint-backed) and `My agents`. Do not introduce a separate leaderboard route or blueprint-first navigation.
2. Add a `sort by` control on the `All agents` tab supporting at least P&L, popularity, trending, and newest. Because ranking blends performance and marketplace signals, this is a sortable browse surface, not a fixed "leaderboard".
3. Back each published, browsable agent card with its published blueprint so every copy action resolves to a stable blueprint-backed install flow.
4. Extend `apps/web/src/lib/api-client.ts` with the methods needed for scoped agent listing, sorting, and blueprint-backed copy flows.
5. Add user-facing actions such as `Use this agent` or `Create my own version` rather than exposing blueprint terminology as the primary CTA. The copy action opens the review-and-edit step (WP5) before creating the instance.
6. Add save-as-blueprint / publish entry points from agent and bot surfaces for creators and internal authoring flows.

**Validation**
1. users can browse the agents page, switch between `All agents` and `My agents`, and sort by P&L or popularity
2. users can select a published agent and create their own version from its backing blueprint
3. UI tests cover tab and sort wiring, copy-action wiring, and payload application behavior
4. flows are functional even if the underlying blueprint asset remains mostly invisible to end users

## Sequencing

**Phase 1a (faithful copy core):**
1. domain contract (WP1)
2. database model — asset, versioning, attribution (WP2)
3. server-side projection rules (WP4)
4. instantiation and attribution flows (WP5)
5. faithful-copy end-to-end verification

**Phase 1b (marketplace mechanics):**
6. backend routes and scoring — lifecycle, likes, forks, usage (WP2 likes/usage tables + WP3)
7. thin UI flows on the agents page (WP6)
8. end-to-end verification

## Verification Matrix

### Contract

1. Blueprint payload validation passes for valid agent and bot templates.
2. Invalid strategy identity or kind combinations are rejected.

### Data model

1. Blueprints support lifecycle, lineage, likes, usage events, and versioned revisions.
2. Agent and bot attribution (blueprint id + revision) are stored in a queryable way.

### Behavior

1. Save-as-blueprint excludes private and runtime-only fields per the classification manifest.
2. Split fields (`unifiedConfig`, `executionMode`, `notificationPolicy`) are decomposed correctly.
3. Instantiate-from-blueprint requires only missing private bindings.
4. Copied instances preserve material behavior, including inherited risk limits.

### Product flow

1. A user can browse the agents page and switch between `All agents` and `My agents`.
2. A user can sort the `All agents` tab by P&L, popularity, trending, or newest.
3. A user can select a published agent and create their own version from its backing blueprint.
4. Creator-facing flows can publish or save the backing blueprint without requiring end users to navigate a blueprint marketplace page.

## Acceptance Criteria

1. Blueprints are the canonical marketplace asset in both code and docs.
2. Phase 1 ships a typed, attributable, reusable blueprint model end to end.
3. The implementation does not carry compatibility scaffolding that only exists to preserve obsolete state.
4. Later phases can build on the asset model without reopening the core contract.

## Risks

1. Missing template-eligible policy can still create silent drift between original and copied instances. Mitigated by the field-by-field manifest in [007-field-classification.md](./007-field-classification.md) and its verification hook.
2. The three split fields (`unifiedConfig`, `executionMode`, `notificationPolicy`) are the highest-risk projection cases; incorrect decomposition either leaks runtime state or loses authored behavior.
3. Agent attribution is committed early (WP2) so usage and ranking (WP3/WP6) have a stable foundation.
4. A thin UI can still fail if backend projection rules are incomplete; Phase 1a must be accepted before Phase 1b UI work relies on it.

## Deferred To Phase 2

1. entitlements and purchase flow
2. richer discovery and merchandising
3. evaluation-derived public quality signals
4. refactors that extract generic marketplace helpers after the Phase 1 behavior is proven
