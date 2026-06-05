# 2026-06-06-08 — API Functional Helpers: Imports Non-Existent instanceRoutes

**Date:** 2026-06-06  
**Severity:** High  
**Files:** `apps/api/src/__tests__/functional/helpers.ts`

## Summary

Functional test helper imported `instanceRoutes` from `../../routes/instances.js` which does not exist. This caused `agents.functional.test.ts` and `auth.functional.test.ts` to fail at import time.

## Root Cause

The file was renamed/replaced: `instances.ts` → `bots.ts` at some point, but the test helper was not updated.

## Fix

Changed import to `botRoutes` from `../../routes/bots.js` and updated the call site accordingly.

## Tests Fixed

`apps/api/src/__tests__/functional/agents.functional.test.ts`, `apps/api/src/__tests__/functional/auth.functional.test.ts`
