# Bug Report: Agent form skill search only filters pre-loaded first page

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-08-30
- **Summary:** The skill search input in the agent create/edit form filtered client-side against a single pre-loaded page of skills, making skills beyond the first page undiscoverable via search.

## Root Cause

The `SkillPicker` component received skills as a prop from its parent
(`CreateAgentPage` / `EditAgentModal`). Both parents fetched skills with
`skillsApi.list({ scope: 'selectable' })` — no `q` parameter, no pagination
control. This returned only the first default page of results.

When the user typed in the search input, `SkillPicker` filtered this
already-loaded subset using `String.includes()` in a `useMemo`. It never
triggered a new API call with the search term. Any skill not on the first page
was invisible to the search.

The standalone skills page (`SkillsPage.tsx`) had already been fixed to use
server-side search with a debounced `q` parameter, but the agent form's
`SkillPicker` was not updated to match.

## Fix

Refactored `SkillPicker` to be self-contained for search:

1. Added a debounced search state (300ms) that triggers a server-side query
   with the `q` parameter when the user types.
2. When no search term is active, the component uses either the parent's
   pre-loaded `initialSkills` prop or fetches its own default set.
3. Changed the `skills` prop (required) to `initialSkills` (optional) to
   support both patterns.
4. Updated both call sites (`AgentsPage.tsx` for create, `EditAgentModal.tsx`
   for edit) to pass `initialSkills` instead of `skills`.

## Files Changed

- `apps/web/src/features/agents/SkillPicker.tsx` — rewrote to use server-side search via `useQuery` with debounced `q` parameter
- `apps/web/src/features/agents/AgentsPage.tsx` — updated `SkillPicker` prop from `skills` to `initialSkills`
- `apps/web/src/features/agents/EditAgentModal.tsx` — updated `SkillPicker` prop from `skills` to `initialSkills`

## Verification

- `pnpm lint` passes with zero errors.
