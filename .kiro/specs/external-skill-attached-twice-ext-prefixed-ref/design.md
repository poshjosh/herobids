# External Skill Attached Twice (`ext:`-prefixed ref) Bugfix Design

## Overview

The skills list returns external skills with the UI-layer id `ext:owner/repo/skill`. The create/update-agent flow passes that id to `ensureExternalSkillIds`, which treats it as a ref and stores it, prefix included, as the skill's `source_ref` and `slug`. `normalizeSourceRefToSlug` only rewrites `owner/repo@skill`, so one skill can exist under three spellings (`ext:o/r/s`, `o/r/s`, `o/r@s`). Two of them derive different deterministic ids (`externalSkillIdForRef` hashes the normalized string), and `uq_skills_source_ref` compares exact strings, so nothing stops the second row.

Consequences: the installer cannot install `ext:...` (skill unavailable on the first tick), the agent re-adds the skill with the real ref (second row, second assignment), and the broker's sync rewrites `assignment_source`, `assigned_at` and `assigned_by_user_id` of every assignment in the list to `agent_self`.

The fix has four parts:

1. Strip the `ext:` prefix inside `normalizeSourceRefToSlug` (the single canonicalization choke point). Reuse it in `normalizeExternalRef` (worker installer path) and at the top of `ensureExternalSkillIds`.
2. Make `syncAgentSkillAssignmentsInTx` write provenance only for newly inserted assignments. Existing rows keep `assignment_source`, `assigned_at`, `assigned_by_user_id`.
3. Add a forward-only SQL migration that rewrites, merges and repoints existing `ext:`-prefixed rows.
4. Tests for all of the above.

### Decisions on the two open questions

**Decision 1: strip in `normalizeSourceRefToSlug`, not in `resolveSkillSlugs`.**

- `normalizeSourceRefToSlug` is called by every path that identifies an external skill: `externalSkillIdForRef`, `findExternalSourceRefs`, `upsertExternalSkill`, `setExternalSkillCapabilityFamilies`, `ensureExternalSkillIds`, `add_skills`, `read_skill`, `load_skill`. Stripping there fixes all of them with one edit.
- Stripping in `resolveSkillSlugs` (`apps/api/src/routes/agents.ts`) covers only `POST/PATCH /agents`. `externalSkillIdForRef('ext:o/r/s')` would still hash the prefixed string, and an agent calling `add_skills` with an `ext:` ref (it can copy one from the skills list) would still create the duplicate.
- `resolveSkillSlugs` also has a second caller shape (create and update, lines ~825 and ~1497) plus `agent-interactivity.ts`. Putting the strip there would mean several copies, which the bug report explicitly rules out.
- The prefix stays a UI-layer id only (requirement 3.6). The API view mapper (`mapExternalToSkillView`) is unchanged.

**Decision 2: preserve provenance inside `syncAgentSkillAssignmentsInTx`, by changing the `ON CONFLICT DO UPDATE` set.**

- `assignment_source` records how an assignment was first created. It has no reader today (only writers and tests), so it is a provenance fact, not a "last writer" field.
- On conflict, the upsert will update only `skill_revision_id` and `order_index`. `assigned_at`, `assigned_by_user_id` and `assignment_source` are set only on the insert path.
- This is a fix in the shared function, so the worker broker's `add` and `remove` paths are both fixed, and so is the same defect on the API path (a user re-saving the skill list no longer relabels `agent_self` assignments as `user_select`). Function signatures do not change, so the existing `agent-broker.test.ts` assertions on the `'agent_self'` argument stay valid.
- Rejected alternative: a `preserveExisting` flag or a broker-side diff that passes only new skills. A flag has one sensible value, and a broker-side diff would break the "full desired set" contract that the delete-not-in-list logic relies on.
- Behavior change to record in the bug report: user updates no longer overwrite `assignment_source`/`assigned_at`/`assigned_by_user_id` for assignments that already exist.

## Glossary

- **Bug_Condition (C)**: An external skill ref carrying the `ext:` UI prefix reaches a canonicalization or persistence path (C1); or an assignment sync includes an already-assigned skill and rewrites its provenance (C2); or a `skills` row with an `ext:`-prefixed `source_ref` already exists (C3).
- **Property (P)**: Every spelling of an external ref resolves to one canonical `owner/repo/skill` ref, one skill id and one assignment, provenance of existing assignments is preserved, and legacy rows are merged.
- **Preservation**: Behavior for canonical and `@` refs, platform skills, marketplace slugs, unknown refs and unknown ids stays as today.
- **normalizeSourceRefToSlug**: `packages/db/src/external-skill-catalog.ts`. Converts a skills.sh ref to `owner/repo/skill`.
- **externalSkillIdForRef**: Same file. `ext_` + first 24 hex chars of `sha256(normalizeSourceRefToSlug(ref))`.
- **ensureExternalSkillIds**: Same file. Translates the create/update `skillIds` list into skill ids, creating placeholder rows for unknown refs.
- **normalizeExternalRef**: `apps/worker/src/tools/skills.ts`. Rewrites `o/r/s` to `o/r@s` for the skills CLI.
- **syncAgentSkillAssignmentsInTx**: `packages/db/src/skill-assignment.ts`. Writes the full desired set of `agent_skills` rows for an agent.
- **Legacy row**: A `skills` row whose `source_ref`/`slug` starts with `ext:`.
- **Canonical row**: The `skills` row whose `source_ref` is the bare `owner/repo/skill`.

## Bug Details

### Bug Condition

The bug manifests when an external skill is identified with the `ext:` prefix, when an assignment sync touches an assignment that already exists, or when data from earlier occurrences remains. `normalizeSourceRefToSlug` does not recognise the prefix, so downstream functions treat `ext:o/r/s` as a different ref. `syncAgentSkillAssignmentsInTx` overwrites provenance columns on conflict.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type
         { kind: 'ref',  ref: string }                                   -- any path that identifies an external skill
       | { kind: 'sync', agentId: string, requested: SkillId[],
           existing: Map<SkillId, Provenance> }                          -- an agent_skills sync
       | { kind: 'row',  skill: SkillsRow }                              -- stored data
  OUTPUT: boolean

  IF input.kind = 'ref' THEN
    RETURN startsWith(input.ref, 'ext:')
           AND contains(input.ref minus leading 'ext:' prefixes, '/')
  IF input.kind = 'sync' THEN
    RETURN EXISTS id IN input.requested WHERE id IN keys(input.existing)
  IF input.kind = 'row' THEN
    RETURN input.skill.source_ref IS NOT NULL
           AND startsWith(input.skill.source_ref, 'ext:')
END FUNCTION
```

### Examples

- `POST /agents` with `skillIds: ["ext:openaidom/skills/job-search"]`. Expected: skill row with `source_ref = 'openaidom/skills/job-search'`, id `ext_54a85bf52d4cb1e1f8d46f7a`. Actual: row with `source_ref = 'ext:openaidom/skills/job-search'`, id `ext_5ed356e3a5c0385824eb9fbf`.
- Agent start with that stored ref. Expected: install `openaidom/skills@job-search` succeeds. Actual: `skills.sh exited with code 1`, skill unavailable.
- Agent calls `add_skills(["openaidom/skills@job-search"])`. Expected: no new row, no new assignment. Actual: second row `ext_54a85...` and second `agent_skills` row.
- `add_skills` for a skill the agent already has (`user_select`, `assigned_at` T0). Expected: row unchanged. Actual: `assignment_source = 'agent_self'`, `assigned_at = now`.
- `add_skills(["ext:openaidom/skills/job-search"])` called by the agent directly. Expected: installs via `openaidom/skills@job-search`. Actual: `normalizeExternalRef` produces `ext:openaidom/skills@job-search`, the install fails.
- Edge: `ext:foo` (no slash), `ext_5ed356e3a5c0385824eb9fbf` (id), `ext:` alone. Expected: not treated as an external ref, handled as today (unknown id, 400).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `owner/repo/skill` and `owner/repo@skill` resolve to the same ids as today (3.1). Existing canonical rows and their `ext_<hash>` ids do not change.
- Platform skills by slug, legacy id or `system/*` resolve as platform skills (3.2).
- Two-segment `author/name` marketplace slugs resolve against the catalog and are not external refs (3.3).
- Unknown, never-catalogued external refs create a placeholder row and never block creation (3.4).
- Unknown non-ref ids and slugs still produce 400 `validation_error` (3.5).
- `GET /skills` still returns `id: 'ext:<ref>'` and `slug: 'o/r@s'` (3.6).
- Backend-approved refs are catalogued at API startup under the canonical ref with their families (3.7).
- `add_skills`, `read_skill`, `load_skill` behave as before for canonical and `@` refs (3.8).
- One assignment per skill, pinned to the skill's current revision (3.9). Revision updates, `skill_usage_events` `agent_assigned` events and delete-not-in-list semantics of the sync stay as today.

**Scope:**
All inputs where `isBugCondition` is false. That includes refs without the prefix, syncs that add only new skills or remove skills, and stored rows with canonical refs.

The expected correct behavior is defined in Correctness Properties (1 to 3).

## Hypothesized Root Cause

The investigation notes are confirmed by reading the code. Items 1 and 2 are the defect. Item 3 shows an unlisted second place the prefix matters. Item 4 is unverified.

1. **Canonicalization gap**: `normalizeSourceRefToSlug` handles `@` only. `isExternalRef('ext:o/r/s')` is true (three segments, no `@`), so `ensureExternalSkillIds` falls through to `upsertExternalSkill`, which stores the prefixed string as `source_ref` and slug and derives id `sha256('ext:o/r/s')`.
2. **Provenance overwrite**: `syncAgentSkillAssignmentsInTx` sets `assignedAt`, `assignedByUserId` and `assignmentSource` in `onConflictDoUpdate` for every assignment in the list. `handleSkillAdd` passes the combined set (existing + new), so every existing row is rewritten. `handleSkillRemove` does the same for the remaining rows.
3. **Second normalizer**: `normalizeExternalRef` (worker) is a separate function. It splits on `/` and turns `ext:o/r/s` into `ext:o/r@s`. The installer path therefore fails for any `ext:` ref, whether it comes from the stored `source_ref` at start or from an agent calling `add_skills` directly.
4. **Web form sends the `ext:` id** (unverified): `CreateAgentFlow` stores `skill.id` from the skills list in `intent.skillIds`, and `mapExternalToSkillView` sets `id: 'ext:<ref>'`. The exploratory test should capture the request body to confirm. The fix does not depend on the answer, because the server must accept the id the server itself hands out.

`git log` for regression: not required for the design. The prefix was never handled in `normalizeSourceRefToSlug` (added with the external catalog), so this is a gap, not a regression. The implementer should still run `git log -- packages/db/src/external-skill-catalog.ts` and record the result in the bug report.

## Correctness Properties

Property 1: Bug Condition - `ext:` refs canonicalize to one skill and install

_For any_ external ref string `r` where `isBugCondition({kind:'ref', ref: r})` holds, the fixed code SHALL satisfy `normalizeSourceRefToSlug(r) = normalizeSourceRefToSlug(strip(r))` with no `ext:` prefix in the result, and `ensureExternalSkillIds` SHALL return the same skill id for `ext:o/r/s`, `o/r/s` and `o/r@s`, creating at most one `skills` row and one assignment. No stored `source_ref` or `slug` contains `ext:`. `normalizeExternalRef` SHALL produce `o/r@s` for `ext:o/r/s`, so the installer receives a valid skills.sh ref and the skill is available on the first tick. A later `add_skills` for the same skill under any spelling SHALL add no row and no assignment.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Bug Condition - Assignment sync preserves provenance of existing assignments

_For any_ sync where `isBugCondition({kind:'sync', ...})` holds, the fixed `syncAgentSkillAssignmentsInTx` SHALL leave `assignment_source`, `assigned_at` and `assigned_by_user_id` of every pre-existing `(agent, skill)` row unchanged, SHALL apply the passed `assignmentSource` only to rows it inserts, and SHALL still update `skill_revision_id` and `order_index` for existing rows.

**Validates: Requirements 2.5**

Property 3: Bug Condition - Legacy rows are merged and repointed

_For any_ database state where `isBugCondition({kind:'row', ...})` holds for some row, the migration SHALL leave zero `skills` rows with `source_ref` or `slug` starting with `ext:`, exactly one canonical row per external skill, every `agent_skills`, `skill_usage_events`, `blueprint_revision_skills`, `skill_entitlements`, `skill_likes` and `billing_usage_events` reference pointing at the canonical skill (and its current revision where a revision is referenced), and at most one `agent_skills` row per `(agent, skill)`. Migrated assignments SHALL keep their `assignment_source`, `assigned_at` and `assigned_by_user_id`. Running the migration twice SHALL change nothing the second time.

**Validates: Requirements 2.6**

Property 4: Preservation - Non-prefixed refs and non-conflicting syncs behave as before

_For any_ input where the bug condition does NOT hold (refs without the `ext:` prefix, platform slugs and ids, two-segment slugs, unknown ids, syncs with only new skills or removals), the fixed code SHALL produce the same result as the original code, preserving id derivation, placeholder creation, 400 responses for unknown ids, revision pinning and `agent_assigned` usage events.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct:

**File**: `packages/db/src/external-skill-catalog.ts`

**Function**: `normalizeSourceRefToSlug`, `ensureExternalSkillIds`

**Specific Changes**:
1. **Strip the prefix once, first**: in `normalizeSourceRefToSlug`, remove leading `ext:` before the existing `@` rewrite. Strip only when the remainder contains a `/`, so `ext:foo` is left alone and rejected as unknown (3.5). Strip repeated prefixes so the function is idempotent.
   ```ts
   const UI_ID_PREFIX = /^(?:ext:)+(?=.*\/)/;

   export function normalizeSourceRefToSlug(ref: string): string {
     const bare = ref.replace(UI_ID_PREFIX, '');
     const at = bare.indexOf('@');
     if (at >= 0 && bare.slice(0, at).includes('/')) {
       return `${bare.slice(0, at)}/${bare.slice(at + 1)}`;
     }
     return bare;
   }
   ```
   Update the doc comment: the prefix is a UI-layer id and is never stored.
2. **Canonicalize before lookup in `ensureExternalSkillIds`**: map each input through `normalizeSourceRefToSlug` only when `isExternalRef` holds on the stripped value, then call `resolveSkillIdsBySlugOrId`. This makes the known-row lookup hit the canonical slug instead of relying on the later upsert. Keep the original input as the output position key. `isExternalRef` is evaluated on the normalized value (so `ext:o/r/s` is an external ref, `ext:foo` is not).
3. **Family lookup**: `familyByRef.get(slug) ?? familyByRef.get(idOrRef)` stays. It now finds the family for an `ext:` input through `slug`.
4. No change to `upsertExternalSkill` or `externalSkillIdForRef`. Both already normalize and now get the stripped value.

**File**: `apps/worker/src/tools/skills.ts`

**Function**: `normalizeExternalRef`

**Specific Changes**:
1. Call `normalizeSourceRefToSlug` (already imported from `@herobids/db` in this file) on the input before the three-segment test. Do not add a second prefix regex. `wasNormalized` is true when the input changed.
2. `add_skills`, `external-skill-startup.ts` and `readInstalledSkillBody`/`deriveSkillDirName` get the fix through this function. This also lets a not-yet-migrated stored `ext:` row install at agent start, which narrows the window between deploy and migration.

**File**: `packages/db/src/skill-assignment.ts`

**Function**: `syncAgentSkillAssignmentsInTx`

**Specific Changes**:
1. Change the conflict update to `set: { skillRevisionId, orderIndex }`. The insert values keep `assignedAt`, `assignedByUserId`, `assignmentSource`.
2. Update the JSDoc: the `assignmentSource` argument applies only to newly inserted assignments.
3. Leave the `agent_assigned` usage-event logic (`previousRevisionId !== assignment.skillRevisionId`) as is.
4. `agent-message-broker.ts` needs no change. Its `'agent_self'` argument is now correct for added skills and ignored for existing ones.

**File**: `packages/db/drizzle/0091_<name>.sql` (+ `meta/_journal.json`, `meta/0091_snapshot.json`)

**Specific Changes**: custom migration created with `drizzle-kit generate --custom`. No schema change, so the snapshot is a copy of 0090. The migration is one `DO $$ ... $$` block (atomic) with this shape:

```
FOR legacy IN SELECT id, current_revision_id, source_ref FROM skills
              WHERE source_ref LIKE 'ext:%' ORDER BY id LOOP
  canon_ref := regexp_replace(legacy.source_ref, '^(ext:)+', '');

  -- 1. Find or create the canonical row.
  SELECT id, current_revision_id INTO canon FROM skills WHERE source_ref = canon_ref;
  IF NOT FOUND THEN
    canon_id  := 'ext_' || substr(encode(sha256(convert_to(canon_ref, 'UTF8')), 'hex'), 1, 24);
    canon_rev := canon_id || ':external:1';
    INSERT INTO skills (...) SELECT canon_id, ..., slug = canon_ref, source_ref = canon_ref, ...
      FROM skills WHERE id = legacy.id;                       -- copy name, description, families, last_installed_at
    INSERT INTO skill_revisions (...) SELECT canon_rev, canon_id, 1, ..., source_ref = canon_ref
      FROM skill_revisions WHERE id = legacy.current_revision_id;
    UPDATE skills SET current_revision_id = canon_rev, published_revision_id = canon_rev WHERE id = canon_id;
  END IF;

  -- 2. agent_skills: agents holding both -> survivor is the canonical row,
  --    provenance copied from the legacy row, order_index = LEAST(both).
  UPDATE agent_skills c SET assignment_source = l.assignment_source,
         assigned_at = l.assigned_at, assigned_by_user_id = l.assigned_by_user_id,
         order_index = LEAST(c.order_index, l.order_index)
    FROM agent_skills l
   WHERE l.skill_id = legacy.id AND c.skill_id = canon.id AND c.agent_id = l.agent_id;
  DELETE FROM agent_skills l USING agent_skills c
   WHERE l.skill_id = legacy.id AND c.skill_id = canon.id AND c.agent_id = l.agent_id;
  --    agents holding only the legacy row -> repoint skill and revision pin.
  UPDATE agent_skills SET skill_id = canon.id, skill_revision_id = canon.current_revision_id
   WHERE skill_id = legacy.id;

  -- 3. Other referencing tables (all keyed to the legacy skill).
  UPDATE skill_usage_events SET skill_id = canon.id, skill_revision_id = canon.current_revision_id
   WHERE skill_id = legacy.id;
  DELETE FROM blueprint_revision_skills l USING blueprint_revision_skills c
   WHERE l.skill_id = legacy.id AND c.skill_id = canon.id
     AND c.blueprint_revision_id = l.blueprint_revision_id;
  UPDATE blueprint_revision_skills SET skill_id = canon.id, skill_revision_id = canon.current_revision_id
   WHERE skill_id = legacy.id;
  UPDATE skill_entitlements e SET skill_id = canon.id WHERE e.skill_id = legacy.id
     AND NOT EXISTS (SELECT 1 FROM skill_entitlements x WHERE x.skill_id = canon.id AND x.user_id = e.user_id);
  UPDATE skill_likes ... (same pattern);
  UPDATE billing_usage_events SET skill_id = canon.id WHERE skill_id = legacy.id;
  UPDATE skills SET fork_of = canon.id WHERE fork_of = legacy.id;

  -- 4. Remove the legacy row (its revisions cascade; remaining entitlements/likes cascade).
  DELETE FROM skills WHERE id = legacy.id;
END LOOP;

IF EXISTS (SELECT 1 FROM skills WHERE source_ref LIKE 'ext:%' OR slug LIKE 'ext:%') THEN
  RAISE EXCEPTION 'ext: skill rows remain after migration';
END IF;
```

Migration notes:
- **Canonical row found by `source_ref`, not by derived id.** A canonical row created earlier always has the derived id, but looking it up by `source_ref` removes the assumption.
- **Re-keying in the no-canonical case** (an agent created with `ext:` that never called `add_skills`): the legacy row is copied to the canonical id and then merged, so `externalSkillIdForRef(ref) = skills.id` holds for every external row afterwards. Updating the primary key in place is avoided because five tables reference it.
- **Provenance rule when an agent holds both rows**: the survivor takes provenance from the legacy row, because the legacy row is the creation-time assignment. If the old bug already rewrote that row to `agent_self` (as in agent `7963e37d`), `agent_self` is carried over. The original value cannot be recovered from the database, and the migration does not invent one.
- **Revision pin**: every repointed `agent_skills`, `skill_usage_events` and `blueprint_revision_skills` row is pinned to the canonical skill's `current_revision_id`. External rows carry a single metadata revision, so no content changes. Both FK columns are updated in the same statement, which satisfies the composite `fk_bprs_skill_revision`.
- **Idempotent**: with no `ext:%` rows the loop does nothing.
- **Forward only**: no down migration. Take the usual database snapshot before production.
- **Live agents**: a running agent keeps its in-memory skill list (legacy id) until its next skill change or restart. The next `onSkillsChanged` or start reads `agent_skills` and gets the canonical id. No runtime change is needed.
- **Pre-flight (read-only) per environment**, before deploy:
  ```sql
  select count(*) from skills where source_ref like 'ext:%';
  select s.id, a.agent_id from agent_skills a join skills s on s.id = a.skill_id where s.source_ref like 'ext:%';
  select count(*) from skill_entitlements e join skills s on s.id = e.skill_id where s.source_ref like 'ext:%';
  select count(*) from skill_likes l join skills s on s.id = l.skill_id where s.source_ref like 'ext:%';
  select count(*) from blueprint_revision_skills b join skills s on s.id = b.skill_id where s.source_ref like 'ext:%';
  ```
  This answers the report's open question "how many agents have both spellings". Entitlements, likes and blueprint rows are expected to be zero for external skills (`authorId` is null). If they are not zero, the migration still handles them.

**Files not changed (and why)**:
- `apps/api/src/routes/agents.ts` `resolveSkillSlugs`: calls `ensureExternalSkillIds`, which now canonicalizes. One fix location, as the report requires.
- `apps/api/src/routes/skills.ts` `mapExternalToSkillView`: the `ext:` view id stays (3.6).
- `apps/worker/src/agents/agent-message-broker.ts`: no change (see Decision 2).
- `.env*` files and `config/default.yaml`: no new configuration.

## Testing Strategy

### Validation Approach

Two phases. First write the exploratory tests and run them on the unfixed code to confirm the root cause. Then verify the fix and preservation. `fast-check` is not a dependency of this repo, and the guidelines say not to add one without justification. The property-style tests below use generated inputs from table-driven loops in Vitest (owner, repo and skill names crossed with the three spellings), not a new library.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples on unfixed code. Confirm or refute the root cause. If refuted, re-hypothesize before writing the fix.

**Test Plan**: Unit tests on the pure functions, DB-backed tests on `ensureExternalSkillIds` and the sync, and one capture of the real web request body. Run all on the unfixed code.

**Test Cases**:
1. **Normalize prefix**: `normalizeSourceRefToSlug('ext:openaidom/skills/job-search')` equals `'openaidom/skills/job-search'` (will fail on unfixed code, returns the input).
2. **Id equality**: `externalSkillIdForRef` returns `ext_54a85bf52d4cb1e1f8d46f7a` for all three spellings (will fail for `ext:`).
3. **Ensure ids, DB**: `ensureExternalSkillIds(db, ['ext:o/r/s', 'o/r/s', 'o/r@s'])` returns three equal ids and `select count(*) from skills where source_ref like '%o/r/s'` is 1 (will fail: two rows).
4. **Installer ref**: `normalizeExternalRef('ext:o/r/s').ref === 'o/r@s'` (will fail: returns `ext:o/r@s`).
5. **Provenance**: insert an `agent_skills` row with `user_select` and `assigned_at = T0`, call `syncAgentSkillAssignmentsInTx(..., 'agent_self')` with that skill plus a new one; assert the old row is unchanged and the new row is `agent_self` (will fail: old row rewritten).
6. **Web request body** (manual, one time): create an agent from the web form with an external skill and record the `skillIds` in the `POST /agents` body, closing the unverified step in the report.
7. **Edge, non-ref**: `ensureExternalSkillIds(db, ['ext:foo'])` and `['ext_5ed356e3a5c0385824eb9fbf']` return the input unchanged (should pass on both unfixed and fixed code).

**Expected Counterexamples**:
- `ext:`-prefixed input yields a different id and a second row.
- Existing assignment rows come back with `agent_self` and a new `assigned_at`.
- Possible causes: `normalizeSourceRefToSlug` ignores the prefix; `onConflictDoUpdate` sets provenance columns; `normalizeExternalRef` splits on `/` without stripping.

### Fix Checking

**Goal**: For all inputs where the bug condition holds, the fixed code gives the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  CASE input.kind OF
    'ref':  ids := ensureExternalSkillIds_fixed(db, [input.ref, bare(input.ref), atForm(input.ref)])
            ASSERT ids[0] = ids[1] = ids[2]
            ASSERT no stored source_ref/slug startsWith 'ext:'
            ASSERT normalizeExternalRef_fixed(input.ref).ref = atForm(input.ref)
    'sync': after := syncAgentSkillAssignmentsInTx_fixed(input)
            FOR EACH id IN input.requested WHERE id IN keys(input.existing) DO
              ASSERT provenance(after, id) = input.existing[id]
            FOR EACH id IN input.requested WHERE id NOT IN keys(input.existing) DO
              ASSERT assignment_source(after, id) = passedSource
    'row':  migrate(db)
            ASSERT count(skills WHERE source_ref LIKE 'ext:%' OR slug LIKE 'ext:%') = 0
            ASSERT no (agent, skill) has more than one agent_skills row
            ASSERT every FK-bearing table references a canonical skill
            ASSERT provenance of surviving assignments = provenance carried from legacy row
  END CASE
END FOR
```

### Preservation Checking

**Goal**: For all inputs where the bug condition does NOT hold, the fixed code gives the same result as the original code.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT original(input) = fixed(input)
END FOR
```

**Testing Approach**: Property-style tests are the best fit because the input domain (ref spellings, skill id kinds, sync shapes) is large and the rule is "identical output". Generate inputs from the cross product of the categories below and compare the fixed function against a frozen copy of the pre-fix logic (inlined in the test as `legacyNormalize`) or against recorded expected values.

**Test Plan**: Observe results on the unfixed code first (ids for canonical and `@` refs, 400 for unknown ids, placeholder creation), then pin them.

**Test Cases**:
1. **Canonical and `@` ids**: for generated `owner/repo/skill`, `normalizeSourceRefToSlug` and `externalSkillIdForRef` give the same value as before; the ids of the existing rows in the evidence (`ext_54a85...`) are unchanged.
2. **Platform and marketplace refs**: `system/programming`, a legacy id, and `author/name` still resolve through `resolveSkillIdsBySlugOrId` and are not routed to `upsertExternalSkill` (3.2, 3.3).
3. **Unknown refs and ids**: unknown three-segment ref gets a placeholder row; unknown id returns 400 `validation_error` with the same message (3.4, 3.5).
4. **Skills list view**: `mapExternalToSkillView` still returns `ext:<ref>` and `o/r@s` (3.6).
5. **Sync without conflict**: syncs that only insert new assignments or only delete some produce the same rows, `order_index` values and `agent_assigned` usage events as before (3.9). A revision change on an existing row still updates `skill_revision_id` and still emits the event.
6. **`add_skills` for canonical and `@` refs**: existing `skills-catalogued-external.test.ts` and `agent-broker.test.ts` pass unchanged (3.8).

### Unit Tests

- `normalizeSourceRefToSlug`: `ext:o/r/s`, `ext:o/r@s`, `ext:ext:o/r/s`, `o/r/s`, `o/r@s`, `ext:foo`, `ext:`, `ext_<hash>`, `system/x`, `author/name`.
- `externalSkillIdForRef`: equal for the three spellings.
- `normalizeExternalRef`: `ext:o/r/s` becomes `o/r@s`; `o/r@s` unchanged; two-segment ref unchanged.
- `ensureExternalSkillIds`: three spellings in one list return one id repeated; order preserved; `familyByRef` applied through an `ext:` input.
- `syncAgentSkillAssignmentsInTx` provenance: existing row keeps source, `assigned_at`, `assigned_by_user_id`; new row gets the passed source; revision and order still update; `agent_assigned` event only on revision change.

### Property-Based Tests

- Over generated `(owner, repo, skill)` triples: all three spellings give one normalized slug, one id, and `normalizeSourceRefToSlug` is idempotent.
- Over generated non-prefixed inputs: fixed `normalizeSourceRefToSlug` equals the pre-fix implementation.
- Over generated agent states (existing assignments with random sources, requested sets with random overlap): after sync, existing rows keep provenance, new rows get the passed source, and the final set equals the requested set.
- Over generated legacy datasets (random mix of: legacy only, legacy plus canonical, agents holding one or both): after the migration the invariants in Property 3 hold, and a second run is a no-op.

### Integration Tests

- **Migration test** (Postgres, in the `*.integration.test.ts` style and added to `test:integration`): seed the evidence shape (legacy row `ext_5ed...` + canonical row `ext_54a85...`, one agent holding both, with `order_index` 0 and 5), plus an agent holding only a legacy row, a legacy row with no canonical row, a `skill_usage_events` row and a `blueprint_revision_skills` row on the legacy skill. Run the migration SQL; assert the Property 3 invariants and idempotence.
- **API flow**: `POST /agents` with `ext:o/r/s`, then `PATCH` with `o/r@s`; one `skills` row, one `agent_skills` row, `GET /agents/:id` lists the skill once.
- **Worker flow**: with a fake `ExternalSkillInstaller`, run `add_skills(['o/r@s'])` for an agent created with `ext:o/r/s`; the broker call adds nothing new, the existing assignment keeps `user_select`, and the installer is called with `o/r@s`.
- **Agent start**: `external-skill-startup` with a skill whose stored `source_ref` is canonical installs on the first attempt (installer called with `o/r@s`, `available: true`).
- **Local verification** (per the bug report constraints): reproduce on a fresh local agent, not by editing the shared database. After the fix, create a `job-search` agent through the web form and confirm one skill, available at the first tick.
