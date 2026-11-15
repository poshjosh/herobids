# Implementation Plan

Bug report: `docs/bug-reports/2026/11/14/003-external-skill-attached-twice-ext-prefixed-ref.md`

Notes for the implementer:
- `fast-check` is not a dependency. "Property-based" tests here are table-driven Vitest loops over generated `(owner, repo, skill)` triples crossed with the three spellings. Do not add a library.
- Do not mutate the shared database. DB-backed tests use the repo's existing test DB setup; the local verification uses a fresh local agent.
- Per AGENTS.md: run `pnpm lint` and the relevant build/test suite before declaring complete.

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - `ext:` refs canonicalize to one skill and install
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope to the concrete failing inputs: any external ref carrying the `ext:` prefix, any sync that includes an already-assigned skill. Use table-driven loops over generated `(owner, repo, skill)` triples (no new library).
  - Add tests (names describe behavior):
    - `packages/db/src/external-skill-catalog.test.ts`
      - `normalizeSourceRefToSlug('ext:openaidom/skills/job-search')` equals `'openaidom/skills/job-search'`; same for `ext:o/r@s` and `ext:ext:o/r/s`
      - `externalSkillIdForRef` returns `ext_54a85bf52d4cb1e1f8d46f7a` for `ext:openaidom/skills/job-search`, `openaidom/skills/job-search` and `openaidom/skills@job-search`
      - DB-backed: `ensureExternalSkillIds(db, ['ext:o/r/s', 'o/r/s', 'o/r@s'])` returns three equal ids and exactly one `skills` row exists for the ref; no stored `source_ref` or `slug` starts with `ext:`
    - `apps/worker/src/tools/skills.test.ts` (or a new `skills-ext-prefix.test.ts` next to it)
      - `normalizeExternalRef('ext:o/r/s').ref === 'o/r@s'` (unfixed returns `ext:o/r@s`)
    - `packages/db/src/skill-assignment.test.ts`
      - Provenance: existing `agent_skills` row (`user_select`, `assigned_at = T0`, `assigned_by_user_id = U`); call `syncAgentSkillAssignmentsInTx(..., 'agent_self')` with that skill plus a new one. Assert the old row keeps all three provenance columns, the new row is `agent_self`, `order_index` and `skill_revision_id` still update
  - Run on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bug exists)
  - Document counterexamples found, for example: "`ensureExternalSkillIds(['ext:o/r/s'])` returns `ext_<sha256('ext:o/r/s')>` and creates a second row", "existing row rewritten to `agent_self` with a new `assigned_at`"
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2. Write migration exploration test (legacy rows exist, no migration yet)
  - **Property 1: Bug Condition** - Legacy `ext:` rows are merged and repointed (Property 3 in design)
  - **IMPORTANT**: Standalone integration test, written before the migration exists
  - Create `packages/db/src/ext-prefixed-skills-migration.integration.test.ts` in the existing `*.integration.test.ts` style; add it to the `test:integration` script in the root `package.json`
  - Seed the evidence shape: legacy row `ext_5ed356e3a5c0385824eb9fbf` (`ext:openaidom/skills/job-search`) plus canonical row `ext_54a85bf52d4cb1e1f8d46f7a`; one agent holding both (`order_index` 0 and 5); one agent holding only the legacy row; a second legacy row with no canonical row; a `skill_usage_events` row and a `blueprint_revision_skills` row on a legacy skill
  - Apply the SQL of `packages/db/drizzle/0091_*.sql` (read the file at test time; the test fails with "file not found" on unfixed code)
  - Assert the invariants: zero `skills` rows with `source_ref` or `slug` like `ext:%`; one canonical row per external skill with id `externalSkillIdForRef(ref)`; at most one `agent_skills` row per `(agent, skill)`; all of `agent_skills`, `skill_usage_events`, `blueprint_revision_skills`, `skill_entitlements`, `skill_likes`, `billing_usage_events` reference the canonical skill and its `current_revision_id`; surviving assignments keep the legacy row's `assignment_source`, `assigned_at`, `assigned_by_user_id`; `order_index = LEAST(both)`; running the SQL a second time changes nothing
  - Run on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (migration file does not exist; the seeded legacy rows are the counterexample)
  - _Requirements: 1.6, 2.6_

- [x] 3. Capture the web create-agent request body (one-time manual check)
  - Closes the unverified step in the bug report (does `POST /agents` receive `ext:`-prefixed ids?)
  - On a fresh local stack, create an agent from the web form with an external skill and record the `skillIds` in the `POST /agents` body (browser network panel or API request log)
  - Record the result in the bug report under "Verification" (task 8). The fix does not depend on the answer, because the server must accept the id it hands out
  - Do not touch the shared database
  - _Requirements: 1.1_

- [x] 4. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-prefixed refs and non-conflicting syncs behave as before (Property 4 in design)
  - **IMPORTANT**: Follow observation-first methodology
  - Observe on UNFIXED code, then pin:
    - `normalizeSourceRefToSlug`, `externalSkillIdForRef` for generated `owner/repo/skill` and `owner/repo@skill` (and the evidence id `ext_54a85bf52d4cb1e1f8d46f7a`); compare against an inlined `legacyNormalize` copy of the pre-fix logic over generated non-prefixed inputs
    - Edge non-refs: `ext:foo`, `ext:`, `ext_5ed356e3a5c0385824eb9fbf`, `system/programming`, a legacy platform id, two-segment `author/name`: `ensureExternalSkillIds` returns them unchanged and does not route them to `upsertExternalSkill` (3.2, 3.3)
    - Unknown three-segment ref gets a placeholder row (3.4); unknown non-ref id yields 400 `validation_error` with the same message (3.5)
    - `mapExternalToSkillView` still returns `id: 'ext:<ref>'` and `slug: 'o/r@s'` (3.6)
    - Backend-approved ref catalogued at startup keeps its canonical ref and capability families (3.7)
    - Sync with only new assignments, or only deletions: same rows, `order_index` values and `agent_assigned` usage events; a revision change on an existing row still updates `skill_revision_id` and still emits the event; delete-not-in-list unchanged (3.9)
    - `normalizeExternalRef` for `o/r/s` gives `o/r@s`, `o/r@s` and a two-segment ref stay unchanged (3.8)
  - Verify the existing `skills-catalogued-external.test.ts` and `agent-broker.test.ts` pass on unfixed code (3.8)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 5. Fix for external skill attached twice under an `ext:`-prefixed ref

  - [x] 5.1 Canonicalize in `normalizeSourceRefToSlug` (`packages/db/src/external-skill-catalog.ts`)
    - Strip leading repeated `ext:` only when the remainder contains a `/` (`/^(?:ext:)+(?=.*\/)/`), then apply the existing `@` rewrite. `ext:foo` and `ext:` are left alone
    - Update the doc comment: the `ext:` prefix is a UI-layer id and is never stored
    - No change to `upsertExternalSkill` or `externalSkillIdForRef`
    - _Bug_Condition: isBugCondition(input) where input.kind = 'ref' and startsWith(input.ref, 'ext:') and the remainder contains '/'_
    - _Expected_Behavior: normalizeSourceRefToSlug(ext:o/r/s) = o/r/s; one id for all three spellings_
    - _Preservation: ids for canonical and `@` refs unchanged; `ext:foo` and ids not treated as refs_
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3_

  - [x] 5.2 Canonicalize before lookup in `ensureExternalSkillIds` (same file)
    - Map each input through `normalizeSourceRefToSlug` only when `isExternalRef` holds on the normalized value, then call `resolveSkillIdsBySlugOrId`, so the known-row lookup hits the canonical slug
    - Keep the original input as the output position key; keep `familyByRef.get(slug) ?? familyByRef.get(idOrRef)`
    - _Bug_Condition: input.kind = 'ref'_
    - _Expected_Behavior: three spellings return one id, at most one `skills` row_
    - _Preservation: unknown refs still get placeholder rows; unknown non-ref ids still reach the 400 path_
    - _Requirements: 2.1, 2.2, 2.4, 3.4, 3.5_

  - [x] 5.3 Reuse the normalizer in worker `normalizeExternalRef` (`apps/worker/src/tools/skills.ts`)
    - Call `normalizeSourceRefToSlug` (already imported from `@herobids/db`) on the input before the three-segment test; do not add a second prefix regex
    - `wasNormalized` is true when the input changed
    - `add_skills`, `external-skill-startup.ts`, `installedSkillMdPath` and `deriveSkillDirName` get the fix through this function; a not-yet-migrated stored `ext:` row now installs at agent start
    - _Bug_Condition: input.kind = 'ref' on the installer path_
    - _Expected_Behavior: normalizeExternalRef(ext:o/r/s).ref = o/r@s so the installer receives a valid skills.sh ref_
    - _Preservation: canonical and `@` refs behave as before_
    - _Requirements: 2.3, 2.4, 3.8_

  - [x] 5.4 Preserve provenance in `syncAgentSkillAssignmentsInTx` (`packages/db/src/skill-assignment.ts`)
    - Change `onConflictDoUpdate` set to `{ skillRevisionId, orderIndex }` only; `assignedAt`, `assignedByUserId`, `assignmentSource` stay on the insert path
    - Update the JSDoc: `assignmentSource` applies only to newly inserted assignments
    - Leave the `agent_assigned` usage-event logic (`previousRevisionId !== assignment.skillRevisionId`) untouched; no change to `agent-message-broker.ts`
    - _Bug_Condition: isBugCondition(input) where input.kind = 'sync' and a requested id is already assigned_
    - _Expected_Behavior: existing rows keep provenance; new rows get the passed source; revision and order still update_
    - _Preservation: delete-not-in-list, revision pinning, `agent_assigned` events, `'agent_self'` argument assertions in `agent-broker.test.ts`_
    - _Requirements: 1.5, 2.5, 3.9_

  - [x] 5.5 Add migration 0091 (`packages/db/drizzle/0091_<name>.sql`, `meta/_journal.json`, `meta/0091_snapshot.json`)
    - Generate with `drizzle-kit generate --custom` (name it e.g. `merge_ext_prefixed_skills`); no schema change, so the snapshot is a copy of 0090
    - One `DO $$ ... $$` block (atomic), per the design: for each `skills` row with `source_ref LIKE 'ext:%'`, canonicalize with `regexp_replace(source_ref, '^(ext:)+', '')`; find the canonical row by `source_ref`, or create it (id `'ext_' || substr(encode(sha256(convert_to(canon_ref,'UTF8')),'hex'),1,24)`, revision `<id>:external:1`, copied from the legacy row and its current revision)
    - `agent_skills`: where an agent holds both, the canonical row takes provenance from the legacy row and `order_index = LEAST(both)`, then the legacy row is deleted; legacy-only rows are repointed with `skill_id` and `skill_revision_id` set together
    - Repoint `skill_usage_events`, `blueprint_revision_skills` (delete duplicates first; set both FK columns in one statement for `fk_bprs_skill_revision`), `skill_entitlements` and `skill_likes` (skip duplicates), `billing_usage_events`, and `skills.fork_of`; then delete the legacy row
    - End with `RAISE EXCEPTION` if any `ext:%` `source_ref` or `slug` remains
    - Idempotent (no `ext:%` rows means the loop does nothing); forward only
    - Verify the SQL against the real schema before writing (column and constraint names for each referenced table)
    - Pre-flight read-only queries from the design go in the bug report (task 8), not run against shared databases without owner approval
    - _Bug_Condition: isBugCondition(input) where input.kind = 'row'_
    - _Expected_Behavior: zero `ext:` rows, one canonical row per skill, one assignment per (agent, skill), provenance carried from the legacy row_
    - _Preservation: canonical rows, their ids and their assignments untouched_
    - _Requirements: 1.6, 2.6, 3.1, 3.9_

  - [x] 5.6 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - `ext:` refs canonicalize to one skill and install; provenance preserved; legacy rows merged
    - **IMPORTANT**: Re-run the SAME tests from tasks 1 and 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms the bug is fixed)
    - Also run a second pass of the migration test to confirm idempotence
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 5.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-prefixed refs and non-conflicting syncs behave as before
    - **IMPORTANT**: Re-run the SAME tests from task 4 - do NOT write new tests
    - Re-run `skills-catalogued-external.test.ts`, `agent-broker.test.ts`, `skill-assignment.test.ts`, `external-skill-catalog.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [ ] 6. Add flow-level tests for the fix
  - API flow: `POST /agents` with `ext:o/r/s`, then `PATCH` with `o/r@s`: one `skills` row, one `agent_skills` row, `GET /agents/:id` lists the skill once (add to an existing agent-skill integration test, for example `child-agent-skill-assignment.integration.test.ts`, or a new file listed in `test:integration`)
  - Worker flow: with a fake `ExternalSkillInstaller`, `add_skills(['o/r@s'])` for an agent created with `ext:o/r/s` adds nothing new, the existing assignment keeps `user_select`, and the installer is called with `o/r@s`
  - Agent start: `external-skill-startup` with a canonical stored `source_ref` installs on the first attempt (installer called with `o/r@s`, `available: true`)
  - Agent calling `add_skills(['ext:o/r/s'])` directly installs via `o/r@s`
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.8, 3.9_

- [ ] 7. Local end-to-end verification on a fresh local agent
  - Per the bug report constraints: do not edit the shared database. On a fresh local stack, create a `job-search` agent through the web form
  - Confirm: one `job-search` skill in the agent detail, no `ext:` `source_ref` in `skills`, no "External skill install failed" warning at start, the skill is available on the first tick without `add_skills`
  - If the stack cannot be run in the session, say so in the bug report rather than claiming it passed
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 8. Update the bug report
  - File: `docs/bug-reports/2026/11/14/003-external-skill-attached-twice-ext-prefixed-ref.md`
  - Run `git log --oneline -- packages/db/src/external-skill-catalog.ts apps/worker/src/tools/skills.ts packages/db/src/skill-assignment.ts` and record the result. The design expects "gap, not regression": the prefix was never handled in `normalizeSourceRefToSlug`. Confirm or correct that against the log, including the commits named in the report (`8d6a2016`, `79fa8b46`, `2e005613`, `cd241243`, `f03e5c6c`)
  - Record the deliberate behavior change: `syncAgentSkillAssignmentsInTx` no longer overwrites `assignment_source`, `assigned_at` and `assigned_by_user_id` for assignments that already exist, on both the worker broker path and the API user-update path (a user re-saving the skill list no longer relabels `agent_self` assignments as `user_select`)
  - Record the root cause, the web request body result from task 3, the answers to the report's open questions (normalization write paths, where the prefix is stripped, how old rows migrate, why `add_skills` rewrote provenance), the pre-flight SQL for each environment, and the fact that original provenance of already-rewritten rows (for example agent `7963e37d`) cannot be recovered
  - Fill in Status, Fix, Files Changed and Verification (commands run and results, and what was not verified)
  - _Requirements: 1.5, 1.6, 2.5, 2.6_

- [ ] 9. Checkpoint - Ensure all tests pass
  - Run `pnpm lint` (must pass)
  - Run focused tests: `external-skill-catalog.test.ts`, `skill-assignment.test.ts`, worker `tools/skills*.test.ts`, `agent-broker.test.ts`, the new migration integration test
  - Run the relevant build and test suites: `pnpm build`, `pnpm test`, `pnpm test:integration` (needs its documented services), and `scripts/shell/tests/run-all-tests.sh` if the changes touch more than the files above
  - Confirm no `.env*` or `config/default.yaml` changes were needed (none expected)
  - Ensure all tests pass, ask the user if questions arise.
