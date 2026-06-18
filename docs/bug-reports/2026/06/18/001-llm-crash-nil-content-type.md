# Bug Report: LLM Crash — Ollama/Qwen Rejects `content: null` in Assistant Messages

- **Status:** FIXED (partial — see Notes)
- **Severity:** Critical
- **Date:** 2026-06-18
- **Discovered:** evaluate-agent-and-fix — t1inch agent (0d4b36a3) crashed with "AI agent crashed. The runtime stopped unexpectedly."
- **Summary:** Ollama/Qwen (qwen3.6:35b) rejects assistant messages with `content: null`, causing cascading LLM failures. After 5 consecutive failures, the agent shuts down per `failureBackoff.maxFailures`. Two contributing causes: (1) `toOpenAiMessages()` emits `content: null` for empty assistant messages, and (2) empty assistant responses are stored in conversation history and re-sent on every subsequent tick.

## Symptoms

- Agent `t1inch` (0d4b36a3) crashed at 00:51 UTC with status `crashed`.
- Agent runtime logs show repeated HTTP 400 errors:
  ```
  Provider returned 400: {"error":{"message":"invalid message content type: <nil>","type":"invalid_request_error"}}
  ```
- Error classified as `mode: 'degraded'`, `reasonCode: 'llm.unavailable'` (source: `llm`).
- 5 consecutive LLM failures triggered agent shutdown per `SHUTDOWN_ELIGIBLE_SOURCES` including `llm`.
- The error occurred at the start of each judge phase — the first LLM call after a previous tick ended with an empty assistant response.

## Root Cause

**LLM Provider:** Ollama running `qwen3.6:35b-a3b-q4_K_M` (not DeepSeek). Ollama's OpenAI-compatible API rejects `content: null` in messages.

**Two-part root cause:**

### Part 1 — `toOpenAiMessages()` emits `content: null`

In `packages/llm/src/llm-provider.ts`, `toOpenAiMessages()` converts internal `LlmMessage` objects to OpenAI-compatible wire format. For assistant messages, when `content` is an empty string, it was set to `null`:

```typescript
content: message.content.length > 0 ? message.content : null,
```

Ollama/Qwen rejects `content: null` with HTTP 400 "invalid message content type: <nil>".

### Part 2 — Empty messages persist across ticks

In `agent.ts`, the judge loop's `onAssistantTurn` callback adds the assistant response to `conversationHistory` when `toolCalls.length === 0`:

```typescript
if (toolCalls.length === 0) {
    addToHistory('assistant', assistantResponse);
}
```

In tick 12, the judge loop ended with an LLM response that had 0 tokens and 0 tool calls — an empty response. This empty message (`content: ''`) was stored in conversation history. On tick 13 (and every subsequent tick), it was included in the judge messages, re-triggering the HTTP 400 error.

**Why backoff didn't help:** The same malformed message was re-sent on every tick. Backing off the tick interval from 60s to 30min doesn't change the broken conversation history.

**Why it led to crash:** `llm` is in `SHUTDOWN_ELIGIBLE_SOURCES`. After 5 consecutive LLM failures (even `degraded`-mode errors), `failureBackoff.recordFailure('llm')` returns `shouldShutdown: true` → agent shuts down.

## Fix

### Fix 1 — `toOpenAiMessages()` defensive formatting

**File:** `packages/llm/src/llm-provider.ts` — `toOpenAiMessages()`

Changed the assistant message formatting:
- When content is non-empty: include `content` as a string (unchanged).
- When content is empty **and** `tool_calls` are present: omit the `content` field entirely.
- When content is empty **and** no `tool_calls`: use empty string `""` instead of `null`.

```typescript
const contentField = message.content.length > 0
  ? { content: message.content }
  : hasToolCalls
    ? {}                      // Omit content when tool calls present
    : { content: '' };        // Empty string instead of null
```

### Fix 2 — Filter empty messages from conversation history

**File:** `apps/worker/src/agent.ts` — `addToHistory()`

Added a guard to skip empty content messages:

```typescript
if (normalizedContent.length === 0) return;
```

This prevents empty assistant responses from polluting conversation history and causing repeated LLM rejections.

## Notes

- **This is an Ollama/Qwen issue, not DeepSeek.** The agent uses Ollama with `qwen3.6:35b-a3b-q4_K_M`. Both Ollama and DeepSeek reject `content: null`, but the provider in use is Ollama.
- **Further hardening recommended:** The error classification should distinguish HTTP 4xx (bad request / fixable) from genuine LLM unavailability. A 400 error should trigger message cleanup rather than contributing to the shutdown counter.
- **`llm.unavailable` reasonCode is misleading** for 4xx errors — the LLM IS available, it just rejected malformed input. Consider adding `llm.bad_request` as a distinct reasonCode.
- The `stripReasoningContent()` function may produce empty strings when all content was thinking/reasoning blocks — this is a related contributor to empty assistant responses.
