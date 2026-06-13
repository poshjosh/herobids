# 007 — Functional tests: `truncate-reseed-skills` asserts stale `visibility` field

**Date:** 2026-06-13  
**Severity:** Low  
**Component:** `apps/api/src/__tests__/functional/truncate-reseed-skills.functional.test.ts`

## Summary

Three tests in `truncate-reseed-skills.functional.test.ts` asserted `skill!.visibility === 'public'`. The `visibility` field was removed from the skills schema in a prior refactor and replaced with `publicationStatus`. The tests were never updated, causing them to always fail (accessing `undefined` and comparing to `'public'`).

## Root Cause

Schema rename from `visibility: 'public'|'private'|'draft'` to `publicationStatus: 'published'|'private'|'draft'` was not reflected in these tests.

## Fix

Replaced all `skill!.visibility` with `skill!.publicationStatus` and all `'public'` comparisons with `'published'` in the three affected tests (bot-management, trading, risk-monitoring system skills).

## Impact

- All three system skill truncate-reseed functional tests were failing
