# Agent Unknown Skill Refusal — Plan

Status: Ready to build (revision 1, no open questions)
Date: 2026-11-22
Related: [Agent Child Grant Scope](docs/features/2026/11/22/002-agent-child-grant-scope/001-plan.md) (shares step 1, the refusal body pass-through), [Agent Child Execution Mode](docs/features/2026/11/22/001-agent-child-execution-mode/001-plan.md).

## 1. Problem

When an agent names a skill ref the catalogue does not know, `POST /agents` creates a placeholder catalogue row for it, then carries on. The create is usually refused later, but the row stays.

Seen on a local stack. The coordinator agent `crypto-trading-coord` (`51c5c436-94f5-4b47-845a-5387fc25bcc8`) was told in its prompt to give children `openaidom/skills/crypto-trading`. No such skill exists upstream: the `openaidom-skills` repo holds only `flight-deal-monitoring`, `job-search`, `lost-or-stolen-item-finder` and `raw-text-to-bitwarden-csv-converter`. The database nonetheless holds a published, free `openaidom/skills/crypto-trading` row (`ext_ac313eba…`), beside the real `traderton/skills/crypto-trading` (`ext_d78027db…`). `openaidom/skills/crypto-ict-swing-trading` is the same kind of row: the files live in the traderton skills repo.

Two rows named `crypto-trading` sent the coordinator in circles. It could not tell the real skill from the phantom, and the grant check kept refusing with `agent.create.grant_not_held`. I also gave the wrong advice, to assign the phantom to the parent. Nothing upstream could be installed for it.

Cause, from the code:

- `resolveSkillSlugs` (`apps/api/src/routes/agents.ts` ~line 591) calls `ensureExternalSkillIds` (`packages/db/src/external-skill-catalog.ts`).
- For any three-segment ref (`owner/repo/skill`) that is not yet catalogued, that function upserts a metadata-only row: name is the last segment, description empty. Its comment says agent creation is never blocked by an unknown ref. That was written for users, who pick refs from a search.
- `POST /agents` runs `resolveSkillSlugs` before the child-create policy, so a guessed ref creates a row even when the create is then refused with 403.
- I inferred that the phantom rows are placeholders. I did not read their descriptions or revisions, and the stack was down when I checked.

## 2. Goal

An agent that supplies a skill ref the catalogue does not know gets a clear refusal, and no catalogue row is written. The refusal names the closest real ref. User-created agents behave as today.

## 3. Decisions

- Applies to agent callers only (`request.actingAgentId` set). Users, blueprints, Go Live and the startup catalogue step keep today's behavior, including placeholders.
- A refused ref is a validation error, not a placeholder. The code is `agent.create.unknown_skill`.
- The refusal carries up to 3 suggestions, matched on the ref's last segment. No fuzzy matching in this release.
- An agent that needs a skill that is not in the catalogue installs it first with `add_skills`, which runs the installer and catalogues it properly. It is then held by the parent and usable for children.
- Existing phantom rows are out of scope here. A volume reset removes them. If a stack keeps its volume, clean the rows by hand after checking `agent_skills` for references.

## 4. What the code does today

- `resolveSkillSlugs` is called from two routes: `POST /agents` (~line 909) and `PATCH /agents/:id` (~line 1594). PATCH requires a user (`requireUserCaller`), so only `POST /agents` can have an agent caller.
- It drops legacy `task-management` refs, then calls `ensureExternalSkillIds`, then `resolveSkillIdsBySlugOrId`. A ref that still does not resolve returns `400 validation_error` with `Unknown skills: …`. After `ensureExternalSkillIds`, only non-ref values (ids, platform slugs, two-segment `author/name`) can reach that error.
- `ensureExternalSkillIds` is also called at API startup for the operator's approved refs (`apps/api/src/index.ts`). That call is unaffected.
- `normalizeSourceRefToSlug` and `externalSkillIdForRef` already canonicalise `ext:`, `owner/repo@skill` and `owner/repo/skill` spellings. The suggestion helper reuses the normalizer.
- A skill the parent holds is always catalogued, because assignment needs a catalogue row. So a legitimate grant never depends on a placeholder.
- Errors use `errorPayload(code, message, params)` from `apps/api/src/error-payload.ts`.
- The agent client drops the response body today, so the agent sees only the status summary. That is step 1 in both sibling plans. The suggestion is useless to the agent without it.

## 5. Design

### 5.1 Skip placeholder creation for agent callers

`resolveSkillSlugs` takes a flag for agent callers. In that mode it skips `ensureExternalSkillIds` and resolves with `resolveSkillIdsBySlugOrId` only. Keep the existing `task-management` drop. Pass the flag from `POST /agents` as `Boolean(request.actingAgentId)`. The PATCH call keeps `false`.

Canonicalise the refs before the lookup in agent mode too, so `ext:o/r/s`, `o/r@s` and `o/r/s` all find the same row. `resolveSkillIdsBySlugOrId` matches slug or id, and a catalogued external row stores the canonical three-segment form as its slug, so normalising first is enough.

### 5.2 The refusal

For each unresolved ref in agent mode:

```
400 agent.create.unknown_skill
message: Unknown skill: <ref>. <Did you mean traderton/skills/crypto-trading?>
params: { unknown: [ref…], suggestions: { <ref>: [slug…] } }
```

- A single response lists every unknown ref, so the agent does not fix them one at a time.
- Status 400 is non-retryable in the tool, the same as the existing validation errors.
- Keep the existing `validation_error` shape for user callers.

### 5.3 Suggestions

A helper `suggestSkillRefs(db, unknownRefs)` in `packages/db/src/external-skill-catalog.ts`, next to `normalizeSourceRefToSlug`:

- Take the last segment of the normalised ref (`crypto-trading` from `openaidom/skills/crypto-trading`).
- Find catalogue rows whose slug ends with `/<segment>`, or whose slug equals it. One query for all unknown refs.
- Return at most 3 slugs per unknown ref, published rows first, then by slug. Rows that are placeholders (`description = ''`) rank below rows with a description, so a phantom never suggests a phantom.
- An ref with no match returns an empty list, and the message omits "Did you mean".
- Only rows the caller may select are returned. Reuse `isSkillSelectableForUser`, or filter to published and free skills, so a suggestion never points at a skill the agent could not use anyway.

### 5.4 Order of checks in the create route

The unknown-skill refusal runs where `resolveSkillSlugs` runs today, after the rate token and the field allowlist and before the policy. That keeps the order the route already has, and it means a refused ref never reaches the policy or the boundary. The rate token is still consumed, as for every attempt.

### 5.5 Metrics

The outcome set (`CREATE_AGENT_OUTCOMES`) is closed. Add `unknown_skill` and set it at this refusal, the way `field_refused` is set. Update `docs/tech/architecture/observability.md`. No change to `createAgentOutcomeForRule`, since this is not a policy rule.

### 5.6 Tool and skill text

- `create_child_agent` description for `skillIds`: say that only skills the catalogue knows are accepted, that an unknown skill is refused with suggestions, and that a new skill is installed first with `add_skills`.
- `child-agent-management` skill: on `agent.create.unknown_skill`, use a suggestion only if it matches the intent, otherwise report to the user. Do not retry with guessed refs.
- The coordinator's own prompt in the local stack still names the phantom ref. That is user data, not code. Mention it in the PR notes.

## 6. Behavior change to state in the docs

An agent could previously name a skills.sh ref that was not catalogued and get a placeholder. That create was refused anyway unless the parent held the skill, and a held skill is already catalogued, so the old behavior never produced a working child. With the grant-any-skill toggle from the sibling plan, an agent that wants a new external skill for a child now has to install it first. This is the intended behavior.

## 7. Tests

- Agent caller names an uncatalogued three-segment ref: 400 `agent.create.unknown_skill`, no row in `skills` (count before and after), no row in `skill_revisions`, no child created.
- The refusal lists every unknown ref and its suggestions in one response.
- Suggestion: unknown `openaidom/skills/crypto-trading` with a catalogued `traderton/skills/crypto-trading` returns that slug. Max 3. Empty when there is no match.
- Suggestion ranking: a placeholder row does not outrank a row with a description; a row the user cannot select is not suggested.
- Spellings: `ext:o/r/s` and `o/r@s` resolve to the same catalogued row for an agent caller, with no new row.
- A catalogued external ref held by the parent still works for a child (regression).
- User caller names an uncatalogued ref: placeholder row is created as today (regression). Blueprint and Go Live paths unchanged.
- `PATCH /agents/:id` with an uncatalogued ref keeps today's behavior.
- A refused attempt consumes a rate token and records the `unknown_skill` outcome once.
- Worker: the tool result carries the refusal body, including `params.suggestions`.

## 8. Rollout

1. Pass the refusal body through for all 4xx (shared with the grant-scope plan, step 1). Do it once.
2. `suggestSkillRefs` helper and tests in `packages/db`.
3. Route change: the agent flag in `resolveSkillSlugs`, the refusal, the metrics outcome.
4. Tool description and skill text.
5. Docs: [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md) (a new row in the creation rules table, between Fields and Grant), the observability doc, and CHANGELOG.

Steps 2 and 3 can ship before 1, but the agent will not see the suggestions until 1 is in. No migration. No `.env` or operator config change, so no `.example` update.

## 9. Before Building

- Search `docs/bug-reports/` and read `git log` for `external-skill-catalog.ts` and the `resolveSkillSlugs` call sites. The `ext:` prefix merge (`0091_merge_ext_prefixed_skills.sql`, commit `2fdd3c50`) touched the same code, and the canonicalisation in §5.1 must stay consistent with it.
- Read `docs/best-practices/README.md` and the documents it points to for API changes.
- Confirm how the web skill picker and the guided chat obtain refs. They must keep using the user path. I did not check them.
- Decide whether `suggestSkillRefs` belongs in `packages/db` or in the API. I lean towards `packages/db`, beside the other catalogue helpers.

## 10. Out of Scope

- Removing existing phantom rows (a volume reset does it).
- Fuzzy or typo matching beyond the last-segment match.
- Changing what `ensureExternalSkillIds` does for users or at startup.
- The `openaidom/skills/crypto-ict-swing-trading` ref pointing at the wrong repo. The correct ref is probably `traderton/skills/crypto-ict-swing-trading`. Fix the data or the prompt that uses it.
- Why the two `herobids/...` skills exist and who authored them. That needs a database read.

## 11. Open Questions

None.
