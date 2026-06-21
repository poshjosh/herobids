# Bug Report: DeepSeek 400 — Invalid Tool Schema `exclusiveMinimum` Boolean

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-21

## Summary

Any agent tick that invokes `list_bots` (or any tool whose Zod schema uses `.positive()`, `.negative()`, etc.) fails with a provider 400 error when the configured LLM provider is DeepSeek. The agent cannot complete a tick and no decision is submitted.

## Symptoms

Event from the agent activity feed:

```
eventType:    llm.completed
phase:        judge
model:        deepseek-v4-pro
turnsUsed:    0
finishReason: error
errorMessage: Provider returned 400: {"error":{"message":"Invalid schema for
              function 'list_bots': true is not of type \"number\"",
              "type":"invalid_request_error","code":"invalid_request_error"}}
```

`turnsUsed: 0` confirms the error is returned before any LLM reasoning occurs — the provider rejects the request at schema validation time.

## Root Cause

`zod-to-json-schema` with `target: 'openAi'` emits JSON Schema **Draft 4** for Zod's
`.positive()` / `.negative()` / `.nonnegative()` constraints:

```json
{ "type": "integer", "minimum": 0, "exclusiveMinimum": true }
```

In Draft 4, `exclusiveMinimum` is a **boolean flag** paired with `minimum`.  
In JSON Schema **Draft 7** (which DeepSeek and most modern providers follow),
`exclusiveMinimum` must be a **number** — the 400 error is the provider rejecting
the boolean form.

Claude and OpenAI accept the Draft 4 boolean form silently, so the bug was latent.
It only surfaced when production was switched from OpenRouter/Claude to DeepSeek
in commit `4e2d00a` (2026-06-19).

Affected tools (14+ `.positive()` uses across 5 files):
`list_bots`, `get_analytics`, `check_regime`, `search_tokens`, `discover_tokens`,
`adjust_risk_limits`, `watch_token`, and others in `market-data.ts`.

## Why Tests Did Not Catch It

1. **Provider mismatch:** The agent trade test (`agent-trade-test.sh`) targets
   `localhost:3000`, which uses `development.yaml` (OpenRouter/Claude). DeepSeek
   was only in `production.yaml`. The schema bug existed before but was never
   exercised by any test.

2. **No assertion on `llm.completed` error events:** The trade test checks for
   rejected *decisions* (`status === 'rejected'`). A provider 400 aborts the tick
   before a decision is created, so the check passes even when the agent is broken.

3. **No unit test for schema output:** `convertZodToJsonSchema` had no test
   asserting the JSON Schema draft format of its output.

## Fix

Added `normalizeDraft4ExclusiveBounds()` in
`apps/worker/src/tools/registry.ts`, called inside `convertZodToJsonSchema`.
The function recursively walks the generated schema and converts:

```
{ minimum: N, exclusiveMinimum: true }  →  { exclusiveMinimum: N }
{ maximum: N, exclusiveMaximum: true }  →  { exclusiveMaximum: N }
```

This is a single-point fix — all 14+ affected tool schemas are corrected at
generation time without touching individual schema definitions. Future `.positive()`
uses are also covered automatically.

## Files Changed

- `apps/worker/src/tools/registry.ts` — added `normalizeDraft4ExclusiveBounds()`; applied in `convertZodToJsonSchema`
- `apps/worker/src/tools/tool-registry.test.ts` — three new tests:
  - `emits numeric exclusiveMinimum (Draft 7) for z.number().positive()`
  - `emits numeric exclusiveMaximum (Draft 7) for z.number().negative()`
  - `produces no boolean exclusiveMinimum or exclusiveMaximum across all registered tools`

## Verification

`pnpm vitest run src/tools/tool-registry.test.ts` — 15 tests pass, including the
three new regression tests. `pnpm lint` passes.
