# Bug Report: GET /skills Empty List Test Broken by System Skills

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-08
- **Summary:** Functional test `GET /skills > returns an empty list for a new user` failed after system skills were seeded, because the skills route returns all `visibility='public'` and `authorId=NULL` skills to any authenticated user.

## Root Cause

After migrations 0008/0009 seeded system skills (`bot-management`, `risk-monitoring` with `visibility='public'`, `authorId=NULL`), and the `truncateAll()` fix re-seeded them after each truncation, the test assertion `expect(skills).toEqual([])` became incorrect. The `/skills` endpoint explicitly returns all public and system skills in addition to user-owned skills.

## Fix

Updated the test in `analytics-ai-skills-datasets.functional.test.ts`:
- Renamed: "returns an empty list for a new user" → "returns only system skills for a new user (no user-created skills)"
- New assertion: filters out system skills (`authorId === null`) and checks only user-created skills are empty

## Files Changed

- `apps/api/src/__tests__/functional/analytics-ai-skills-datasets.functional.test.ts`

## Verification

Functional tests: 88/88 passed after fix.
