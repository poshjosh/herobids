## Plan: Rewrite Blueprint Unit Tests For The Revision-Based API

**Status:** Proposed
**Scope:** Rewrite `apps/api/src/routes/blueprints.test.ts` so it matches the current revision-based blueprint API, then re-enable the skipped coverage and fix the remaining mock-driven failures in the preset/default route tests.

**Depends on:**
- [docs/bug-reports/2026/08/03/006-blueprint-unit-tests-schema-migration-debt.md](../../../bug-reports/2026/08/03/006-blueprint-unit-tests-schema-migration-debt.md)
- [apps/api/src/routes/blueprints.ts](../../../../../../apps/api/src/routes/blueprints.ts)
- [packages/domain/src/blueprint.ts](../../../../../../packages/domain/src/blueprint.ts)
- [packages/db/src/schema/blueprints.ts](../../../../../../packages/db/src/schema/blueprints.ts)
- [packages/db/src/schema/blueprint-revisions.ts](../../../../../../packages/db/src/schema/blueprint-revisions.ts)

**TL;DR:** The blueprint API is no longer flat CRUD. It is now revision-based, cursor-paginated, and lifecycle-aware. The current unit test file is half-migrated: the legacy CRUD groups are skipped, while the preset/default groups still fail because the route registration timer hits a mock that does not fully emulate Drizzle. The right fix is to rebuild the test fixture layer around the current schema, restore the skipped groups one by one, and make the mock resilient enough to support the score refresh timer without hiding real route behavior.

---

## Problem

`apps/api/src/routes/blueprints.test.ts` is still structured around the pre-rewrite blueprint contract. That contract no longer exists. The file currently has:

- 28 skipped tests that target deleted or redesigned endpoints;
- 5 surviving tests that still pass only because they were stubbed or happen to align with the new route surface;
- 3 failing preset/default tests that fail at route registration time because `blueprintRoutes()` starts a `scoreRefreshTimer` and the mock DB does not fully emulate the query shape used there.

The test debt is now structural, not local. Incrementally fixing individual assertions will keep producing mismatches unless the file is rewritten around the new schema and revision model.

---

## Current Code Truth

1. `POST /blueprints` now expects a strict payload shaped like `{ payload: { kind, ... } }`, not flat `name` / `configData` fields.
2. `GET /blueprints` now returns `{ items, nextCursor }`, not `{ blueprints }`.
3. `GET /blueprints/:id` resolves a target revision via `resolveTargetRevision()` and joins `blueprints` with `blueprintRevisions`.
4. `PUT /blueprints/:id` no longer exists; edits happen through `POST /blueprints/:id/revisions`.
5. `DELETE /blueprints/:id` is lifecycle-aware and only allows draft-only hard delete after reference checks and FK cycle breaking.
6. `POST /blueprints/:id/clone` is fork-based and uses the revision model, idempotency, and `BlueprintForkRequestSchema` semantics.
7. `POST /blueprints/:id/publish` and `/unpublish` now use revision-aware lifecycle transitions.
8. `POST /bots` with `blueprintId` must treat blueprint revisions as the source of config, not the legacy `configData` snapshot.
9. The preset/default handlers are fine in production; the test failure is caused by the unit-test DB mock not fully supporting the route registration timer query (`db.select().from(blueprints)` in `scoreRefreshTimer`).

---

## Recommended Rewrite Strategy

### 1. Rebuild the fixture layer first

Create a small test fixture helper for the new schema instead of reusing the old `stubBlueprint` shape.

The fixture set should include at minimum:
- a catalog blueprint row (`authorId`, `publicationStatus`, `kind`, `currentRevisionId`, `publishedRevisionId`, etc.);
- a matching immutable revision row;
- a helper for generating published / draft / private / delisted variants;
- a helper for blueprint revision payloads for agent and bot cases.

This should replace the current legacy `configData`-era assumptions and make the rest of the rewrite straightforward.

### 2. Fix the mock infrastructure once, not per test

Update `buildDb()` / `makeChain()` so the mock can support the route-registration query used by `scoreRefreshTimer`.

Minimum requirements:
- `select({ id: blueprints.id }).from(blueprints)` must resolve cleanly;
- `select().from(blueprints)` and `select().from(blueprintRevisions)` must both work;
- `transaction()` should remain supported;
- `update().set().where()` should support the revision pointer updates used in create/revision/fork flows.

If the timer query is still awkward in the mock after that, isolate it by making the mock return an empty result for the timer path rather than allowing it to throw.

### 3. Restore the preset/default coverage

Unskip and verify the three early route groups:
- `GET /blueprints/presets`
- `GET /presets/for-agent`
- `GET /blueprints/defaults`

These should be cheap wins once the mock stops failing at registration time.

### 4. Rewrite the listing and detail tests against the new response contract

Replace the legacy CRUD assertions with the current API shape:
- `GET /blueprints` should assert `items` and `nextCursor`;
- `GET /blueprints/:id` should assert revision-derived fields from `blueprints + blueprintRevisions`;
- marketplace visibility assertions should use `publicationStatus`, `authorId`, and revision selection rules instead of `visibility` / `userId`.

### 5. Rewrite create/edit lifecycle tests around revisions

Replace the legacy PUT coverage with current revision lifecycle tests:
- `POST /blueprints` should send a strict `{ payload: ... }` body and assert creation of both catalog row and revision row;
- `POST /blueprints/:id/revisions` should cover stale revision detection and successful revision creation;
- `POST /blueprints/:id/publish` and `/unpublish` should assert revision-aware lifecycle transitions;
- `DELETE /blueprints/:id` should cover draft-only deletion, in-use conflicts, and ownership rules.

### 6. Rewrite fork and bot integration tests

Update the fork tests to follow the new FK-safe flow and revision-based copy semantics.
Update the bot tests to use the blueprint revision payload rather than legacy `configData` / `configSnapshot` assumptions.

### 7. Verify behavior in the right order

Run the test file in slices as the rewrite proceeds:
1. preset/default smoke tests;
2. list/detail/create tests;
3. revision lifecycle tests;
4. delete/fork/publish tests;
5. bot-with-blueprint tests.

Then run the full blueprint unit test file and `pnpm lint`.

---

## Acceptance Criteria

1. `apps/api/src/routes/blueprints.test.ts` no longer contains skipped tests for the legacy CRUD groups.
2. All blueprint unit tests pass against the current revision-based API.
3. The preset/default tests pass without registration-time mock crashes.
4. The test file’s fixtures reflect `authorId`, `publicationStatus`, `currentRevisionId`, `publishedRevisionId`, and revision payloads.
5. `pnpm lint` passes after the rewrite.

---

## Files Likely To Change

- `apps/api/src/routes/blueprints.test.ts`
- Possibly a new test fixture helper under `apps/api/src/routes/` or `apps/api/src/__tests__/helpers/`
- Possibly `apps/api/src/routes/blueprints.ts` only if the test mock needs a small test-only seam for the timer path; otherwise the route code should stay untouched.

---

## Suggested Order Of Work

1. Fix the unit-test DB mock so the timer query stops crashing the preset/default tests.
2. Add revision-based fixtures.
3. Unskip and rewrite the preset/default and list/detail/create tests.
4. Rewrite the revision lifecycle tests.
5. Rewrite the fork and bot tests.
6. Remove any remaining legacy assertions and `describe.skip` blocks.
7. Validate with the full unit test file and `pnpm lint`.
