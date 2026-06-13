# 005 — Skills route: `resolveCreationPublicationStatus` incorrect priority ordering

**Date:** 2026-06-13  
**Severity:** Medium  
**Component:** `apps/api/src/routes/skills.ts`

## Summary

`resolveCreationPublicationStatus` evaluated plan-policy logic in the wrong order. When `autoPublishNonDraftSkills: true` was set on a plan, a skill explicitly created without a `publicationStatus` (or with `publicationStatus: 'draft'`) was being returned as `'published'` instead of `'draft'`. This caused functional tests to fail (`expected 'draft' but got 'published'`) and violated the intended contract that an explicit `draft` request always takes precedence over plan auto-publish.

## Root Cause

The function checked `autoPublishNonDraftSkills` before checking for an explicit `'draft'` input, so the plan policy always overrode the caller's intent.

Additionally, `CreateSkillSchema` had `.default('draft')` on `publicationStatus`, which prevented distinguishing "caller explicitly sent draft" from "caller sent nothing". The default was removed so the function could distinguish the two cases.

## Fix

1. Removed `.default('draft')` from `publicationStatus` in `CreateSkillSchema` so it becomes `string | undefined`.
2. Changed `resolveCreationPublicationStatus` to accept `'draft' | 'private' | 'published' | undefined`.
3. Restored correct evaluation order:
   - Explicit `'draft'` → always returns `'draft'`
   - `autoPublishNonDraftSkills && input != 'draft'` → returns `'published'`
   - Explicit `'published'` → returns `'published'`
   - Private availability check → returns `'private'` or `'draft'`
   - Default fallback → `'draft'`

## Impact

- Skills created without explicit visibility on auto-publish plans were always published, ignoring user intent
- Functional tests for skill creation were failing
