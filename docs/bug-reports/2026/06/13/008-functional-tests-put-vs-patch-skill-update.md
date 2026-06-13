# 008 — Functional tests: `analytics` uses `PUT` instead of `PATCH` for skill update

**Date:** 2026-06-13  
**Severity:** Low  
**Component:** `apps/api/src/__tests__/functional/analytics-ai-skills-datasets.functional.test.ts`

## Summary

The "updates own skill" and "deletes own skill" tests used `method: 'PUT'` to update a skill. The API route is registered as `PATCH /skills/:id`, not `PUT`. Fastify returns 404 for unregistered method+path combinations, causing both tests to fail.

## Root Cause

The route was likely `PUT` in an earlier version and was renamed to `PATCH` during a refactor, but the test file was not updated.

## Fix

Changed `method: 'PUT'` to `method: 'PATCH'` in both tests. Also added `publicationStatus: 'draft'` to the skill creation payloads so the skills were not auto-published before the update/delete steps.

## Impact

- "updates own skill" and "deletes own skill" functional tests were returning 404 and failing
