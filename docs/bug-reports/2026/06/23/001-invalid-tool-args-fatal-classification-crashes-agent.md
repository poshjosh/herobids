# Bug Report: `provider.invalid_tool_args` Fatal Classification Crashes Agent

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-06-23
- **Agent:** https://herobids.com/agents/434a150b-41b9-4d1d-bd6d-3a07c6b807e8 (dthy)

## Summary

`provider.invalid_tool_args` (LLM returned malformed JSON in tool call arguments) was classified as `mode: 'fatal'`, causing the entire agent process to shut down. Transient LLM JSON malformation — common with DeepSeek — should be degradable and retryable, not fatal.

## Symptoms

Agent `dthy` crashed twice from the same root cause:
- Session 1 (2026-06-22 13:36 UTC → 2026-06-23 00:33 UTC, ~11h uptime)
- Session 2 (2026-06-23 05:11 UTC → 2026-06-23 07:34 UTC, ~2.5h uptime)

Agent container log from the crash:
```
{"level":50,"classification":{"source":"llm","mode":"fatal","reasonCode":"llm.invalid_tool_args","message":"Expected double-quoted property name in JSON at position 949 (line 1 column 950)"},"err":{"code":"provider.invalid_tool_args","retryable":false},"msg":"Agent runtime failure classified"}
{"level":30,"reason":"llm.invalid_tool_args","msg":"Agent runtime shutting down"}
```

Agent submitted valid trading decisions (`decision.created` → `risk.rejected`) in the same tick before the crash, confirming the agent was otherwise healthy.

## Root Cause

1. DeepSeek LLM returned a tool call with malformed JSON arguments (e.g. unquoted property names)
2. `parseToolArgs()` in `packages/llm/src/llm-provider.ts` threw `SyntaxError` on `JSON.parse()`
3. `callOpenAiCompatibleProvider()` caught it and returned `code: 'provider.invalid_tool_args'`
4. `classifyRuntimeError()` in `apps/worker/src/runtime-errors.ts:92` classified it as `mode: 'fatal'`
5. `callLlmWithRetry()` returned immediately — no retry attempted
6. `processRuntimeFailure()` saw `fatal` → called `shutdown()` → `process.exit(0)`

The fatal classification was overly aggressive. Malformed JSON from the LLM is a transient content issue — the model often self-corrects on a fresh sample. It should be handled as a degraded tick with retry, not a process-terminating event.

## Fix

### 1. Reclassify `provider.invalid_tool_args` as `degraded`

**File:** `apps/worker/src/runtime-errors.ts`

Changed classification from `mode: 'fatal'` to `mode: 'degraded'` with a 2-second retry hint:
```typescript
if (llmError.code === 'provider.invalid_tool_args') {
  return { source, mode: 'degraded', reasonCode: 'llm.invalid_tool_args', message: llmError.message, retryAfterMs: 2_000 };
}
```

### 2. Add retry branch in `callLlmWithRetry`

**File:** `apps/worker/src/runtime-errors.ts`

Added a retry branch for `provider.invalid_tool_args` with short backoff (2s) so the LLM gets a second chance to produce valid JSON:
```typescript
} else if (result.error.code === 'provider.invalid_tool_args') {
  if (attempt >= maxRetries) {
    return { result, attempts: attempt + 1, delaysMs, classification };
  }
  delayMs = 2_000;
}
```

### 3. Updated tests

**File:** `apps/worker/src/runtime-errors.test.ts`

- Updated "classifies invalid tool arguments as fatal" → "classifies invalid tool arguments as degraded (not fatal)"
- Added `'retries invalid_tool_args and eventually succeeds'` test
- Added `'stops retrying invalid_tool_args after maxRetries'` test

## Files Changed

- `apps/worker/src/runtime-errors.ts` — classification + retry branch
- `apps/worker/src/runtime-errors.test.ts` — updated + new tests

## Verification

- `pnpm tsc --noEmit -p apps/worker/tsconfig.json` — no errors in modified files
- `pnpm vitest run apps/worker/src/runtime-errors.test.ts` — **20/20 tests pass** (including 2 new ones)
