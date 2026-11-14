# Bug Report: Agents created with an external skill get it attached twice (and it fails to install at start)

- **Status:** OPEN (reported, not investigated or fixed)
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

## Fix

Not started.

## Files Changed

None.

## Verification

None yet. The evidence above was read with `psql` selects, `docker logs` and `shasum` only.
