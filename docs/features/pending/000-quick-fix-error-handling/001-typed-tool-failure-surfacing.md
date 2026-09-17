# Plan: Typed tool-failure surfacing across scout and judge tool loops

Status: pending
Owner: (unassigned)
Related: `docs/features/pending/000-quick-fix-error-handling/000-analysis.md` (approved analysis)

## Summary

An unexpected throw while dispatching a tool call is handled inconsistently between the two LLM phases:

- **Scout** (`apps/worker/src/agent.ts:3715-3720`) flattens the throw to a
  generic `{ ok: false, error: 'tool_failed', note: 'Tool timed out or failed…' }`.
  The model loses the real cause, and no `TOOL_RESULT` activity event is emitted
  for this path (the activity stream gets a `TOOL_CALL` event but never a
  matching error `TOOL_RESULT`).
- **Judge** (`apps/worker/src/agent.ts:3937`) has **no net at all** — a throw
  from `executeTool` propagates through `runStructuredToolLoop` (its loop does
  not guard `await options.executeTool(...)`), aborts the entire judge tick, and
  surfaces as an unclassified runtime failure.
- **`executeTool`'s own catch-all** (`apps/worker/src/agent.ts:2257-2267`)
  converts tool-body throws into `{ ok: false, error: <message>, retryable: false }`
  — real message, but no `errorCode`, and `fault` semantics are only implicit
  (omitted field → `toolResultIndicatesFailure` counts it as a fault).

This plan makes unexpected tool throws surface a typed, consistent
`ToolResult`-shaped failure (`tool.unexpected_throw`) in both phases, emits the
missing activity event, and keeps the judge tick alive when dispatch throws.

## Goal

- A thrown tool call produces a typed failure tool-result the model can act on —
  in **both** scout and judge phases — carrying the real error message and a
  stable `errorCode`.
- The activity stream always receives a matching `TOOL_RESULT` error event for a
  failed tool dispatch, in both phases.
- A `executeTool` throw can never abort a whole tick (judge) or produce a
  cause-less flat string (scout).
- `toolResultIndicatesFailure` semantics for unexpected throws become explicit
  (`fault: true`) rather than accidental.

Non-goals:

- No change to `runStructuredToolLoop`'s contract (`executeTool` must still not
  throw; the safety net lives at the call sites).
- No change to boundary-failure mapping (`mapReadResultToToolResult` /
  `mapWriteResultToToolResult` in `apps/worker/src/tools/traderton-read.ts`) —
  already typed and correct.
- No scout-phase circuit-breaker wiring (explicit decision below).
- No new retry/backoff machinery — `retryable` is model guidance only.

## Key facts (verified in the analysis)

1. `executeTool`'s try/catch spans its post-context body (agent.ts ~2172-2267),
   so real tool-body throws (e.g. `browser.ts:89` CDP disconnect, Redis outage
   inside a tool) already return as `{ ok: false, error: <real message>, retryable: false }`.
   The scout catch is a near-unreachable belt-and-braces net (preamble only).
2. Boundary failures never throw: `TradertonClient.invoke`
   (`packages/domain/src/traderton/client.ts:191-235`) returns the typed
   `transport_error`/`failure` variants, and the adapters preserve the real
   `errorCode` through to the serialized tool result in both phases.
3. Tool-level timeouts are already typed (`provider.timeout`, `broker.timeout`,
   `execute_code.sandbox_infrastructure_error`) and flow through the typed path.
   The old note's "Tool timed out" wording is misleading.
4. `toolResultIndicatesFailure` (`apps/worker/src/runtime-resilience.ts:61`)
   parses only `{ ok, fault }`; `fault` omitted → counted as a fault.
   `retryable` is not consumed by the breaker — it only shapes model behaviour.
5. No test currently asserts the flattened `tool_failed` shape (only `agent.ts`
   and `SCRATCHES.md` contain the literal), so rewording is test-safe; new
   behaviour needs new coverage.
6. Precedent for pure helper modules extracted from `agent.ts` with their own
   unit tests: `scout-dispatch.ts`, `scout-gating.ts`, `tick-thinking.ts`.

## Design decisions

### D1 — One shared safe wrapper at both call sites

Extract a small helper module (`tool-dispatch.ts`) exposing
`runToolCallSafely(run, ctx)`. Both `runStructuredToolLoop` call sites (scout
and judge) route their `executeTool` through it. Rationale: duplication is
proven (scout's inline try/catch vs judge's bare wire-up), and the wrapper is
unit-testable without importing `agent.ts` (which connects Redis at module
scope). This mirrors the `scout-gating.ts` extraction pattern.

The judge phase gains graceful degradation: a preamble throw (the only
realistically reachable throw) now degrades to one typed failure tool-result
instead of aborting the whole tick and hitting `runTick`'s unclassified handler.

### D2 — One error code: `tool.unexpected_throw`

Both the wrapper and `executeTool`'s inner catch emit the same namespaced code.
The distinction (tool-body throw vs dispatch-preamble throw) is already carried
by the distinct log lines and the phase field; a second code adds surface
without diagnostic value (KISS).

### D3 — Unexpected-throw semantics: `retryable: true`, `fault: true`

An unclassified throw is presumed a transient infrastructure fault:

- `fault: true` (explicit, not by omission) — the breaker counts it, matching
  today's implicit behaviour for the inner catch.
- `retryable: true` — matches the old scout note's intent ("retry later"). This
  is a deliberate change for the inner catch (was `retryable: false`): the two
  layers must not disagree, and `retryable` only shapes model guidance — the
  tool circuit breaker caps runaway retries regardless.
- A `note` replaces the misleading "timed out" wording, e.g.
  `"The tool failed unexpectedly (not a validation error). It may be transient — retry once or continue with other tools."`

### D4 — Scout-phase circuit-breaker feedback stays unwired (documented decision)

The scout loop has no `onToolResult`, so scout tool failures never feed
`recordToolFailure`/`recordToolSuccess`. Leaving it unwired is the conscious
choice: a scout tool failure already escalates to judge (fallback), where the
same tools are invoked and the breaker learns from the judge-phase calls.
Wiring scout would double-count failures per tick (threshold 3 → circuit opens
after ~1.5 ticks instead of 3) and open circuits more aggressively on
transient scout-phase failures. Documented in code comment, not changed.

### D5 — `runStructuredToolLoop` unchanged

The loop keeps its contract "executeTool must not throw". The wrapper enforces
that contract at both call sites. A loop-level test pins the propagation
behaviour so the contract is explicit (see Tests).

## Detailed plan

### 1. New helper module `apps/worker/src/tool-dispatch.ts`

```ts
export const UNEXPECTED_TOOL_THROW_ERROR_CODE = 'tool.unexpected_throw';

export interface ToolCallFailureContext {
  toolName: string;
  phase: 'scout' | 'judge';
  log: { warn(payload: Record<string, unknown>, message: string): void };
  emitToolResultError: (info: { toolName: string; phase: 'scout' | 'judge'; correlationId: string; summary: string }) => void;
}

/** Pure serializer — exported for tests. */
export function serializeUnexpectedToolThrow(err: unknown): string;

/** Run a tool dispatch, degrading any throw into a typed failure tool-result. */
export async function runToolCallSafely(
  run: () => Promise<string | null>,
  ctx: ToolCallFailureContext,
): Promise<string | null>;
```

`serializeUnexpectedToolThrow` returns
`{ ok: false, error, errorCode: 'tool.unexpected_throw', retryable: true, fault: true, note }`
with `error` = `err instanceof Error ? err.message : 'unknown error'`.

`runToolCallSafely` catches, logs (`log.warn` with the original `err`), emits
exactly one `TOOL_RESULT` error event via `emitToolResultError` (summary
truncated to 500 chars, fresh `correlationId`), and returns the serialized
failure. On success it returns the delegate's result unchanged (including
`null`).

### 2. Rewire both call sites in `apps/worker/src/agent.ts`

- **Scout** (`~3715-3720`): delete the inline try/catch; call
  `runToolCallSafely(() => executeTool({ tool: toolCall.name, args: toolCall.args }, 'scout'), ctx)`
  with the injected `emitToolResultEvent` + `logger`.
- **Judge** (`~3937`): replace the bare
  `executeTool: async (toolCall) => executeTool({ tool: toolCall.name, args: toolCall.args }),`
  with the same wrapper using `phase: 'judge'`.

Note: the wrapper's `TOOL_RESULT` correlationId is a fresh UUID and will not
match any `TOOL_CALL` event when the throw happened in `executeTool`'s
preamble (before `executeTool` emits its own `TOOL_CALL`). Correlation is
best-effort on this degraded path — acceptable; logged with the full `err`.

### 3. Type the inner catch in `executeTool` (`~2257-2267`)

Replace:

```ts
return JSON.stringify({ ok: false, error: message, retryable: false });
```

with `return serializeUnexpectedToolThrow(err);` (keeping the `logger.error`
and `emitToolResultEvent` calls exactly as they are — this catch path already
emits its event). Net effect: real message + `errorCode` + explicit
`fault: true`, `retryable` false → true (D3).

### 4. Document the scout breaker decision

Add a short comment at the scout `runStructuredToolLoop` call site stating that
scout-phase tool failures intentionally do not feed the circuit breaker (D4).

## Files to change

1. `apps/worker/src/tool-dispatch.ts` — **new** — `serializeUnexpectedToolThrow`
   + `runToolCallSafely` (per D1/D2/D3).
2. `apps/worker/src/tool-dispatch.test.ts` — **new** — unit coverage.
3. `apps/worker/src/agent.ts` — scout catch replacement (§2), judge wire-up
   (§2), inner-catch typing (§3), D4 comment.
4. `apps/worker/src/structured-tool-loop.test.ts` — add one contract test (D5).

## Tests

`apps/worker/src/tool-dispatch.test.ts` (behavior-named):

- `'serializes an unexpected throw with its real message, a stable errorCode, retryable and fault'`
- `'serializes a non-Error throw as an unknown-error typed failure'`
- `'passes the delegate result through unchanged on success, including null'`
- `'degrades a throwing delegate into a typed failure and emits exactly one TOOL_RESULT error event'`
- `'truncates the emitted summary to 500 characters'`

`apps/worker/src/structured-tool-loop.test.ts`:

- `'propagates an executeTool throw out of the loop'` — pins the D5 contract
  that the safety net lives at call sites (asserts the rejected promise, not a
  synthesized result).

No existing test asserts the old `tool_failed` flat shape (analysis fact 5), so
nothing breaks by rewording.

## Behavior changes (before → after)

| Path | Before | After |
|---|---|---|
| Scout, `executeTool` preamble throws | `{ ok:false, error:'tool_failed', note:'Tool timed out or failed…' }`, no TOOL_RESULT event | `{ ok:false, error:<real message>, errorCode:'tool.unexpected_throw', retryable:true, fault:true, note }` + TOOL_RESULT error event |
| Judge, `executeTool` throws | Tick aborts; unclassified runtime failure; judge turn lost | Typed failure tool-result; `onToolResult` records the failure; tick continues |
| Inner catch (both phases, tool-body throws) | `{ ok:false, error:<real message>, retryable:false }` (no errorCode, implicit fault) | Same message + `errorCode:'tool.unexpected_throw'`, explicit `fault:true`, `retryable:true` |
| Boundary failures | Typed errorCode flows through | Unchanged |
| `toolResultIndicatesFailure` on unexpected throws | Counts as fault (by omission) | Counts as fault (explicit) — no behavior change |

## Risks

- `retryable: true` on unexpected throws may cause one extra model retry per
  failure (token cost). Bounded by `maxTurns` and the tool circuit breaker.
- The wrapper's TOOL_RESULT correlationId will not match a TOOL_CALL event on
  the preamble-throw path (best-effort correlation; the log line carries the
  full error).
- Judge-phase throws now feed the circuit breaker (previously the tick aborted
  with no record). This is the intended improvement; watch for circuits opening
  faster on judge-phase infra failures in the first days after rollout.

## Open items to confirm at implementation time

- Confirm no other code path depends on a throw escaping `executeTool` (only
  the two `runStructuredToolLoop` call sites invoke it; `fetchAgentOpenPositions`
  and friends use the boundary directly and are untouched).
- Confirm the scout system prompt (`scout-dispatch.ts`) does not reference the
  literal `tool_failed` — the analysis grep found it only in `agent.ts` and
  `SCRATCHES.md`, so no prompt change is expected.
- Decide the final `note` wording (must not claim "timed out").
