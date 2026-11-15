# Bug Report: Agents created with an external skill get it attached twice (and it fails to install at start)

- **Status:** FIXED in code, tests pass locally. Not yet deployed. The migration and pre-flight SQL have not been run on any shared or production database, and the full `pnpm lint` / `pnpm build` / `pnpm test` / `pnpm test:integration` suites have not been run yet (see Verification).
- **Severity:** Medium
- **Date:** 2026-11-14
- **Summary:** An agent created with the external skill `openaidom/skills@job-search` ends up with two `job-search` skills attached. The first, from agent creation, is stored under the ref `ext:openaidom/skills/job-search`, which the skills installer cannot install, so the skill is unavailable at agent start. The agent then adds it again itself with the normal ref, which creates a second `skills` row and a second assignment.

## Symptom

Observed on the local Docker compose stack on every `job-search` agent created in the 2026-11-14 session
(`swift-hatch` `0380f813-9a7f-4ea1-aa16-53e0d7be21a8` and `job-searcher`
`7963e37d-5087-4755-87a2-abe53be0692e`, plus an earlier `job-searcher` `a148c598-...`; the first two are
gone or going from the database, so only `7963e37d` can still be inspected). The owner says it happens every
time.

- The agent detail lists `job-search` twice.
- At agent start the first skill is "unavailable this session", so the agent's first tick has no skill
  instructions until the agent calls `add_skills` itself.

## Evidence (read-only; reproduced from the database and container logs on 2026-11-14 ~21:45 UTC)

Agent `7963e37d-5087-4755-87a2-abe53be0692e`, created 21:26:33.556.

`skills` rows (query: `select id, slug, source_ref, created_at from skills where name = 'job-search'`):

| id | slug / source_ref | created_at | how it was created |
|---|---|---|---|
| `ext_5ed356e3a5c0385824eb9fbf` | `ext:openaidom/skills/job-search` | 21:26:33.551 (5 ms before the agent row) | agent creation |
| `ext_54a85bf52d4cb1e1f8d46f7a` | `openaidom/skills/job-search` | 21:27:01.777 | the agent's own `add_skills` call |

The ids are deterministic: `ext_` + the first 24 hex chars of `sha256(<ref>)` (`externalSkillIdForRef`,
`packages/db/src/external-skill-catalog.ts:34`). Checked with `shasum`:

- `sha256("ext:openaidom/skills/job-search")` gives `ext_5ed356e3a5c0385824eb9fbf`
- `sha256("openaidom/skills/job-search")` gives `ext_54a85bf52d4cb1e1f8d46f7a`

So the two rows come from two spellings of one ref, and the `uq_skills_source_ref` unique index cannot catch
it because the strings differ.

`agent_skills` for that agent: both `ext_5ed356...` (order_index 0) and `ext_54a85...` (order_index 5) are
attached, both with `assignment_source = 'agent_self'` and `assigned_at = 21:27:01.785`. The first was
created as `user_select` at creation, so the agent's `add_skills` appears to have re-written the existing
assignment too.

Agent container log at start (21:26:38):

```
WARN (external-skill-startup): External skill install failed — skill unavailable this session
    sourceRef: "ext:openaidom/skills/job-search"
    error: "skills.sh exited with code 1: npm warn exec The following package was not found and will be installed: skills@1.8.1"
INFO (agent-runtime): External skills installed at agent start   installed: 0
```

Agent activity (`agent_messages`): at 21:26:59 the agent called `add_skills` with
`["openaidom/skills@job-search"]`; the result at 21:27:01 lists `activeSkills` containing both `ext_5ed356...`
and `ext_54a85...`, and an `agent.manage_skills` event adds `ext_54a85...` at 21:27:01.782.

A scan of `skills` for the same ref under both spellings returns only this pair
(`regexp_replace(source_ref, '^ext:', '')` grouped, `having count(*) > 1`). Agents created by script with
plain refs (`thyper`, `t1inch`, `tintel`, `external-skills-tester`) have one row per skill and no duplicate.

## Suspected root cause (read from code; NOT verified end to end)

1. The web skill list builds external-skill ids as `ext:${ext.ref}`
   (`apps/api/src/routes/skills.ts:541`, `mapExternalToSkillView`). If the create-agent form sends that id in
   `skillIds`, `POST /agents` passes it to `ensureExternalSkillIds` (`apps/api/src/routes/agents.ts:558`).
2. `ensureExternalSkillIds` (`external-skill-catalog.ts:106`) accepts the string as an external ref
   (`isExternalRef`: three `/`-separated segments, no `@`), and `normalizeSourceRefToSlug` (`:20`) only
   rewrites the `owner/repo@skill` form. It does not strip an `ext:` prefix, so `upsertExternalSkill` stores
   `source_ref = "ext:openaidom/skills/job-search"`.
3. At agent start `external-skill-startup.ts` runs the skills installer with that stored ref. `ext:...` is not a
   valid skills.sh ref, so the install fails (see the log above).
4. The agent notices the skill is not available and calls `add_skills` with the real ref. That ref normalizes
   to `openaidom/skills/job-search`, a different string, so a second row and assignment are created.

Not yet confirmed: that the web form actually sends the `ext:`-prefixed id (step 1), and which agents/skills
were created through the web form versus the API.

## Impact

- Duplicate skill rows and assignments for the same skill, per agent created through this path. The two rows
  are never merged.
- The first tick starts without the skill's instructions; the agent must recover through `add_skills` and
  `read_skill`. An agent that does not do that has the skill unavailable for the whole session.
- Any consumer that treats a skill's `source_ref` as unique per skill (catalog, entitlements, UI lists, token
  counts for the prompt) is affected. Not assessed.

## Questions for the investigator

- Does `POST /agents` receive `ext:`-prefixed ids from the web create flow? Capture the request body.
- Which write path normalizes refs, and which do not? Compare `ensureExternalSkillIds`,
  `resolveSkillIdsBySlugOrId` (`skill-assignment.ts`), the `add_skills` tool (`apps/worker/src/tools/skills.ts`
  ~lines 510 and 715), `external-skill-startup.ts` (~85) and the API skill routes.
- Should the canonical stored ref be `owner/repo/skill` with the prefix only ever a UI-layer id? Decide where
  the prefix is stripped so the fix is one place, not several.
- Existing data: how many agents have both spellings, and how are the old `ext:`-prefixed rows and their
  assignments migrated or removed?
- Why does `add_skills` re-write the `assignment_source` of the original assignment to `agent_self`?
- `git log` for the affected files shows `8d6a2016`, `79fa8b46`, `2e005613`, `cd241243`, `f03e5c6c` touching
  skill loading; check whether the prefix handling regressed in one of them. No prior bug report in
  `docs/bug-reports/` covers this (searched for duplicate/`source_ref`/`ext:openaidom`).

## Constraints for whoever picks this up

- Do not mutate the shared database to "clean up" the duplicate while investigating; reproduce on a fresh
  local agent.
- Fix the root cause once (ref canonicalization at the boundary), not by hiding the duplicate in the UI.
- Add a test that the same external skill given as `ext:o/r/s`, `o/r/s` and `o/r@s` resolves to one skill id.

## Root Cause (confirmed)

Three defects combine. The first two are the cause of the report. The third is a second place the prefix matters that the report did not list.

1. **Canonicalization gap.** `normalizeSourceRefToSlug` (`packages/db/src/external-skill-catalog.ts`) only rewrote `owner/repo@skill` to `owner/repo/skill`. It did not know the `ext:` UI prefix. `isExternalRef('ext:o/r/s')` is true (three segments, no `@`), so `ensureExternalSkillIds` fell through to `upsertExternalSkill`, which stored `ext:o/r/s` as `source_ref` and `slug` and derived the id from `sha256('ext:o/r/s')`. One skill could therefore exist as `ext:o/r/s`, `o/r/s` and `o/r@s`. Two of those hash to different ids, and `uq_skills_source_ref` compares exact strings, so nothing blocked the second row.
2. **Provenance overwrite.** `syncAgentSkillAssignmentsInTx` (`packages/db/src/skill-assignment.ts`) set `assignedAt`, `assignedByUserId` and `assignmentSource` in `onConflictDoUpdate` for every assignment in the list. `add_skills` passes the full set (existing plus new), so every existing assignment was relabelled `agent_self` with a new `assigned_at`. This is why the first assignment in the evidence shows `agent_self` and `assigned_at = 21:27:01.785`.
3. **Second normalizer.** `normalizeExternalRef` (`apps/worker/src/tools/skills.ts`) split on `/` itself and turned `ext:o/r/s` into `ext:o/r@s`, so the installer failed for any `ext:` ref, whether it came from the stored `source_ref` at start or from an agent calling `add_skills` with an `ext:` ref copied from the skills list.

### Web request body (was unverified, now observed)

Captured at runtime on the local stack (`http://localhost:8090`, headless Playwright, request aborted, no agent created). `POST /api/agents` carried `skillIds = ["ext:umutyesildal/berlin-job-search/berlin-job-search"]`. So the web form does send the `ext:`-prefixed id.

`GET /api/skills` returns two id shapes:

- Live provider results: id `ext:<owner>/<repo>/<skill>`, slug `<owner>/<repo>@<skill>`.
- DB-catalogued rows: hashed ids, for example `ext_5ed356e3a5c0385824eb9fbf` with slug `ext:openaidom/skills/job-search`, and `ext_54a85bf52d4cb1e1f8d46f7a` with slug `openaidom/skills/job-search`. Both are visible in the same list, which is the duplicate from this report.

Static trace of the path: `apps/api/src/routes/skills.ts:533-541` (`mapExternalToSkillView` builds `ext:${ref}`), `apps/web/src/features/agents/SkillPicker.tsx:113,133`, `CreateAgentFlow.tsx:777-780` and `503-510`, `agent-payloads.ts:244-245`, then `apps/api/src/routes/agents.ts:548-560` (`resolveSkillSlugs`, called at ~825 and ~1497) into `ensureExternalSkillIds`.

### Regression or gap? (`git log` result)

Command: `git log --oneline -- packages/db/src/external-skill-catalog.ts apps/worker/src/tools/skills.ts packages/db/src/skill-assignment.ts`. It lists 28 commits, from `5342206a` (2026-08-28, "extract shared skill assignment logic to DB package") to `8d6a2016` (2026-10-26).

Conclusion: **a gap, not a regression, for the prefix.** Confirmed against the log:

- `normalizeSourceRefToSlug` was introduced in `f92cbe39` (2026-10-04, Phase 4 T4, external skills as metadata-only DB rows). `git log -S"'ext:" -- packages/db/src/external-skill-catalog.ts apps/api/src/routes/skills.ts` returns nothing, so no commit ever handled the prefix in the catalog file. The function has only ever done the `@` rewrite.
- The `ext:` view id comes from `mapExternalToSkillView`, added in `84bc3d9c` (2026-08-30), about five weeks before the normalizer existed. The prefix was never reconciled with the normalizer.
- The five commits named in the report do not touch the prefix:
  - `cd241243` (2026-10-15): in the catalog file it only added `findExternalSourceRefs`, which maps refs through `normalizeSourceRefToSlug`. In `skills.ts` it reuses `normalizeExternalRef` for paths. It inherits the gap and does not create it.
  - `f03e5c6c` (2026-10-15): `skills.ts` only. Callers of `normalizeExternalRef` for naming. No prefix logic.
  - `2e005613` (2026-10-16): one line in `skills.ts`, no prefix logic.
  - `79fa8b46` (2026-10-18): `skills.ts` only, no prefix logic. Its diff has no match for `ext:`, `normalizeSourceRefToSlug` or `normalizeExternalRef`.
  - `8d6a2016` (2026-10-26): added a `skill.user_only` guard to `add_skills` and restructured `skill-assignment.ts`. The `onConflictDoUpdate` set that rewrites `assignedAt`, `assignedByUserId` and `assignmentSource` is **identical before and after** this commit (checked with `git show 8d6a2016^:` and `8d6a2016:`). So the provenance overwrite is not introduced here either. I did not trace it back to its first appearance; it is present at `8d6a2016^`, and `git log -S assignmentSource` first shows `5342206a` (2026-08-28) for the file.
- The design's expectation ("gap, not regression") holds for both defects.

## Answers to the report's open questions

- **Does `POST /agents` receive `ext:` ids from the web create flow?** Yes. See "Web request body" above.
- **Which write paths normalize refs?** All of them go through `normalizeSourceRefToSlug`: `externalSkillIdForRef`, `findExternalSourceRefs`, `upsertExternalSkill`, `setExternalSkillCapabilityFamilies`, `ensureExternalSkillIds`. The `add_skills`, `read_skill` and `load_skill` tools and `external-skill-startup.ts` use the worker's `normalizeExternalRef`, a separate function that did not call it and did not know the prefix (defect 3). `resolveSkillIdsBySlugOrId` does not normalize, it matches slug or id as given. The API skill routes only build the `ext:` view id.
- **Where is the prefix stripped?** In one place, `normalizeSourceRefToSlug`. The `ext:` prefix stays a UI-layer id only. `ensureExternalSkillIds` canonicalizes at the top, and `normalizeExternalRef` calls the same function. Stripping in `resolveSkillSlugs` was rejected because it covers only `POST/PATCH /agents` and would still let an agent create the duplicate through `add_skills`.
- **How do existing `ext:` rows migrate?** Migration `0091_merge_ext_prefixed_skills.sql`, one atomic `DO $$` block. For each `ext:`-prefixed row it finds or creates the canonical row (looked up by `source_ref`), merges `agent_skills` (agents holding both keep the canonical row, take provenance from the legacy row, and take the lower `order_index`), repoints `skill_usage_events`, `blueprint_revision_skills`, `skill_entitlements`, `skill_likes`, `billing_usage_events` and `fork_of`, deletes the legacy row, and raises if any `ext:` row remains. It is idempotent and forward only. It also recomputes `like_count` and `fork_count` on the canonical row when likes or forks were moved. That recount is an addition beyond the design.
- **Why did `add_skills` rewrite the provenance?** Defect 2. The sync's conflict update set the provenance columns for every row in the list, and `handleSkillAdd` passes existing plus new skills.

## Fix

1. `normalizeSourceRefToSlug` strips the leading `ext:` prefix (`UI_ID_PREFIX`, applied only when the remainder contains a `/`, repeated prefixes stripped, so it is idempotent). `ext:foo`, `ext:` and `ext_<hash>` are left alone and still handled as unknown ids.
2. `ensureExternalSkillIds` canonicalizes each external ref before the known-row lookup. The output position keys stay the original inputs.
3. `normalizeExternalRef` in the worker calls `normalizeSourceRefToSlug` instead of splitting itself. `add_skills`, `external-skill-startup.ts` and the skill-dir helpers inherit the fix, so a not-yet-migrated `ext:` row also installs at agent start.
4. `syncAgentSkillAssignmentsInTx` now updates only `skill_revision_id` and `order_index` on conflict.
5. Migration `0091_merge_ext_prefixed_skills.sql` (see above).

### Deliberate behavior change

`syncAgentSkillAssignmentsInTx` no longer overwrites `assignment_source`, `assigned_at` and `assigned_by_user_id` for assignments that already exist. The `assignmentSource` argument now applies only to rows the call inserts. This holds on both callers:

- the worker broker path (`add_skills` / `remove_skills`): existing assignments are no longer relabelled `agent_self`;
- the API user-update path: a user re-saving the skill list no longer relabels `agent_self` assignments as `user_select`.

`assignment_source` now records how an assignment was first created. A repo-wide search (2026-11-15, `.ts`, `.tsx`, `.sql` and `.py` files, excluding `node_modules`, `dist` and `docs`) found no reader of `assignment_source`, `assigned_at` or `assigned_by_user_id` outside tests. They are written by `syncAgentSkillAssignmentsInTx`, `agent-instantiation-service.ts` (`blueprint_instantiate` / `go_live`), the 0009 backfill and migration 0091, and read only in tests. Nothing in the repo depends on the old last-writer behavior. Consumers outside the repo (dashboards, analytics) cannot be checked from here. Function signatures are unchanged, so the `'agent_self'` assertions in `agent-broker.test.ts` stay valid.

### Data that cannot be recovered

Rows already rewritten by the old bug have lost their original provenance. Agent `7963e37d-5087-4755-87a2-abe53be0692e` is the known case: its creation-time assignment was `user_select`, but the database now says `agent_self` with `assigned_at = 21:27:01.785`. The migration carries over what the legacy row says and does not invent a value, so merged rows from such agents keep `agent_self`. The original values are not stored anywhere I could find.

### Pre-flight (read-only), per environment, before deploying the migration

Run on local, staging and production, and keep the output with the deploy notes. Take the usual database snapshot before production.

```sql
select count(*) from skills where source_ref like 'ext:%';
select s.id, a.agent_id from agent_skills a join skills s on s.id = a.skill_id where s.source_ref like 'ext:%';
select count(*) from skill_entitlements e join skills s on s.id = e.skill_id where s.source_ref like 'ext:%';
select count(*) from skill_likes l join skills s on s.id = l.skill_id where s.source_ref like 'ext:%';
select count(*) from blueprint_revision_skills b join skills s on s.id = b.skill_id where s.source_ref like 'ext:%';
```

The first two queries answer the open question "how many agents have both spellings" (join the second result against canonical rows for the same ref). Entitlements, likes and blueprint rows are expected to be zero for external skills (`authorId` is null). If they are not, the migration still handles them. A running agent keeps its in-memory skill list (legacy id) until its next skill change or restart, then reads the canonical id from `agent_skills`.

## Files Changed

Fix:

- `packages/db/src/external-skill-catalog.ts`: `UI_ID_PREFIX` strip in `normalizeSourceRefToSlug`; `ensureExternalSkillIds` canonicalizes before lookup.
- `apps/worker/src/tools/skills.ts`: `normalizeExternalRef` reuses `normalizeSourceRefToSlug`.
- `packages/db/src/skill-assignment.ts`: `onConflictDoUpdate` sets only `skillRevisionId` and `orderIndex`.
- `packages/db/drizzle/0091_merge_ext_prefixed_skills.sql`, `packages/db/drizzle/meta/_journal.json`, `packages/db/drizzle/meta/0091_snapshot.json`.

Tests added or changed:

- `packages/db/src/external-skill-catalog.test.ts`, `packages/db/src/skill-assignment.test.ts`, `packages/db/src/ext-prefixed-skills-migration.integration.test.ts`
- `apps/worker/src/tools/skills-ext-prefix.test.ts`, `skills-external-ref-preservation.test.ts`, `external-skill-startup.test.ts`, `apps/worker/src/__tests__/integration/external-skill-ext-ref.integration.test.ts`
- `apps/api/src/routes/skills.test.ts`, `agents-slug.test.ts`, `agent-external-skill-ref.integration.test.ts`
- root `package.json`: `test:integration` script includes the new integration tests.

Not changed on purpose: `apps/api/src/routes/skills.ts` (`mapExternalToSkillView` keeps the `ext:` view id), `apps/api/src/routes/agents.ts` (`resolveSkillSlugs` gets the fix through `ensureExternalSkillIds`), `apps/worker/src/agents/agent-message-broker.ts`, and all `.env*` and config files (no new configuration).

## Verification

**Done (local, serial runs, `DATABASE_URL` on the local docker postgres with scratch databases):**

- Exploration tests (tasks 1 and 2) failed on the unfixed code as expected and pass after the fix: `external-skill-catalog` 215/215, `skill-assignment` 18/18, `skills-ext-prefix` 55/55, migration integration 9/9 (re-run, stable).
- Preservation and regression run: 11 files, 739/739 pass.
- Flow tests (task 6): 14 tests pass across the 3 files run. These were not run against the pre-fix code.
- Local stack check, read-only queries, agent `job-searcher` (`882b0011-c0b2-44c4-85f5-ec1b32d087e5`, created 2026-11-14 23:43:21 UTC): `job-search` attached exactly once, skill id `ext_54a85bf52d4cb1e1f8d46f7a`, slug and `source_ref` `openaidom/skills/job-search`, `assignment_source = user_select`. 4 `agent_skills` rows for 4 distinct skills (job-search, browser, file-management, web-access). 0 `skills` rows with an `ext:` `source_ref` or slug. The agent log shows `External skills installed at agent start` with `installed: 1`, and no install failure, no "skill unavailable", no `skills.sh` exit code and no `add_skills` call. The agent called `read_skill` on `openaidom/skills/job-search` on its first tick. Usage events: one `agent_assigned` and one `session_started` per skill.

**Caveats on the local stack check:** I did not check which build the api and worker containers ran, whether migration 0091 had been applied on that database, or which spelling the web form sent for this agent. A clean database could also produce this result, so it is supporting evidence, not proof of the fix.

**Not verified:**

- The migration and the pre-flight SQL have not been run on any shared or production database.
- The full `pnpm lint`, `pnpm build`, `pnpm test` and `pnpm test:integration` suites have not been run (task 9 pending).
- Type-checking of the new test files: root `pnpm lint` is `tsc --noEmit` over a solution config with `files: []`, which likely does not cover test files.
- A parallel run of the `packages/db` DB tests hit a Postgres `deadlock detected`. Serial runs pass. I did not investigate it.
- The original provenance of rows already rewritten by the bug (see "Data that cannot be recovered").
