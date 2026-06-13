# 009 — Skills route: `buildSkillViews` omits `forkOf` from returned view

**Date:** 2026-06-13  
**Severity:** Medium  
**Component:** `apps/api/src/routes/skills.ts` (`buildSkillViews`)

## Summary

`buildSkillViews` did not include `forkOf` in the returned view object. When a skill was created as a fork (`forkOf` is set in the DB row), the API response always returned `forkOf: undefined`, making it impossible for clients to know which skill was forked.

## Root Cause

The field was present in the database row but was not mapped into the `SkillView` type or the `buildSkillViews` return statement.

## Fix

1. Added `forkOf: string | null` to the `SkillView` type.
2. Added `forkOf: row.forkOf ?? null` to the `buildSkillViews` return object.

## Impact

- Fork relationships were invisible in the API response
- Frontend `skill.forkOf` was always `undefined` for forked skills
