# Agent Runtime Hardening

Make the agent tick loop resilient to transient failures, distinguish recoverable from non-recoverable errors, and ensure internal LLM reasoning never leaks into user-visible output.

---

## Background

The current tick loop in `apps/worker/src/agent.ts` has minimal error handling: a top-level try/catch logs the error and sends a `degraded` heartbeat. There is no distinction between a transient LLM timeout (retry in 30s) and a fatal credential revocation (stop the agent). These concepts were well-handled in aitradingbot's executor and should be ported.

Additionally, some LLM providers return "thinking" content blocks (Anthropic extended thinking, DeepSeek-R1 reasoning). This internal reasoning must never appear in agent messages, tool calls, or user-facing output.

---

## Scope

### In scope

- Error classification: recoverable vs non-recoverable
- Retry and backoff policy for LLM calls
- Tick loop self-healing (reschedule on failure)
- Thinking text exclusion from output
- Graceful degradation when tools fail
- Circuit breaker for repeated failures

### Out of scope

- Tool-specific error handling (each tool handles its own errors)
- LLM provider unification (separate concern)
- Billing/cost impact of retries (covered by cost-reduction-pipeline.md)

---

## 1. Error Classification

### Non-recoverable (stop agent session)

| Error | Detection | Action |
|---|---|---|
| Invalid/revoked API credentials | `provider.http_401`, `provider.http_403` | Stop session, send `session_ended` with reason |
| Agent config parse failure | JSON parse error on `AGENT_CONFIG` | Refuse to start |
| Redis connection permanently lost | 3 consecutive connection failures over 60s | Stop session |
| Database permanently unavailable | 3 consecutive query failures | Degrade to no-DB mode or stop |
| Sandbox wall-clock expired | `sandboxEnforcer.isExpired()` | Stop session (already implemented) |

### Recoverable (retry with backoff)

| Error | Detection | Retry policy |
|---|---|---|
| LLM timeout | `provider.timeout` | Retry up to 2× with exponential backoff (5s, 15s) |
| LLM rate limit | `provider.http_429` | Wait `Retry-After` header or 60s, then retry once |
| LLM server error | `provider.http_5xx` | Retry up to 2× with 10s delay |
| Redis transient error | Single operation failure | Retry once after 1s; if repeated, degrade |
| Tool execution timeout | Tool-specific timeout | Return error result to LLM, do not retry tool |
| Market data rate limit | `rate_limit` response from tool | Return "try again next tick" to LLM |

### Degraded (continue with reduced capability)

| Condition | Degradation |
|---|---|
| Database unavailable | Disable `list_bots`, `get_analytics`, `list_positions` tools; agent can still trade via `submit_decision` |
| Market data provider down | Return stale/empty data; agent told "data unavailable" |
| Tool repeatedly failing | Temporarily remove from visible tool set for 3 ticks |

---

## 2. Retry and Backoff for LLM Calls

Replace the current single `callLlmProvider()` call with a retry wrapper:

```typescript
async function callLlmWithRetry(
  config: LlmProviderConfig,
  request: LlmRequest,
  maxRetries: number = 2,
): Promise<LlmResult> {
  const delays = [5000, 15000]; // exponential-ish backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await callLlmProvider(config, request);

    if (result.ok) return result;

    // Non-recoverable — do not retry
    if (!result.error.retryable) return result;

    // Last attempt — return failure
    if (attempt === maxRetries) return result;

    // Wait before retry
    const delay = delays[attempt] ?? delays[delays.length - 1]!;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // Unreachable, but TypeScript needs it
  return { ok: false, error: { code: 'provider.exhausted', message: 'All retries failed', retryable: false } };
}
```

### Rate limit handling

If `provider.http_429` is returned:
- Parse `Retry-After` header (seconds) if available.
- Otherwise default to 60s wait.
- Retry exactly once after the wait period.
- If still 429 → return failure, skip this tick.

---

## 3. Tick Loop Self-Healing

The tick loop must never permanently stop due to a transient error. Rules:

1. **Every tick is wrapped in try/catch** — already done, but needs classification.
2. **On recoverable error**: Log, send `degraded` heartbeat, schedule next tick normally.
3. **On non-recoverable error**: Log fatal, send `session_ended`, call `shutdown()`.
4. **On repeated failures**: If 3 consecutive ticks fail (any reason), increase tick interval by 2×. If 5 consecutive fail, stop session.
5. **On recovery**: Reset failure counter, restore normal tick interval.

### Consecutive failure tracking

```typescript
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_THRESHOLD = 3;

// In runTick catch:
consecutiveFailures++;
if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
  await shutdown('consecutive_failures_exceeded');
} else if (consecutiveFailures >= BACKOFF_THRESHOLD) {
  // Double tick interval temporarily
  effectiveTickInterval = Math.min(TICK_INTERVAL_MS * 2, 1800_000); // cap at 30 min
}

// On successful tick:
consecutiveFailures = 0;
effectiveTickInterval = TICK_INTERVAL_MS;
```

---

## 4. Thinking Text Exclusion

### Problem

When extended thinking is enabled (Anthropic `thinking` blocks, DeepSeek-R1 reasoning), the LLM response contains internal reasoning that:
- Must not be shown to users
- Must not be included in conversation history
- Must not be parsed as tool calls
- Must not count toward visible output

### Solution

#### In `@herobids/llm` (callAnthropicProvider)

The existing code already does `data.content?.find((b) => b.type === 'text')?.text` which skips thinking blocks. But we must also:

1. **Never store thinking blocks in conversation history** — only store the `text` content.
2. **Log thinking block presence at debug level** — for cost observability.
3. **Track thinking tokens separately** — add `thinkingTokens` to response.

#### In agent.ts (parseToolCalls)

The tool call parser scans the full `assistantResponse` string. If thinking text is somehow concatenated (malformed response), it could contain JSON-like structures that get parsed as tool calls.

Mitigation:
- `callAnthropicProvider` must strip thinking blocks before returning `content`.
- The current implementation already does this (returns only `text` block content).
- Add a defensive check: if response starts with `<thinking>` or `<reasoning>`, strip everything before the first non-thinking content.

#### Documentation requirement

Add to `AGENTS.md` or `docs/best-practices/`:
- "LLM thinking/reasoning text must never appear in user-facing output."
- "The `@herobids/llm` package is responsible for stripping provider-specific thinking blocks."
- "Agent conversation history must only contain visible text content."

---

## 5. Graceful Tool Failure

When a tool call fails (timeout, permission denied, data unavailable), the agent should:

1. Receive a clear error message (not a stack trace).
2. Be told whether to retry or skip.
3. Not have the failure propagate to kill the tick.

Current implementation already returns error strings to the agent via `executeTool()`. What's missing:

- **Rate limit errors** should say "Try again next tick" not just "rate_limit".
- **Permission errors** should say "This tool is not available" not throw.
- **Timeout errors** should say "Tool timed out — data may be stale" and continue.

---

## 6. Circuit Breaker for Tools

If a tool fails 3 times in a row across consecutive ticks:
- Temporarily remove it from the visible tool set (agent won't try to call it).
- After 5 ticks, re-add it (allow recovery).
- Log the circuit-open/close events.

This prevents the agent from wasting tokens repeatedly calling a broken tool.

---

## Implementation Order

1. Error classification + retry wrapper (lowest risk, immediate resilience gain)
2. Consecutive failure tracking + backoff (prevents stuck agents)
3. Thinking text exclusion validation (correctness, not just defense)
4. Circuit breaker for tools (reduces wasted tokens)
5. Documentation updates

## Dependencies

- `@herobids/llm` — response parsing, thinking token tracking
- `apps/worker/src/agent.ts` — tick loop, tool dispatch
- `AGENTS.md` — documentation of conventions
