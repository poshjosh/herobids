- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-11
- **Summary:** Four `Warning: OpenAI may not support records in schemas! Try an array of key-value pairs instead.` messages were logged to stderr on every agent container startup due to `z.record(z.unknown())` in tool parameter schemas.

## Root Cause

The `zod-to-json-schema` library emits a `console.warn` when it encounters `z.record()` because the resulting JSON Schema (`{"type":"object","additionalProperties":{}}`) is not well-supported by OpenAI-compatible APIs. The warnings came from four schemas in two tool files:

| File | Schema | Field |
|---|---|---|
| `apps/worker/src/tools/bots.ts` | `CreateBotParamsSchema` | `config` |
| `apps/worker/src/tools/bots.ts` | `AdjustBotConfigParamsSchema` | `config` |
| `apps/worker/src/tools/messaging.ts` | `PublishArtifactParamsSchema` | `location` |
| `apps/worker/src/tools/messaging.ts` | `PublishArtifactParamsSchema` | `metadata` |

## Fix

Replaced `z.record(z.unknown())` with `z.object({}).passthrough()` in all four places. Both forms accept any object at runtime. The difference is that `z.object({}).passthrough()` produces `{"type":"object"}` in JSON Schema (no `additionalProperties` key), which `zod-to-json-schema` does not warn on.

## Files Changed

- `apps/worker/src/tools/bots.ts`
- `apps/worker/src/tools/messaging.ts`

## Verification

`pnpm lint` passes. No behaviour change — both the old and new schemas accept arbitrary objects; the LLM tool calling interface is unchanged.
