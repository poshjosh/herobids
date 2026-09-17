# Analysis

## Prompt

On the scout path a thrown tool call is flattened to a generic { ok: false, error: 'tool_failed', note: 'Tool timed out or failed...' } (agent.ts ~3719) — that case loses the specific cause. But boundary failures come back as typed ToolResult failures (not throws), so they carry the real errorCode through.

## Response

### Verdict: the claim is true as written, but the practical blast radius is smaller than it looks — `executeTool` itself almost never throws

### 1. The flattening exists exactly where you noted — `herobids/apps/worker/src/agent.ts:3715-3720`

```ts
try {
  return await executeTool({ tool: toolCall.name, args: toolCall.args }, 'scout');
} catch (err) {
  logger.warn({ err, tool: toolCall.name, phase: 'scout' }, 'Scout tool execution threw unexpectedly');
  return JSON.stringify({ ok: false, error: 'tool_failed', note: 'Tool timed out or failed. Skip or retry later.' });
}
```

The `err` is logged server-side but the model sees only the generic `tool_failed` + a fixed note. Also no `emitToolResultEvent` is emitted here, so the activity stream gets a `TOOL_CALL` event (emitted inside `executeTool`'s try) but never a matching `TOOL_RESULT` error event for this path — an observability gap on top of the prompt-loss.

### 2. But the scout catch is nearly unreachable — `executeTool` has its own catch-all that returns, not throws

The scout-visible body of `executeTool` (line 1867) wraps everything after context construction in a try/catch (lines 2172–2257):

```ts
} catch (err) {
  logger.error({ err, tool: call.tool }, 'Tool execution threw unexpected error');
  ...
  return JSON.stringify({ ok: false, error: message, retryable: false });
}
```

So a thrown tool (e.g. `browser.ts:89` `CDP WebSocket not connected`, a Redis outage inside a tool, a sandbox crash) is already converted into `{ ok: false, error: <real message>, retryable: false }` **one layer down**. The scout catch only fires if `executeTool` throws from its *preamble* (before line 2172: `allowedTools()`, `toolRegistry.get`, context builders — all effectively non-throwing). In practice the flattened `tool_failed` is a belt-and-braces safety net, not the normal error path.

Two nuances worth flagging about that inner catch:

- It keeps the message but has **no `errorCode`** — so even the "normal" thrown path is untyped (unlike boundary failures).
- It omits `fault`, so `toolResultIndicatesFailure` (`runtime-resilience.ts:61`, `parsed.fault !== false`) implicitly counts it as a fault for the circuit breaker — correct semantics, but only by accident of omission. It's also inconsistent with the scout catch, which omits `retryable` (implicitly non-retryable) while its note says "retry later".

### 3. The boundary half of the claim is fully confirmed

- `TradertonClient.invoke` (`packages/domain/src/traderton/client.ts:191-235`) **never throws** — fetch rejection, non-2xx, and unparseable body all return the typed `transport_error` variant.
- `mapReadResultToToolResult` / `mapWriteResultToToolResult` (`apps/worker/src/tools/traderton-read.ts:34-105`) map every union branch into `ToolResult` preserving the real `errorCode` (`boundary.transport_error`, `precondition.not_ready`, `validation.invalid_payload`, `not_found.resource`, …).
- `executeTool` then serializes `errorCode` verbatim for failures (line ~2222-2233). So a boundary failure is visible with its specific cause in **both** scout and judge phases — the asymmetry the note describes is real, just narrow.

Also, the note's wording "Tool timed out" is mostly misleading: timeouts are handled *inside* tools as typed results (`provider.timeout`, `broker.timeout`, `execute_code.sandbox_infrastructure_error`), which flow through the typed path and keep their codes.

### 4. The bigger asymmetry is on the judge side, not the scout side

The judge loop wires `executeTool: async (toolCall) => executeTool({...})` (line 3937) with **no catch**. If `executeTool` ever threw (preamble bug), the exception escapes `runStructuredToolLoop` (its `for` loop doesn't guard `await options.executeTool(...)`), aborts the entire tick, and surfaces as an unclassified runtime failure at `runTick`'s handler — losing the whole judge turn, not just one tool result. The scout path's flatten-to-tool-result is actually the more graceful of the two; the judge path just has no net.

### Recommendation

1. **Improve the scout catch** (cheap, safe): return the real cause with a distinct code and emit the missing activity event:
   ```ts
   } catch (err) {
     const message = err instanceof Error ? err.message : 'unknown error';
     emitToolResultEvent({ phase: 'scout', toolName: toolCall.name, status: 'error', correlationId: crypto.randomUUID(), summary: message.slice(0, 500) });
     return JSON.stringify({ ok: false, error: message, errorCode: 'tool.unexpected_throw', retryable: true, fault: true });
   }
   ```
2. **Extract a shared safe wrapper** (e.g. `executeToolSafe(call, phase)`) and use it for *both* scout and judge, so a preamble throw degrades to a tool result instead of aborting the judge tick.
3. Optionally type the inner catch in `executeTool` too (`errorCode: 'tool.unexpected_throw'`, explicit `fault: true`) so the LLM and `toolResultIndicatesFailure` see consistent, intentional semantics.
4. Separate observation: the scout loop has no `onToolResult`, so scout tool failures never feed `recordToolFailure`/`recordToolSuccess` — the circuit breaker only learns from judge-phase calls. That may be intentional (read-only scout tools), but worth a conscious decision.

No test currently asserts the flattened `tool_failed` shape (only `agent.ts` and `SCRATCHES.md` contain it), so any change here is test-covered only if you add coverage.

