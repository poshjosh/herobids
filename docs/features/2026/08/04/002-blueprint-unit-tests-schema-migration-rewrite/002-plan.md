## Plan: Rewrite Blueprint Unit Tests For The Revision-Based API

**Status:** Implemented (2026-08-04)
**Scope:** Rewrite `apps/api/src/routes/blueprints.test.ts` so it matches the current revision-based blueprint API, diagnose (not assume) the three currently-skipped preset/default failures, and re-enable the legacy CRUD groups that were skipped during the schema migration. Net-new lifecycle/like endpoints that never had unit coverage are explicitly out of scope for this pass (see "Out Of Scope").

**Depends on:**
- [docs/bug-reports/2026/08/03/006-blueprint-unit-tests-schema-migration-debt.md](../../../bug-reports/2026/08/03/006-blueprint-unit-tests-schema-migration-debt.md)
- [apps/api/src/routes/blueprints.ts](../../../../../../apps/api/src/routes/blueprints.ts)
- [apps/api/src/routes/blueprints.test.ts](../../../../../../apps/api/src/routes/blueprints.test.ts) (file being rewritten)
- [apps/api/src/routes/blueprints.integration.test.ts](../../../../../../apps/api/src/routes/blueprints.integration.test.ts) (existing, real-DB coverage — see "Relationship To Integration Tests")
- [apps/api/src/services/blueprint-scoring.ts](../../../../../../apps/api/src/services/blueprint-scoring.ts)
- [packages/domain/src/blueprint.ts](../../../../../../packages/domain/src/blueprint.ts)
- [packages/db/src/schema/blueprints.ts](../../../../../../packages/db/src/schema/blueprints.ts)
- [packages/db/src/schema/blueprint-revisions.ts](../../../../../../packages/db/src/schema/blueprint-revisions.ts)

**TL;DR:** The blueprint API is no longer flat CRUD. It is revision-based, cursor-paginated, and lifecycle-aware, with several routes doing multi-table, multi-step reads/writes (raw `sql` reference-count checks, advisory locks, post-commit scoring side effects). The current unit test file is half-migrated: legacy CRUD groups are skipped outright, and three unrelated preset/default tests are also skipped behind a FIXME that blames a 60-minute background timer — a theory that does not hold up against how `setInterval` and the test's timer configuration actually behave. The right fix is to (1) actually diagnose the preset/default failures before touching anything, (2) rebuild the DB mock as a table-aware fake instead of a two-bucket call counter, and (3) restore the skipped legacy groups against the real current contract, endpoint names, and lifecycle model.

---

## Problem

`apps/api/src/routes/blueprints.test.ts` is still structured around the pre-rewrite blueprint contract, which no longer exists. The file currently has:

- 28 tests skipped via `describe.skip`, targeting deleted or redesigned endpoints (flat CRUD, `visibility`, `configData`, `PUT /blueprints/:id`, `/clone`);
- 3 additional tests skipped (`GET /blueprints/presets`, `GET /blueprints/defaults`, `GET /presets/for-agent`) behind FIXME comments asserting they fail because of a periodic score-refresh timer hitting the DB mock at route-registration time;
- 5 tests that currently pass, 4 of which only assert a `501 not_implemented` stub response for `POST /blueprints/from-preset` (intentionally unimplemented pending a separate milestone) and 1 that tests preset rejection logic unrelated to the DB.

The test debt is structural. Incremental assertion patching will keep failing until the fixture layer, the DB mock, and the endpoint/response contracts are rebuilt around the real schema.

---

## Current Code Truth

Verified directly against `apps/api/src/routes/blueprints.ts` (all line numbers approximate, re-check against HEAD before use):

1. `POST /blueprints` expects a strict payload shaped like `{ payload: { kind, name, ... }, skills? }` (`CreateBlueprintSchema`), not flat `name` / `configData` fields. It performs an insert-then-update sequence inside a transaction (insert blueprint with `currentRevisionId: null` → insert revision → update blueprint's `currentRevisionId`) to satisfy the non-deferrable FK, then re-selects both rows plus the revision's skill refs to build the response.
2. `GET /blueprints` is a **marketplace browse** endpoint, not an owner-scoped listing. It hard-filters to `publicationStatus = 'published' AND publishedRevisionId IS NOT NULL`, applies optional `kind`/`strategyType`/`style`/`venueType`/`tags` filters, cursor-based pagination (`encodeBlueprintCursor`/`decodeBlueprintCursor`), and gates non-admin callers on `resolvePlanBlueprintEntitlements(...).canViewMarketplaceBlueprints`. It returns `{ items, nextCursor }`, not `{ blueprints }`. Fixtures for this endpoint must set `publicationStatus: 'published'` with a non-null `publishedRevisionId`, or the WHERE clause will legitimately return zero rows regardless of mock plumbing.
3. `GET /blueprints/:id` resolves access and revision selection via `resolveTargetRevision()`: owners/admins may request any revision by `?revisionId=`, non-owners are restricted to `publishedRevisionId` and receive `404 NOT_FOUND` for delisted/archived/unpublished blueprints. It joins `blueprints` with `blueprintRevisions` and applies the same marketplace entitlement gate as `GET /blueprints` for non-owner access to published blueprints.
4. **There is no `PUT /blueprints/:id`.** Editing happens through `POST /blueprints/:id/revisions` (not covered by this plan's currently-skipped groups, since no such group exists in the file today — see "Out Of Scope").
5. `DELETE /blueprints/:id` only hard-deletes **draft** blueprints that have never been published (`publicationStatus === 'draft' && publishedRevisionId === null && publishedAt === null`). Inside a transaction it re-locks the row with `.for('update')`, runs five raw `tx.execute(sql\`...\`)` reference-count checks (likes, usage events, fork requests where it is the source, agents, bots) that each return `409 LIFECYCLE_CONFLICT` on any nonzero count, then breaks the FK pointer cycle (`currentRevisionId`/`publishedRevisionId` → `null`) before deleting revision-skills, revisions, and the blueprint row.
6. **There is no `/clone` endpoint.** The correct route is `POST /blueprints/:id/fork` — idempotent via a required `Idempotency-Key` header (1–200 printable ASCII chars, validated before body parsing), `BlueprintForkRequestSchema`, a Postgres advisory transaction lock (`tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtext(...))\`)`), a stored-request-hash replay check against `blueprintForkRequests`, deep-merge of optional `edits` via `deepMergeEdits()`, insert of blueprint + revision + (for agent kind) revision skills + a `blueprintUsageEvents` row, and post-commit `refreshForkCount()` + `recomputeBlueprintScores()` calls that each issue their own raw `sql` queries against `db` (not `tx`).
7. **There is no `/unpublish` endpoint.** Lifecycle transitions are five separate routes with an explicit allow-list (`ALLOWED_TRANSITIONS`): `POST /blueprints/:id/publish` (draft/private/delisted → published, requires `expectedCurrentRevisionId` to match the blueprint's current revision, validates skill portability for `kind: 'agent'`, copies revision facets onto the blueprint row), `POST /blueprints/:id/draft`, `POST /blueprints/:id/private`, `POST /blueprints/:id/delist`, and `POST /blueprints/:id/archive` (terminal). Each checks ownership/admin and the transition allow-list before mutating.
8. `POST /bots` with `blueprintId` (`apps/api/src/routes/bots.ts`) resolves config via `innerJoin(blueprintRevisions, eq(blueprints.currentRevisionId, blueprintRevisions.id))` and reads `blueprintRevisions.payload` as the config source — not the legacy `configData`/flat snapshot. Omitting `blueprintId` still works through a deprecated inline-config path that sets a `Deprecation` response header.
9. `GET /blueprints/presets`, `GET /blueprints/defaults`, and `GET /presets/for-agent` call only `listPresets()` / `getPreset()` / `applyPresetToAgent()` (`packages/domain/src/config/presets-loader.ts` and preset-application logic) — **none of these three handlers touch `db` at all.** The periodic `scoreRefreshTimer` inside `blueprintRoutes()` is registered via `setInterval(..., 60 * 60 * 1000)` and only invoked on an `onClose` hook for cleanup; it cannot fire synchronously during route registration, and the test file never calls `vi.useFakeTimers()`. The existing FIXME comments blaming this timer for the three failures are almost certainly describing the wrong root cause — see step 1 below.

---

## Relationship To Integration Tests

`apps/api/src/routes/blueprints.integration.test.ts` already exercises this same route surface against a real (or fuller) database, with `describe` blocks for Lifecycle, Browse & Retrieve, Fork, Like/Unlike, Authoring, Authorization, Error Codes, Scoring, and Entitlement Enforcement.

This unit-test rewrite is **complementary, not a replacement**: it exists to give fast, isolated feedback on route-level branching (validation errors, ownership checks, status-code selection, response shaping) without spinning up a real database. Overlap with integration-test scenarios is acceptable and expected — do not skip writing a unit-level assertion just because an equivalent integration test exists. Do not port scoring-math or long-window (`90d`/`30d`) behavior assertions into the unit file; those are integration-test territory (`blueprint-scoring.ts` computations, real timestamps) and are out of scope here.

---

## Out Of Scope

The following endpoints have **zero unit-test coverage today** (not skipped — never referenced in `blueprints.test.ts`) and are **not** part of this rewrite: `POST /blueprints/:id/draft`, `POST /blueprints/:id/private`, `POST /blueprints/:id/delist`, `POST /blueprints/:id/archive`, `PUT /blueprints/:id/like`, `DELETE /blueprints/:id/like`, `GET /blueprints/:id/revisions`. These already have integration coverage (`blueprints.integration.test.ts`). Adding unit coverage for them is a reasonable follow-up but should be tracked as a separate, explicitly-scoped plan so this rewrite stays focused on clearing the documented skip/fail debt.

---

## Recommended Rewrite Strategy

### 1. Diagnose the preset/default failures before changing anything — DONE (2026-08-04)

The `scoreRefreshTimer`/mock theory was wrong, confirmed by un-skipping and running the three tests in isolation. Two real production bugs were found and fixed; no DB mock changes were needed for this group.

**Root cause A — cwd-dependent preset path resolution:**
`packages/domain/src/config/presets-loader.ts`'s `resolveConfigPath()` resolves `config/strategy-presets/*.yaml` relative to `process.cwd()` unless `HEROBIDS_CONFIG_DIR` is set. Running `blueprints.test.ts` via `pnpm --filter @herobids/api` sets cwd to `apps/api`, not the repo root, so the YAML files 404 (`ENOENT`). `apps/api/src/routes/agents.test.ts` already had the fix for this exact issue (setting `process.env['HEROBIDS_CONFIG_DIR']` to the repo root at the top of the file, via `dirname(fileURLToPath(import.meta.url))` + `resolve(__dirname, '../../../..')`) — `blueprints.test.ts` was simply missing it. Fixed by adding the same lines to `blueprints.test.ts`. Prod/docker already sets `HEROBIDS_CONFIG_DIR=/app` (see Dockerfiles / `docker-compose.dev.yaml`), so this is a test-only gap, not a prod bug — see `docs/bug-reports/2026/07/03/001-preset-yaml-enoent-docker.md` for the original prod-side incident of the same class.

**Root cause B — cache-poisoning bug in `presets-loader.ts` (real prod bug, now fixed):**
`loadPresets()` assigned `cache = new Map()` *before* the load loop ran, then populated it entry-by-entry. If `readFileSync`/YAML-parse/Zod-validation threw partway through the loop (e.g. root cause A's `ENOENT` on the first style file), `cache` was already a non-null (but incomplete/empty) `Map` — so every subsequent call in the same process returned this permanently poisoned empty map instead of retrying or throwing again. This is why the three tests showed *different* status codes (500, 500, 404) from one root cause: whichever test ran first hit the real thrown error (500), and the other two silently got the poisoned empty cache (`getPreset()` returning `undefined` → 404 or 500 depending on the handler's own not-found branch). Fixed in `packages/domain/src/config/presets-loader.ts` by building into a local `loading` map inside a `try`, only assigning `cache = loading` after the full loop succeeds, and resetting `cache = null` in the `catch` before re-throwing so the next call retries instead of reusing a partial result.

**Verification:** all 4 tests (the 3 preset/default tests + the pre-existing `POST /blueprints/from-preset` group) pass; the full `blueprints.test.ts` file reports `8 passed | 24 skipped` (the 24 are the legacy CRUD groups covered by steps 2–10 below, correctly still skipped); `packages/domain/src/config/presets.test.ts` (31 tests) still passes unaffected; `pnpm lint` passes. The stale FIXME comments blaming the timer have been deleted from `blueprints.test.ts`.

**Files changed by this step (already applied, not pending):**
- `apps/api/src/routes/blueprints.test.ts` — added `HEROBIDS_CONFIG_DIR` setup (matching `agents.test.ts`), un-skipped the 3 preset/default `describe` blocks, removed stale FIXME comments.
- `packages/domain/src/config/presets-loader.ts` — fixed `loadPresets()` to not poison the cache on a failed/partial load.

### 2. Rebuild the DB mock as a table-aware fake, not a call-count fake

Replace `makeChain()` / `buildDb(selectRows, subsequentRows)` (which only distinguishes "1st select call" vs. "every call after") with a mock that dispatches by table/operation, because real requests in this route file issue three-plus differently-shaped sequential selects and several raw-SQL calls per request (e.g. `POST /blueprints`: select blueprint → select revision → select revision-skills; `POST /blueprints/:id/fork`: select fork-requests → select+lock blueprint → insert × 5 → update → post-commit raw-`sql` scoring queries → re-select blueprint → re-select revision → select revision-skills).

Minimum requirements:
- **Table-scoped responses**: `db.select(...).from(TABLE)...` resolves from a per-table, ordered response queue (or a keyed in-memory row store) that the test configures per table — not a single global counter.
- **Raw SQL execute**: both `db.execute(sql\`...\`)` and `tx.execute(sql\`...\`)` must be mockable and default to a safe empty/zero shape (e.g. `[{ cnt: 0 }]` for count queries) unless a test overrides it — most tests should not need to enumerate every internal scoring/reference-check query by hand.
- **Row locking**: `.for('update')` must be chainable and resolve like any other terminal select.
- **Joins**: `.innerJoin` / `.leftJoin` must remain supported (already present).
- **Transactions**: `db.transaction(fn)` must run `fn` against a `tx` that shares the same table-aware dispatch as `db` (fork and delete both read/write inside a transaction and then read again outside it).
- **Writes**: `insert().values()`, `update().set().where()`, `delete().where()` can remain simple resolved-`undefined` stubs — no route in this file reads an insert/update return value; every handler re-selects after writing.

If, after this rebuild, a specific preset/default test still fails for a reason connected to route registration (not the timer), isolate and fix that — don't paper over it by special-casing the mock to swallow errors.

### 3. Rebuild the fixture layer around the current schema

Replace the legacy `stubBlueprint` (`userId`, `visibility`, `configData`, `configVersion`) with fixtures matching the real `blueprints` + `blueprintRevisions` columns:
- A catalog blueprint row builder with sensible defaults (`authorId`, `publicationStatus`, `kind`, `currentRevisionId`, `publishedRevisionId`, `sourceBlueprintId`, `likeCount`, `forkCount`, `popularityScore`, `trendingScore`) and overridable fields per test (e.g. tests targeting `GET /blueprints` must override to `publicationStatus: 'published'` with a non-null `publishedRevisionId` — the default should probably be `'draft'` to match the most common precondition, matching create/fork/delete tests).
- A matching immutable revision row builder (`version`, `kind`, `name`, `description`, `strategyType`, `style`, `tags`, `venueType`, `payload`, `createdByUserId`).
- Helpers for `published` / `draft` / `private` / `delisted` variants (status + the corresponding nullable timestamp fields).
- A helper for building agent-kind and bot-kind revision `payload` bodies matching `AgentBlueprintRevisionPayload` / `BotBlueprintRevisionPayload`.

### 4. Restore the preset/default coverage

Un-skip `GET /blueprints/presets`, `GET /presets/for-agent`, and `GET /blueprints/defaults` per step 1's findings. These should require no DB mock changes at all, since none of the three handlers touch `db`.

### 5. Rewrite listing and detail tests against the current response contract

- `GET /blueprints`: assert `{ items, nextCursor }` shape; cover the marketplace filter (only published blueprints with a `publishedRevisionId` are returned), at least one query filter (`kind` or `style`), and the `403` entitlement-gate path for a plan without `canViewMarketplaceBlueprints`.
- `GET /blueprints/:id`: cover owner access to a non-published (e.g. `draft`) blueprint, non-owner access to a `published` blueprint, non-owner `404` for `draft`/`private`/`delisted`/`archived`, and the `409 LIFECYCLE_CONFLICT` case for delisted/archived access by the owner/admin.

### 6. Rewrite create tests around revisions

- `POST /blueprints`: strict `{ payload: {...} }` body creates both a `blueprints` row and a `blueprintRevisions` row (version 1); assert `201` and the returned detail shape (`revision.payload`, `revision.skills`); cover the `400` validation-error path for a malformed payload and the skill-portability-rejection `400` path for `kind: 'agent'` with an invalid skill ref.

### 7. Rewrite delete tests around lifecycle + reference checks

- `DELETE /blueprints/:id`: `204` for an unreferenced draft blueprint; `409 LIFECYCLE_CONFLICT` for a non-draft blueprint (e.g. `published`); `409` for a draft blueprint with a nonzero reference count in at least one of the five checked tables (pick one representative case — e.g. an active bot reference — plus a note that the other four checks share the same code path); `404` for a blueprint not owned by the caller and not found by anyone else; `403` for a blueprint owned by a different, non-admin user.

### 8. Rewrite fork tests around idempotency + FK-safe copy semantics

- `POST /blueprints/:id/fork`: `201` with a new draft blueprint carrying `sourceBlueprintId`/`sourceBlueprintRevisionId` lineage; missing/invalid `Idempotency-Key` header → `400`; replayed key with an identical body → `200` with the stored response; replayed key with a different body → `409 IDEMPOTENCY_CONFLICT`; source not found → `404`; non-owner forking a non-published source → `404` (via `resolveTargetRevision`); non-owner forking a published source without marketplace entitlement → `403`.

### 9. Rewrite publish tests around optimistic concurrency + skill portability

- `POST /blueprints/:id/publish`: `200` with `publicationStatus: 'published'` and revision facets copied onto the blueprint row for a valid `draft`/`private`/`delisted` source; `409 REVISION_STALE` when `expectedCurrentRevisionId` doesn't match; `409 LIFECYCLE_CONFLICT` for a disallowed source status (e.g. `archived`); `400 DEPENDENCY_UNAVAILABLE` for an agent-kind blueprint with a non-portable skill; `403` for a non-owner, non-admin caller.

### 10. Rewrite the bot-with-blueprint tests

Update `POST /bots` with `blueprintId` tests to assert config resolution via the `blueprints`⋈`blueprintRevisions` join and `revision.payload`, not `configData`/`configSnapshot` literals. Keep the existing "deprecated inline config" `Deprecation`-header test and the "blueprint deleted between lookup and insert" FK-race `404` test — both already target current behavior and mainly need fixture updates, not logic changes.

### 11. Verify in slices, then as a whole

Run the test file in slices as the rewrite proceeds, in this order:
1. preset/default smoke tests (step 4);
2. list/detail/create tests (steps 5–6);
3. delete/fork/publish tests (steps 7–9);
4. bot-with-blueprint tests (step 10).

Then run the full file and `pnpm lint`.

---

## Acceptance Criteria

1. `apps/api/src/routes/blueprints.test.ts` contains no `describe.skip` blocks.
2. **DONE** — The three preset/default tests pass with the stale FIXME comments removed; the two real bugs found in step 1 (cwd-dependent preset path resolution, cache-poisoning in `loadPresets()`) are fixed outside this test file, not worked around in the mock.
3. All remaining blueprint unit tests pass against the current revision-based API, using the correct endpoint names verified in "Current Code Truth" (`/fork`, `/publish`, `/draft`, `/private`, `/delist`, `/archive` — no `/clone`, no `/unpublish`, no `PUT /blueprints/:id`).
4. The DB mock supports table-scoped dispatch, `.for('update')`, and `db.execute`/`tx.execute` with safe defaults, without per-test boilerplate for every internal scoring/reference-check query.
5. Fixtures reflect `authorId`, `publicationStatus`, `kind`, `currentRevisionId`, `publishedRevisionId`, lineage fields, and revision payloads — no `userId`/`visibility`/`configData`/`configVersion`.
6. `pnpm lint` passes after the rewrite.
7. No test added in this rewrite duplicates a scoring-math or long-time-window assertion already owned by `blueprints.integration.test.ts` / `blueprint-scoring.ts` tests.

---

## Files Likely To Change

- `apps/api/src/routes/blueprints.test.ts`
- Possibly a new test fixture/mock helper module under `apps/api/src/routes/` or `apps/api/src/__tests__/helpers/` (recommended, given the mock rebuild in step 2)
- `packages/domain/src/config/presets-loader.ts` or related preset config **only if** step 1's diagnosis finds a real bug there — otherwise leave production code untouched
- Do not change `apps/api/src/routes/blueprints.ts` route logic as part of this plan; if a test-only seam is genuinely required, keep it minimal and clearly marked

---

## Open Questions / Risks

- Step 1 is complete (see step 1 above for the full diagnosis and fix). No separate bug report was filed since the fixes were small and made directly as part of this plan; file one retroactively if that traceability is needed.
- The fork and publish flows both call `refreshForkCount`/`refreshLikeCount`/`recomputeBlueprintScores` post-commit, which run additional raw `sql` queries against `db`. Confirm the table-aware mock's default zero-count behavior doesn't mask a real assertion — tests that care about the resulting `likeCount`/`forkCount`/scores should override those specific `execute` responses explicitly.

---

## Outstanding Issues (Post-Implementation)

### Step 5 — Listing and Detail Tests
- **M2 (MEDIUM):** Missing "private" and "archived" status tests for `GET /blueprints/:id`. The plan says "non-owner 404 for draft/private/delisted/archived" but only draft and delisted are covered.
- **M3 (MEDIUM):** `buildAgentPayload` uses `as AgentBlueprintRevisionPayload` cast. If schema changes, cast could hide mismatches. Tests catch this at `BlueprintDetailSchema.parse()` time.
- **L1 (LOW):** `db.execute` and `tx.execute` have inconsistent result spreading in `table-aware-db-mock.ts`.

### Step 7 — Delete Tests
- **M5 (MEDIUM):** Missing admin bypass of ownership check test.
- **L1 (LOW):** Test 1 doesn't verify `db.transaction` was called (happy path could pass without transaction).
- **L2 (LOW):** `BP_ID` differs from legacy `BLUEPRINT_ID` — two blueprint ID constants in the file.

### Step 8 — Fork Tests
- **L1 (LOW):** Happy path doesn't assert fork name.
- **L2 (LOW):** 404 test doesn't assert error code in body.
- **L3 (LOW):** No boundary test for Idempotency-Key at max 200 chars.

### Step 9 — Publish Tests
- **M1 (MEDIUM):** Missing test for `currentRevisionId` pointing to nonexistent revision → 409.
- **M2 (MEDIUM):** Handler dead code: null `currentRevisionId` check unreachable (step 6 fires after step 5 mismatch). Handler bug, not test bug.
- **M3 (MEDIUM):** No TODO/skip comment documenting `DEPENDENCY_UNAVAILABLE` gap.
- **L1 (LOW):** Comment typo: "step 12" should be "step 10".
- **L2 (LOW):** Only covers agent kind; bot publish path not tested.

### Step 10 — Bot-with-Blueprint Tests
- **M1 (MEDIUM):** Test 1 doesn't verify `blueprintId` in response body.
- **M2 (MEDIUM):** Missing `configOverrides` merge behavior test.
- **M3 (MEDIUM):** Missing non-owner accessing private/draft blueprint → 404.
- **L1–L4 (LOW):** Mock fidelity/documentation nits.
