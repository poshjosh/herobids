# Actionable Rate Limit Error Messages

**Status:** Draft
**Created:** 2026-08-29
**Area:** Agent runtime, capability policy, tool execution, message broker

---

## Problem Statement

When the capability policy denies a tool invocation due to rate limiting, the error message returned to the LLM agent is:

```json
{
  "ok": false,
  "error": "capability policy denied: rate_limit_exceeded",
  "errorCode": "capability.policy_denied",
  "retryable": false,
  "fault": false
}
```

Three problems:

1. **No wait time.** The agent has no idea when the rate limit window resets. The engine knows (`counter.windowStart + 60_000 - now`), but doesn't return it.
2. **No limit context.** The agent doesn't know the limit is 5/min or that it's used 5/5. It can't reason about pacing.
3. **`retryable: false`** — tells the agent "don't retry," which is wrong. Rate limits are transient by nature. The agent should retry after the cooldown.

The same problems exist for `max_concurrent_exceeded` (no info on how many slots are in use or when one might free up) and for all denial reasons surfaced through the capability policy.

### Affected Vectors

**Vector 1: Direct tools (in-container, tool calls `checkAccess` directly)**

| Tool | File | Impact |
|---|---|---|
| `execute_code` | `apps/worker/src/tools/code.ts:65` | Agent sees opaque `"capability policy denied: rate_limit_exceeded"` |
| `search_web` | `apps/worker/src/tools/web-access.ts:220` | Same |
| `browse_url` | `apps/worker/src/tools/web-access.ts:331` | Same |
| `read_document` | `apps/worker/src/tools/web-access.ts:550` | Same |

Each tool independently calls `ctx.capabilityEngine.checkAccess()`, gets a bare string back, and formats its own error. The error message, `retryable` flag, and `fault` flag are inconsistent across tools.

**Vector 2: Brokered tools (cross-process, broker calls `checkAccess`)**

| Capability | File | Impact |
|---|---|---|
| `submit_decision` | `agent-message-broker.ts:223` | Broker returns `{ accepted: false, error: 'capability_denied:rate_limit_exceeded' }` — but **no reply is pushed to the Redis reply key**, so the tool blocks on `blpop` for 30 seconds and times out with `"Decision reply timed out after 30s"`. The agent never learns the real reason. |
| `publish_artifact` | Same path | Same — broker rejects silently |
| `send_message` | Same path | Same |
| `manage_bot` | Same path | Same |
| `bot_query` | Same path | Same |
| `assess_strategy_preset` | Same path | Same |
| `change_strategy_preset` | Same path | Same |
| `manage_agent_skills` | Same path | Same |

The broker's denial at line 226 returns `{ accepted: false }` to the stream processor but does **not** push a reply to the Redis list that the tool is blocking on (`blpop`). This is the worst case — the agent wastes 30 seconds waiting for a reply that never comes, then gets a misleading timeout error.

**Vector 3: Operator logs**

The `logger.warn` at each denial site logs `{ reason: denied }` — the bare string. No structured fields for limit, usage, or retry-after. This makes it hard to diagnose rate limit issues from logs alone.

---

## Goals

1. **Rich denial responses** — `checkAccess` returns a structured object (not a string) with reason, retry-after, limit, usage, and a human-readable message.
2. **Correct `retryable` semantics** — rate limit and concurrency denials are `retryable: true` with a `retryAfterMs` hint.
3. **Consistent error formatting** — all tools (direct and brokered) produce the same error shape for capability denials.
4. **Broker reply on denial** — brokered tools that use a synchronous reply channel (`blpop`) get a proper denial reply instead of timing out.
5. **Structured logs** — denial log lines include limit, usage, and retry-after as structured fields.

## Non-Goals

- Changing rate limit values or window sizes (separate feature: plan-tiered limits).
- Adding automatic retry/backoff logic inside the agent loop (the agent LLM decides whether to retry based on the message).
- Changing API-level rate limiting (HTTP 429 responses in `apps/api/` routes already have reasonable messages).

---

## Design

### Structured Denial Result

Replace the `string | undefined` return type of `checkAccess` with a structured object:

```typescript
/** Returned by checkAccess when a capability invocation is denied. */
export interface CapabilityDenial {
  /** Machine-readable reason code (same values as current strings). */
  reason: 'kill_switch_active' | 'unknown_capability' | 'capability_disabled'
    | 'capability_never_allowed' | 'rate_limit_exceeded' | 'max_concurrent_exceeded';
  /** Milliseconds until the denial condition is expected to clear. Undefined for permanent denials. */
  retryAfterMs?: number;
  /** The configured limit that was hit (e.g. maxPerMinute value). */
  limit?: number;
  /** Current usage count against that limit. */
  used?: number;
  /** Human-readable message suitable for inclusion in an LLM tool response. */
  message: string;
}
```

`checkAccess` returns `CapabilityDenial | undefined` (undefined = allowed, same as today).

### Error Message Templates

| Reason | `retryable` | Message template |
|---|---|---|
| `rate_limit_exceeded` | `true` | `"Rate limited: {capability} used {used}/{limit} times this minute. Try again in {retryAfterSec}s."` |
| `max_concurrent_exceeded` | `true` | `"Concurrency limited: {capability} has {used}/{limit} concurrent calls active. Wait for a running call to complete."` |
| `capability_disabled` | `false` | `"Capability {capability} is disabled for this agent."` |
| `capability_never_allowed` | `false` | `"Capability {capability} is not available on this platform."` |
| `kill_switch_active` | `false` | `"All tool invocations are temporarily suspended."` |
| `unknown_capability` | `false` | `"Unknown capability: {capability}."` |

### `retryAfterMs` Calculation

For `rate_limit_exceeded`: `counter.windowStart + 60_000 - Date.now()`. This is the time until the current 60-second tumbling window resets.

For `max_concurrent_exceeded`: `undefined`. We don't know when a running call will complete. The message tells the agent to wait for completion.

### Direct Tool Error Response

All direct tools produce a consistent `ToolResult` for capability denials:

```typescript
// Shared helper (new file or added to a common tools utility)
function capabilityDeniedResult(capability: string, denial: CapabilityDenial): ToolResult {
  return {
    success: false,
    error: denial.message,
    errorCode: 'capability.policy_denied',
    retryable: denial.retryAfterMs !== undefined,
    fault: false,
    data: {
      reason: denial.reason,
      retryAfterMs: denial.retryAfterMs,
      limit: denial.limit,
      used: denial.used,
    },
  };
}
```

Key changes from current behavior:
- `retryable` is `true` for rate limit and concurrency denials (was `false`).
- `data` includes structured fields the agent can parse.
- `error` is a human-readable sentence (was an opaque code string).

### Broker Denial Reply

When the broker denies a brokered capability at `agent-message-broker.ts:226`, it must push a reply to the Redis reply key if the message payload contains `_expectsReply: true` (or a `requestMessageId`). The reply follows the same structured format:

```typescript
if (denied) {
  // Push denial reply so the tool's blpop doesn't time out
  const replyKey = extractReplyKey(envelope);
  if (replyKey) {
    await this.redis.rpush(replyKey, JSON.stringify({
      status: 'rejected',
      code: `capability_denied:${denied.reason}`,
      message: denied.message,
      retryAfterMs: denied.retryAfterMs,
      limit: denied.limit,
      used: denied.used,
    }));
    await this.redis.expire(replyKey, 120);
  }
  return { accepted: false, error: `capability_denied:${denied.reason}` };
}
```

The reply key extraction needs to handle the different brokered tools:
- `submit_decision`: `agent:decision:reply:{decisionId}` (from `payload.decisionId`)
- `assess_strategy_preset` / `change_strategy_preset`: `payload.requestMessageId`
- `manage_agent_skills`: `payload.requestMessageId`
- `send_message` / `publish_artifact`: no reply channel (fire-and-forget) — log only

Each brokered tool that reads the reply (e.g. `submit_decision` in `trading.ts`) needs to handle the new `status: 'rejected'` case:

```typescript
if (parsed.status === 'rejected') {
  return {
    success: false,
    error: parsed.message ?? `Capability denied: ${parsed.code}`,
    errorCode: parsed.code,
    retryable: parsed.retryAfterMs !== undefined,
    fault: false,
    data: {
      retryAfterMs: parsed.retryAfterMs,
      limit: parsed.limit,
      used: parsed.used,
    },
  };
}
```

### Structured Logs

Denial log lines include structured fields:

```typescript
logger.warn({
  agentId,
  capability: capabilityName,
  reason: denied.reason,
  limit: denied.limit,
  used: denied.used,
  retryAfterMs: denied.retryAfterMs,
}, 'Capability policy denied');
```

---

## Implementation Phases

### Phase 1: Structured `checkAccess` Return Type — DONE

**Effort:** ~0.5 day
**Risk:** Low (internal API change, all callers updated in same PR)

**Files modified:**
- `apps/worker/src/agents/capability-policy.ts` — Change `checkAccess` return type from `string | undefined` to `CapabilityDenial | undefined`. Add `CapabilityDenial` interface. Compute `retryAfterMs`, `limit`, `used` for rate limit and concurrency denials. Update all six denial paths to return structured objects.

**Current signature:**
```typescript
checkAccess(capability: string, _agentId: string, sessionId: string): string | undefined
```

**New signature:**
```typescript
checkAccess(capability: string, _agentId: string, sessionId: string): CapabilityDenial | undefined
```

**Type contract in `ToolContext`** (`packages/domain/src/tools.ts`):
The `capabilityEngine.checkAccess` type in the `ToolContext` interface also returns `string | undefined`. This must be updated to `CapabilityDenial | undefined` (or a compatible shape). Since `ToolContext` uses a structural type (not importing `CapabilityDenial` directly), define the shape inline or export a shared type from domain.

**Acceptance criteria:**
- `checkAccess` returns `undefined` (allowed) or a `CapabilityDenial` object.
- Rate limit denial includes `retryAfterMs` computed from the window state.
- Concurrency denial includes `limit` and `used` but no `retryAfterMs`.
- Permanent denials (`capability_disabled`, `capability_never_allowed`, `kill_switch_active`, `unknown_capability`) have no `retryAfterMs`.
- All denial objects include a human-readable `message`.
- `pnpm lint` passes.

### Phase 2: Direct Tool Error Responses — DONE

**Effort:** ~0.5 day
**Risk:** Low (changes error message content, not control flow)
**Depends on:** Phase 1

**Files modified:**
- `apps/worker/src/tools/code.ts` — Replace string interpolation with structured `capabilityDeniedResult()` call. Set `retryable` from denial object.
- `apps/worker/src/tools/web-access.ts` — Same for `search_web`, `browse_url`, `read_document`.
- `apps/worker/src/tools/tool-errors.ts` (new file) — Shared `capabilityDeniedResult(capability, denial)` helper.
- `packages/domain/src/tools.ts` — Update `capabilityEngine.checkAccess` type signature in `ToolContext` to return the structured denial type.

**Acceptance criteria:**
- `execute_code` rate limit denial returns: `{ success: false, error: "Rate limited: execute_code used 5/5 times this minute. Try again in 42s.", retryable: true, data: { reason: "rate_limit_exceeded", retryAfterMs: 42000, limit: 5, used: 5 } }`.
- `search_web`, `browse_url`, `read_document` produce equivalent structured responses.
- `retryable` is `true` for transient denials, `false` for permanent ones.
- `fault` is `false` for all capability denials (not a tool infrastructure fault).
- `pnpm lint` passes.

### Phase 3: Broker Denial Replies — DONE

**Effort:** ~1 day
**Risk:** Medium (changes broker behavior for brokered tools)
**Depends on:** Phase 1

**Files modified:**
- `apps/worker/src/agents/agent-message-broker.ts` — After `checkAccess` denial:
  1. Extract the reply key from the envelope payload (varies by message type).
  2. Push a structured rejection reply to the Redis reply key.
  3. Update the `checkAccess` call to use the new structured return type.
  4. Log structured fields.
- `apps/worker/src/tools/trading.ts` — Handle `status: 'rejected'` in the `blpop` reply parsing for `submit_decision`.
- `apps/worker/src/tools/assess-strategy-preset.ts` — Handle `status: 'rejected'` if it uses synchronous reply.
- `apps/worker/src/tools/change-strategy-preset.ts` — Same.
- `apps/worker/src/tools/skills.ts` — Handle `status: 'rejected'` in manage_agent_skills reply parsing.

**Reply key extraction logic:**

| Message type | Reply key source | Key format |
|---|---|---|
| `DECISION_SUBMIT` | `payload.decisionId` | `agent:decision:reply:{decisionId}` |
| `ASSESS_STRATEGY_PRESET` | `payload.requestMessageId` | Published via `eventPublisher.publishPresetToolReply` |
| `CHANGE_STRATEGY_PRESET` | `payload.requestMessageId` | Same |
| `MANAGE_AGENT_SKILLS` | `payload.requestMessageId` | Published via `eventPublisher.publishSkillsReply` |
| `SEND_MESSAGE` | None (fire-and-forget) | Log only, no reply |
| `PUBLISH_ARTIFACT` | None (fire-and-forget) | Log only, no reply |

**Acceptance criteria:**
- `submit_decision` rate limit denial returns immediately (not after 30s timeout): `{ success: false, error: "Rate limited: submit_decision used 10/10 times this minute. Try again in 18s.", retryable: true }`.
- `assess_strategy_preset`, `change_strategy_preset`, `manage_agent_skills` — same.
- Fire-and-forget tools (`send_message`, `publish_artifact`) log the denial with structured fields but don't need a reply channel fix.
- No change to the happy path — allowed messages flow through identically.
- `pnpm lint` passes.

### Phase 4: Structured Logs — PENDING

**Effort:** ~0.25 day
**Risk:** None
**Depends on:** Phase 1

**Files modified:**
- `apps/worker/src/agents/capability-policy.ts` — Not needed (the engine doesn't log, callers do).
- `apps/worker/src/tools/code.ts` — Update `logger.warn` to include structured denial fields.
- `apps/worker/src/tools/web-access.ts` — Same for all three tools.
- `apps/worker/src/agents/agent-message-broker.ts` — Update broker denial log to include structured fields.

**Acceptance criteria:**
- Denial log lines include `reason`, `limit`, `used`, `retryAfterMs` as structured fields (not embedded in a message string).
- `pnpm lint` passes.

---

## Backward Compatibility

### `ToolContext.capabilityEngine.checkAccess` type change

The `ToolContext` interface in `packages/domain/src/tools.ts` defines `checkAccess` with return type `string | undefined`. This is a **breaking type change** to `CapabilityDenial | undefined`.

All callers are within the `apps/worker/` package (tools and broker). There are no external consumers of this interface. All callers are updated in the same PR, so the type change is safe.

### Agent LLM behavior

The error message content changes from `"capability policy denied: rate_limit_exceeded"` to `"Rate limited: execute_code used 5/5 times this minute. Try again in 42s."`. This is a content change, not a schema change. The LLM agent will naturally understand the new message better — no prompt changes needed.

The `retryable` field changes from `false` to `true` for transient denials. This is the correct semantic — the current `false` was a bug. The agent loop in `agent.ts` serializes `retryable` into the tool result JSON that the LLM sees, but does not act on it programmatically (no automatic retry logic). The LLM reads it as a hint.

### Broker reply format

The new `status: 'rejected'` reply is a new case that existing brokered tools don't handle. Until the tools are updated (Phase 3), an unhandled `'rejected'` status would fall through to the existing error path in each tool's reply parsing. For `submit_decision`, the fallback is:

```typescript
// Existing fallback (line ~135 in trading.ts):
return {
  success: false,
  error: parsed.message ?? `Decision rejected: ${parsed.code ?? 'unknown'}`,
  errorCode: parsed.code ?? 'decision_rejected',
};
```

This already produces a reasonable error. The Phase 3 changes add the `retryable` and `data` fields for a better experience, but the fallback is not broken.

---

## Key Files

| File | Role |
|---|---|
| `apps/worker/src/agents/capability-policy.ts` | `CapabilityPolicyEngine.checkAccess` — return type change, `CapabilityDenial` interface |
| `packages/domain/src/tools.ts` | `ToolContext.capabilityEngine.checkAccess` type signature |
| `apps/worker/src/tools/code.ts` | `execute_code` — consume structured denial, set `retryable: true` |
| `apps/worker/src/tools/web-access.ts` | `search_web`, `browse_url`, `read_document` — same |
| `apps/worker/src/tools/tool-errors.ts` | New shared `capabilityDeniedResult()` helper |
| `apps/worker/src/agents/agent-message-broker.ts` | Broker — push denial reply to Redis, structured logs |
| `apps/worker/src/tools/trading.ts` | `submit_decision` — handle `status: 'rejected'` reply |
| `apps/worker/src/tools/assess-strategy-preset.ts` | Handle `status: 'rejected'` reply |
| `apps/worker/src/tools/change-strategy-preset.ts` | Handle `status: 'rejected'` reply |
| `apps/worker/src/tools/skills.ts` | `manage_agent_skills` — handle `status: 'rejected'` reply |

## Effort Summary

| Phase | Effort | Risk |
|---|---|---|
| Phase 1: Structured `checkAccess` return type | ~0.5 day | Low |
| Phase 2: Direct tool error responses | ~0.5 day | Low |
| Phase 3: Broker denial replies | ~1 day | Medium |
| Phase 4: Structured logs | ~0.25 day | None |
| **Total** | **~2.25 days** | |
