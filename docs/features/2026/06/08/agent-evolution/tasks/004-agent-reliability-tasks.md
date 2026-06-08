# Plan 004 — Task List

**Epic:** D (Agent Reliability)
**Plan:** [Agent Runtime Hardening](../references/agent-runtime-hardening.md)
**Goal:** Make the agent runtime resilient to transient failures, clear about fatal failures, and safe about what LLM content may enter history, tools, and user-visible output.

---

## Tasks

### T1: Add an explicit runtime error taxonomy

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)

Introduce one classification layer for agent runtime failures covering:

- LLM provider failures
- Redis failures
- database failures
- market-data failures
- tool execution failures
- sandbox expiry and startup config failures

Each classification must resolve to one of:

- recoverable
- degraded-but-continue
- non-recoverable / stop-session

Avoid scattering `if (message.includes(...))` logic across the tick loop.

**Files:** `apps/worker/src/agent.ts`, `packages/llm/src/llm-provider.ts`, `apps/worker/src/` (new error-classification helper), `packages/domain/src/agent-protocol.ts` if new reason codes are needed
**Acceptance:** Runtime code can classify representative failures into the three handling modes through one helper layer. Focused tests cover timeout, 429, 401/403, DB unavailable, and sandbox-expired cases.

---

### T2: Wrap LLM calls with retry and 429-aware backoff

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1

Replace the single `callLlmProvider()` attempt in `runTick()` with a retry wrapper that follows the plan:

- timeout: retry up to 2x with backoff
- 5xx: retry up to 2x
- 429: honor `Retry-After` when available, otherwise wait 60s, retry once
- non-retryable failures: return immediately

Keep retry policy out of the provider-specific parsing code where possible so other callers can reuse it later.

**Files:** `apps/worker/src/agent.ts`, `packages/llm/src/llm-provider.ts`
**Acceptance:** Recoverable LLM failures retry with the documented delays, non-recoverable failures do not retry, and tests cover timeout / 429 / 5xx paths.

---

### T3: Make the tick loop self-healing and failure-count aware

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1, T2

Augment `runTick()` with consecutive-failure tracking and adaptive behavior:

- recoverable failures increment the counter and schedule the next tick normally
- after 3 consecutive failures, temporarily back off the effective tick interval
- after 5 consecutive failures, stop the session cleanly
- any successful tick resets the failure counter and interval

This must apply both to the immediate first tick and the interval-driven loop.

**Files:** `apps/worker/src/agent.ts`
**Acceptance:** Repeated recoverable failures no longer create a tight failure loop. Recovery resets counters. Fatal shutdown after the configured threshold is covered by tests.

---

### T4: Degrade capabilities cleanly when dependencies are unavailable

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T1

When DB, market-data, or selected tools are unavailable, the runtime should degrade explicitly instead of failing the whole tick.

Required behaviors:

- hide or disable tools that cannot work in the current degraded mode
- return clear retry / skip guidance to the model
- send degraded heartbeat state with reason
- keep the rest of the tick alive where safe

This task is about dependency-aware capability reduction, not tool-specific business logic.

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`, `apps/worker/src/agents/capability-policy.ts`
**Acceptance:** A DB outage or market-data outage does not crash the runtime outright. The visible tool set shrinks appropriately, degraded status is observable, and tests cover both dependency-loss scenarios.

---

### T5: Add a tool circuit breaker across ticks

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T4

Track tool failures across consecutive ticks and open a temporary circuit when a tool is repeatedly broken:

- 3 consecutive failures opens the circuit
- while open, the tool is removed from the visible set
- after 5 ticks, the tool is eligible to re-enter
- open / close events are logged

This prevents the model from burning tokens repeatedly on known-broken tools.

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`, `apps/worker/src/agents/capability-policy.ts`
**Acceptance:** Repeated tool failures suppress the tool temporarily, the tool later reappears automatically, and tests cover circuit open / close behavior.

---

### T6: Strip thinking content and harden assistant-response parsing

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1

Formalize the "thinking must never leak" rule in code:

- strip provider-specific thinking / reasoning blocks before returning visible content
- never store hidden reasoning in conversation history
- track hidden reasoning token usage separately when providers expose it
- add a defensive parser guard before tool-call extraction in case malformed content slips through

The current Anthropic parser already prefers `text` blocks; this task finishes the contract and adds explicit coverage.

**Files:** `packages/llm/src/llm-provider.ts`, `apps/worker/src/agent.ts`
**Acceptance:** Conversation history stores only visible assistant text, tool parsing ignores reasoning wrappers, and tests cover Anthropic-style thinking blocks plus malformed prefixed responses.

---

### T7: Strengthen reliability observability and documentation

**Status:** not-started
**Approach:** End-to-end
**Effort:** Small (1 session)
**Depends on:** T2, T3, T4, T5, T6

Make the hardening work visible and durable:

- structured logs for retry attempts, backoff, degraded mode, and fatal shutdown reason
- heartbeat / session-end messages include reason codes where appropriate
- write down the no-thinking-leak rule in repository documentation

Do not let the runtime behavior depend on tribal knowledge in chat history.

**Files:** `apps/worker/src/agent.ts`, `AGENTS.md` or `docs/best-practices/`, `apps/worker/src/agents/agent-health-monitor.ts` if message handling needs updates
**Acceptance:** Logs expose retry counts and shutdown reasons, session-end reasons are machine-readable, and repo docs explicitly state that hidden reasoning must never enter user-visible output or stored history.

---

## Parallelization Notes

- **T1** is the prerequisite because the handling policy has to be explicit before retries and backoff are layered on.
- **T2** and **T4** can proceed in parallel once T1 exists.
- **T3** depends on the retry and classification behavior being defined.
- **T5** builds on the degraded-capability surface from T4.
- **T6** can proceed after T1 because it is mostly contained to LLM and parsing boundaries.
- **T7** is the close-out step after the runtime behavior is in place.

```
T1 (error taxonomy)
	→ T2 (LLM retry)
	→ T4 (capability degradation) → T5 (tool circuit breaker)
	→ T6 (thinking stripping)

T2 → T3 (self-healing tick loop)

T3 + T5 + T6 → T7 (observability + docs)
```
