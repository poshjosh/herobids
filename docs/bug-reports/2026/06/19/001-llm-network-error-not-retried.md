# Bug Report: LLM `fetch failed` Network Error Not Retried

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-19
- **Agent:** https://herobids.com/agents/a4d450fe-f400-4398-b175-e900cc18b7ca (remote Hetzner deployment)
- **Summary:** Transient network errors (`fetch failed`) during judge-phase LLM calls were returned immediately without retry, causing a tick failure on every temporary network blip.

## Symptoms

Event from the agent activity feed:
```
messageType:  agent.llm.completed
phase:        judge
model:        meta-llama/llama-3.3-70b-instruct
turnsUsed:    0
finishReason: error
errorMessage: fetch failed
```

The `turnsUsed: 0` indicates the very first LLM call failed before any response was received, suggesting a network-level failure rather than a content error.

## Root Cause

In `apps/worker/src/runtime-errors.ts`, `callLlmWithRetry` only retries the following error codes:

| Code | Retry |
|---|---|
| `provider.http_429` | Yes (once, with backoff) |
| `provider.timeout` | Yes (up to `maxRetries`, with backoff) |
| `provider.http_5xx` | Yes (up to `maxRetries`, with fixed backoff) |
| `provider.network_error` | **No — falls through to `delayMs === null`, returns immediately** |

When `fetch()` throws (DNS failure, ECONNRESET, ECONNREFUSED, etc.), `callOpenAiCompatibleProvider` catches it and returns:
```typescript
{ ok: false, error: { code: 'provider.network_error', message: 'fetch failed', retryable: true } }
```

This error is `retryable: true` and `classifyRuntimeError` maps it to `mode: 'recoverable'`, but `callLlmWithRetry` has no branch for `provider.network_error` — so it exits immediately with no retry.

On a remote server, transient network blips to the OpenRouter API are expected. Each such blip caused the tick to emit `finishReason: error` and decrement the agent's consecutive-failure counter, potentially leading to agent shutdown after repeated failures.

## Fix

**File:** `apps/worker/src/runtime-errors.ts`

Extended the `provider.timeout` retry branch to also cover `provider.network_error`:

```typescript
// Before
} else if (result.error.code === 'provider.timeout') {

// After
} else if (result.error.code === 'provider.timeout' || result.error.code === 'provider.network_error') {
```

Both errors are transient connectivity failures and should use the same retry cadence (`timeoutBackoffMs`, default `[5_000, 15_000]`, up to `maxRetries = 2`).

**File:** `apps/worker/src/runtime-errors.test.ts`

Added two new test cases:
- `retries network errors and eventually succeeds` — verifies retry happens with correct backoff delay
- `stops retrying network errors after maxRetries` — verifies the retry cap is enforced
