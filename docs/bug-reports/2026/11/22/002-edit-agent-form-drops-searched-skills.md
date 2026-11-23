# Bug Report: Edit agent form drops skills picked through search, and cannot remove held skills outside the first page
- **Status:** OPEN (found by code reading; not reproduced in a running app)
- **Severity:** Medium
- **Date:** 2026-11-22
- **Summary:** In the edit agent form, a skill picked through the skill picker's search is silently left out of the save if it is not among the first 20 selectable skills. The reverse also holds: a skill the agent already has, outside that first page, cannot be removed in the form.

## Root Cause
`EditAgentModal.tsx` loads selectable skills once with `skillsApi.list({ scope: 'selectable' })`. The API's default `pageSize` is 20 (`apps/api/src/routes/skills.ts`), so the form holds one page. The picker's search is a separate query (`pageSize` 50, `q=...`) and can return skills outside that page.

On save, the mutation builds the skill list from that one page:

```ts
const skillIds = Array.from(new Set([...preservedSkillIds, ...form.skillIds.filter((skillId) => selectableSkillIds.has(skillId))]));
```

- `selectableSkillIds` is the first page only, so a search-picked skill outside it is filtered out. The user sees it selected, the PATCH does not carry it, and no error is shown.
- `preservedSkillIds` is every skill the agent already had that is not in the first page. It is added back on every save, so deselecting such a skill in the picker has no effect.

The filter is redundant. The `PATCH /agents/:id` handler (`apps/api/src/routes/agents.ts`, around line 1794) already calls `resolveSkillAssignmentsForUser` with the agent's existing skill ids as preserved ids. It returns 400 `Non-selectable skillIds` for any new skill the user cannot select, and existing skills stay allowed. The web filter duplicates that check using an incomplete list.

History: the filter and `preservedSkillIds` came in with commit `7d17d4ae` (2026-06-07, capability platform API redesign). The first-page list is the same cause as the 2026-11-22 tick-interval incident (the create form classified trading skills from the same one-page list), which is why this was noticed. It cannot cause a wrong tick: the dropped skill is never sent, so the API sees no skill change.

## Impact
- Silent data loss: a skill the user picked is not saved, with no message.
- A held skill outside the first page cannot be removed through the edit form.
- Search-picked trading skills are invisible to the form's own trading logic (`selectedSkillsHaveCapabilityFamily`, `hasTradingCapability`), which also reads the first-page list. Auto-selecting a connection and showing the trading setup fields do not react to them until the agent is saved and reopened.

## Proposed Fix
- Send `form.skillIds` as they are. Delete the filter and `preservedSkillIds`, and let the API's existing check reject non-selectable ids.
- Add a DOM test: pick a skill through search that is not in the first page, save, and assert the PATCH carries it. Add one for removing a held skill outside the first page.
- Confirm an API test pins the 400 for a non-selectable skill id on PATCH.
- Estimated effort: 1 to 2 hours.

## Known Gap (separate follow-up)
The form's trading classification still comes from the first-page list. Fixing it needs the picker to return the selected skill objects, or the form to cache the skills it has seen. The create form has the same dependency. About half a day for both forms.

## Related
- `docs/features/2026/11/22/003-non-trading-tick-interval-resolver/001-plan.md` (Outstanding Issues, final gap review rework).
- `docs/bug-reports/2026/10/06/003-external-skill-view-drops-backend-approved-capability-family.md` (earlier mismatch between web and server trading classification).

## Verification
Not run. This report comes from reading `EditAgentModal.tsx`, `SkillPicker.tsx` and the PATCH handler, and from the implementer's and reviewer's findings during the tick-interval work. It has not been reproduced in a browser.
