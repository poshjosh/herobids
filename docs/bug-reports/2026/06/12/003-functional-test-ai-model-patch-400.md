# 003 — Functional test `PATCH /settings/ai-model` returns 400 without `LLM_API_KEY_OPENAI`

**Date:** 2026-06-12  
**Severity:** Medium (blocks functional test suite)  
**Affected files:**
- `apps/api/src/__tests__/functional/analytics-ai-skills-datasets.functional.test.ts`

## Symptoms

The functional test `persists the model preference for the authenticated user` failed with HTTP 400 when calling `PATCH /settings/ai-model` with `provider: 'openai'`.

## Root Cause

The API's AI model settings endpoint checks for provider availability at request time by inspecting the `LLM_API_KEY_<PROVIDER>` environment variable. In the functional test environment `LLM_API_KEY_OPENAI` was not set, so `openai` was treated as unavailable and the request was rejected with a validation error.

## Fix Applied

In the test, set `process.env['LLM_API_KEY_OPENAI'] = 'test-key'` before making the request and delete it in a `finally` block so the test is self-contained and does not pollute the environment for other tests.
