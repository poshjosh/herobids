# Skill Preset Naming Alignment Plan

## Status

`todo`

## Goal

Align the non-trading assistant preset name across frontend, domain, and API.

The system should use one canonical preset identifier everywhere.

Decision required:

1. standardize on `personal-assistant`
2. revert to `reminder`

This plan covers only that naming alignment work.

## Current Mismatch

### Frontend

- `apps/web/src/features/agents/agent-display.ts` defines `SkillPresetId = 'trading' | 'personal-assistant' | 'custom'`
- `apps/web/src/features/agents/agent-display.ts` maps `'personal-assistant': ['task-management', 'web-access']`
- `apps/web/src/features/agents/AgentsPage.tsx` renders the preset option with value `personal-assistant`

### Domain

- `packages/domain/src/skills.ts` defines `SKILL_PRESET_MAP` with `reminder` and does not define `personal-assistant`

### API

- API functional coverage still references `Reminder Agent` in `apps/api/src/__tests__/functional/agents.functional.test.ts`

## Scope

### In scope

1. Choose one canonical preset ID for the assistant preset.
2. Update frontend references to use the canonical ID.
3. Update domain preset mappings to use the canonical ID.
4. Update API tests and any API-facing labels or fixtures that still use the old name.
5. Update related docs that describe agent skill presets.

### Out of scope

1. Changing which skills belong to the assistant preset.
2. Adding `programming` or `file-management` to any preset.
3. Redesigning the preset model beyond this naming fix.
4. General skill-system changes.

## Recommendation

Prefer standardizing on `personal-assistant`.

Reasoning:

1. the frontend already uses `personal-assistant`
2. the current skill bundle is broader than reminders alone because it includes `task-management` and `web-access`
3. `personal-assistant` better matches the user-facing behavior than `reminder`

If product language should remain simpler and more notification-oriented, reverting everything to `reminder` is also valid. The key requirement is that only one identifier survives.

## Target State

Exactly one canonical preset identifier exists for the assistant preset across:

1. frontend preset types and mappings
2. domain preset mappings
3. API tests and fixtures
4. user-facing documentation

No layer should refer to both `personal-assistant` and `reminder` as preset IDs.

## Files To Update

### Frontend

- `apps/web/src/features/agents/agent-display.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
- any related frontend i18n strings or preset helpers that reference the old ID

### Domain

- `packages/domain/src/skills.ts`

### API

- `apps/api/src/__tests__/functional/agents.functional.test.ts`
- any API request/response helpers or validation code that reference the old ID

### Docs

- `docs/tech/domain-language.md`
- any docs that mention the assistant preset by ID

## Implementation Plan

1. Choose the canonical preset ID.
   Decision: either `personal-assistant` or `reminder`.
   Dependency: none.

2. Update the domain preset map.
   File: `packages/domain/src/skills.ts`.
   Change: replace the non-canonical preset key with the canonical one in `SKILL_PRESET_MAP`.
   Dependency: step 1.

3. Update frontend preset typing and mapping.
   Files: `apps/web/src/features/agents/agent-display.ts`, `apps/web/src/features/agents/AgentsPage.tsx`.
   Change: make preset IDs, preset-to-skill mapping, and preset option values use the canonical identifier.
   Dependency: step 1.

4. Update API tests and fixtures.
   Files: `apps/api/src/__tests__/functional/agents.functional.test.ts` and any related test fixtures.
   Change: rename preset references and expected labels to match the canonical identifier.
   Dependency: step 1.

5. Update docs.
   Files: `docs/tech/domain-language.md` and any docs that mention the assistant preset by ID.
   Change: remove the non-canonical preset name from documentation.
   Dependency: step 1.

6. Add or update focused tests.
   Change: cover the preset mapping and create-agent flow so the same preset ID is used consistently end-to-end.
   Dependency: steps 2 through 4.

## Verification

- search the repo for both `personal-assistant` and `reminder`
- confirm only the chosen preset ID remains as a preset identifier
- run focused frontend and API tests that cover agent creation and preset mapping
- run `pnpm lint`

## Exit Criteria

- The assistant preset has one canonical ID across frontend, domain, and API.
- The non-canonical preset ID is no longer used as a preset identifier.
- Preset mappings and create-agent flows reference the same identifier.
- Related tests and docs reflect the same naming.
