# Capability Gating Enforcement & Centralized Timeout

**Status:** Draft
**Created:** 2026-08-31
**Area:** Agent runtime, capability policy, tool safety
**Prerequisite for:** [001-plan-tiered-capability-limits](../001-plan-tiered-capability-limits/001-plan.md) (tiered plan entitlements build on working enforcement)

---

## Problem Statement

The `CapabilityPolicyEngine` declares grants for 17 capabilities with rate limits, concurrency caps, and timeouts. In practice:

1. **Only 6 tools are wired** to `checkAccess` / `recordStart` / `recordEnd` (`search_web`, `browse_url`, `read_document`, `execute_code`, `make_http_request`, `browse_interactive`). The remaining tools — including high-risk ones like bot lifecycle and messaging — skip the engine entirely.

2. **`timeoutMs` is never enforced** at the engine level. Some tools read it as a fallback for their internal HTTP/process timeouts, but nothing kills a tool invocation that exceeds its budget. A hung CDP session or stalled broker reply holds a concurrency slot indefinitely.

3. **Two gated tools reference missing grants.** `read_document` and `make_http_request` call `checkAccess` but have no entry in `DEFAULT_CAPABILITY_GRANTS`, causing `unknown_capability` denials when `capabilityEngine` is present.

4. **The kill switch only reaches gated tools.** Since ungated tools never call `checkAccess`, activating the kill switch does not stop them.

### Risk Summary

| Gap | Worst case |
|---|---|
| `send_message` ungated | Runaway agent spams user with hundreds of messages per minute |
| `publish_artifact` ungated | Unbounded artifact creation burns storage |
| Bot lifecycle ungated | Agent creates unlimited bots with no throttle |
| Skill management ungated | Agent adds/removes skills in a loop, thrashing tool visibility |
| `timeoutMs` unenforced | Hung browser/HTTP call holds concurrency slot forever; 2 stuck `browse_interactive` calls = agent can't browse at all |
| Missing grants for gated tools | `read_document` and `make_http_request` are denied when `capabilityEngine` is present |

## Goals

1. Wire capability gating into all tools that have matching grants in `DEFAULT_CAPABILITY_GRANTS`.
2. Fix the missing grants for `read_document` and `make_http_request`.
3. Enforce `timeoutMs` centrally so no tool invocation can exceed its budget.
4. Clean up stateful resources (browser sessions) on timeout.
5. Document why `submit_decision` is intentionally excluded from tool-level gating.

## Non-Goals

- Gating low-risk internal tools (memory, tasks, resolvers, `find_instrument`, `get_account_summary`, platform-docs, `get_schema`). These are Redis-only or in-memory lookups with no external I/O, no cost implications, and bounded blast radius. The kill switch already covers the "runaway agent" scenario for all tools via the skill-set gate in `executeTool`.
- `maxInvocations` enforcement (scoped to [001-plan-tiered-capability-limits](../001-plan-tiered-capability-limits/001-plan.md) Phase 2).
- Per-capability `maxTotalDownloadBytes` (already enforced at container level by `SandboxEnforcer`).
- Plan-tiered entitlements or argument limits (separate feature).

## Design Decisions

### D1. Centralized `withCapabilityGating` wrapper

**Decision:** Extract the repeated `checkAccess` / `recordStart` / `try`/`finally recordEnd` boilerplate into a shared helper function in `tool-errors.ts`.

**Rationale:** The same ~25-line pattern is copy-pasted in 6 tools today. Adding it to 7 more tools would make 13 copies. A single wrapper eliminates the duplication and makes it impossible to forget `recordEnd` in a `finally` block. It also gives us a natural place to add the timeout enforcement (D2) without touching every tool.

**Signature:**

```typescript
/**
 * Wrap a tool's execute body with capability policy enforcement:
 * checkAccess → recordStart → execute → recordEnd (in finally).
 *
 * If `capabilityEngine` is absent on the context, the body executes ungated
 * (backward-compatible with tests and environments without the engine).
 */
export async function withCapabilityGating(
  capability: string,
  ctx: ToolContext,
  body: () => Promise<ToolResult>,
  options?: {
    /** Override the input summary logged in the audit record. Default: capability name. */
    inputSummary?: string;
  },
): Promise<ToolResult>
```

**Migration path for existing tools:** Existing inline gating in the 6 already-wired tools should be replaced with the wrapper in the same PR for consistency. This is mechanical and low-risk — the behavior is identical.

### D2. Centralized `timeoutMs` enforcement via `Promise.race`

**Decision:** Enforce `timeoutMs` inside `withCapabilityGating` rather than in `executeTool`.

**Rationale:** Placing it in the wrapper means:
- Only capability-gated tools get the timeout. Low-risk ungated tools (memory, tasks) are unaffected.
- The timeout races against the `body()` promise, not the entire `executeTool` pipeline (which includes parameter validation, event emission, etc.).
- The `finally` block in the wrapper guarantees `recordEnd` fires even on timeout, decrementing the concurrency counter.

**Implementation:**

```typescript
const grant = ctx.capabilityEngine?.getGrant(capability);
const timeoutMs = grant?.limits?.timeoutMs;

let result: ToolResult;
if (timeoutMs) {
  result = await Promise.race([
    body(),
    rejectAfterTimeout(timeoutMs, capability),
  ]);
} else {
  result = await body();
}
```

The timeout rejection is caught inside the wrapper's try/catch and converted to a `ToolResult` with `errorCode: 'capability.timeout'` and `retryable: false`.

**Important:** The underlying `body()` promise continues running after the timeout fires. For most tools this is harmless — the publish-to-Redis or HTTP fetch completes (or fails) on its own. For `browse_interactive`, this creates a resource leak (see D3).

### D3. Browser session cleanup on timeout

**Decision:** Add an optional `onTimeout` callback to `withCapabilityGating` options. Only `browse_interactive` provides it.

**Rationale:** When a `browse_interactive` call times out, the CDP session stays in `activeSessions`, holding both a concurrency slot in the policy engine and a session slot in the Browserless pool. The `onTimeout` callback calls the existing cleanup path (`cleanupBrowserSessions` or the equivalent per-session teardown).

`execute_code` does not need a cleanup callback — its child process has its own `exec` timeout that will kill it independently, and the sandbox directory is cleaned at the start of the next invocation.

```typescript
export async function withCapabilityGating(
  capability: string,
  ctx: ToolContext,
  body: () => Promise<ToolResult>,
  options?: {
    inputSummary?: string;
    /** Called when the timeout fires, before returning the timeout error.
     *  Use to release stateful resources (e.g. browser sessions). */
    onTimeout?: () => Promise<void>;
  },
): Promise<ToolResult>
```

### D4. `submit_decision` excluded from tool-level gating

**Decision:** Do not add `checkAccess` / `recordStart` / `recordEnd` to `submit_decision`. Rely exclusively on broker-side enforcement.

**Rationale:**

`submit_decision` is architecturally different from every other tool:

1. It publishes a `DECISION_SUBMIT` message to the broker via `publishToInbound`, then blocks for up to 30s on `ctx.redis.blpop(replyKey, 30)` waiting for the engine's reply. The broker already runs the decision through the `DecisionIntakeResolver` and risk gate, and returns `status: 'rejected'` with capability denial codes when limits are hit.

2. **Double-counting concurrency:** With `maxConcurrent: 1`, tool-level `recordStart` would hold the concurrency slot for the entire 30s `blpop` wait — the agent couldn't submit a second decision until the first clears the engine pipeline. While serial submission is arguably desirable, it should be the broker's decision, not a side effect of the `blpop` holding an unrelated concurrency counter.

3. **Rate-limit stacking:** Tool-level and broker-level rate limiters would run independent sliding windows. An agent could pass one and fail the other, producing confusing, inconsistent denial messages.

4. **Timeout race condition:** The grant's `timeoutMs` (30s) matches the `blpop` timeout (30s). A centralized timeout could fire just before a valid reply arrives, killing a successful trade submission. The engine still executes the trade — the agent just doesn't know.

The broker is the authority for trade decisions. It has the risk gate, the execution context, and the definitive rate limiter. Adding a second, weaker rate limiter at the tool level creates confusion without meaningful safety benefit.

**Action:** Add a code comment in `trading.ts` documenting this decision (see Phase 1 tasks).

### D5. Tool-to-capability mapping

Tools that need gating wired, grouped by capability:

| Capability | Tools | File |
|---|---|---|
| `send_message` | `send_message` | `messaging.ts` |
| `publish_artifact` | `publish_artifact` | `messaging.ts` |
| `manage_bot` | `create_bot`, `stop_bot`, `start_bot`, `adjust_bot_config` | `bots.ts` |
| `bot_query` | `list_bots`, `get_bot_status`, `resolve_bot` | `bots.ts`, `resolvers.ts` |
| `manage_agent_skills` | `add_skills`, `remove_skills` | `skills.ts` |
| `search_skills` | `search_skills`, `list_skills` | `skills.ts` |
| `assess_strategy_preset` | `assess_strategy_preset` | (broker-mediated, gating already happens via broker reply — verify and document) |
| `change_strategy_preset` | `change_strategy_preset` | (broker-mediated, same as above — verify and document) |

Tools intentionally excluded from gating:

| Tool | Reason |
|---|---|
| `submit_decision` | Broker-side enforcement (see D4) |
| `set_memory`, `get_memory`, `list_memory_keys`, `delete_memory` | Redis-only, no external I/O |
| `create_task`, `list_tasks`, `complete_task`, `schedule_reminder` | Redis-only, no external I/O |
| `resolve_watch`, `resolve_task` | Redis-only lookup helpers |
| `find_instrument` | DB read, no cost/risk |
| `get_account_summary` | DB read, no cost/risk |
| `search_app_docs`, `list_app_docs`, `read_app_docs` | Pure in-memory search |
| `get_schema` | Pure in-memory lookup |

### D6. `assess_strategy_preset` and `change_strategy_preset` gating

**Decision:** Verify whether these tools already receive broker-level capability enforcement (similar to `submit_decision`). If they do, document and skip tool-level gating. If they don't, wire them with `withCapabilityGating`.

These tools publish to the broker via `publishToInbound` and parse the reply. The `tool-errors.ts` file already has a `parseBrokerDenialReply` function specifically for these tools, suggesting the broker may already enforce limits. Verify during implementation and document the finding.

### D7. Missing grants for `read_document` and `make_http_request`

**Decision:** Add entries to `DEFAULT_CAPABILITY_GRANTS` for both capabilities.

- `read_document`: Same defaults as `browse_url` (`maxPerMinute: 10, maxConcurrent: 3, timeoutMs: 20_000, maxResponseBytes: 512 * 1024`).
- `make_http_request`: New grant — `tier: 'direct', enabled: true, limits: { maxPerMinute: 20, maxConcurrent: 3, timeoutMs: 20_000, maxResponseBytes: 256 * 1024 }`.

Without this fix, both tools return `unknown_capability` denials, which is a bug.

---

## Implementation

### Phase 1: Centralized wrapper + fix missing grants + wire remaining tools

**Effort:** ~1 day
**Risk:** Low — behavioral change is additive (tools that were ungated now have rate/concurrency limits). Existing gated tools get identical behavior from the wrapper.

#### Tasks

**1.1 — Create `withCapabilityGating` in `tool-errors.ts`**

Implement the wrapper function per D1 and D2. The function:
- Calls `checkAccess`; returns `capabilityDeniedResult` on denial.
- Calls `recordStart`.
- Races `body()` against `timeoutMs` (if present in the grant).
- On timeout: calls `onTimeout` if provided, returns `{ success: false, errorCode: 'capability.timeout', retryable: false }`.
- In `finally`: calls `recordEnd` with a `ToolInvocationRecord`.

**1.2 — Add missing grants to `DEFAULT_CAPABILITY_GRANTS`**

Add entries for `read_document` and `make_http_request` per D7.

**1.3 — Migrate existing gated tools to use the wrapper**

Replace the inline gating in these files with `withCapabilityGating`:
- `apps/worker/src/tools/web-access.ts` (`search_web`, `browse_url`, `read_document`)
- `apps/worker/src/tools/code.ts` (`execute_code`)
- `apps/worker/src/tools/http-client.ts` (`make_http_request`)
- `apps/worker/src/tools/browser.ts` (`browse_interactive`) — pass `onTimeout` for session cleanup

For `execute_code`: preserve the deferred-recordStart pattern. The wrapper should support an option to defer `recordStart` until the body explicitly signals readiness, or `execute_code` can keep its own gating if the wrapper can't cleanly accommodate this. Decision: use the wrapper with `recordStart` at the top (the concurrency slot is held during validation, which is fast). The previous pattern of deferring `recordStart` until after validation was an optimization, not a correctness requirement — validation failures return quickly and the slot is freed in `finally`.

For `browse_interactive`: pass `onTimeout` that calls `cleanupBrowserSessions(ctx.agentId)` or the equivalent per-session cleanup using `ctx.agentId` and `ctx.sessionId`.

**1.4 — Wire gating into newly-covered tools**

Add `withCapabilityGating` calls to:
- `apps/worker/src/tools/messaging.ts` — `send_message` (capability: `send_message`), `publish_artifact` (capability: `publish_artifact`)
- `apps/worker/src/tools/bots.ts` — `create_bot`, `stop_bot`, `start_bot`, `adjust_bot_config` (capability: `manage_bot`); `list_bots`, `get_bot_status` (capability: `bot_query`)
- `apps/worker/src/tools/skills.ts` — `add_skills`, `remove_skills` (capability: `manage_agent_skills`); `search_skills`, `list_skills` (capability: `search_skills`)
- `apps/worker/src/tools/resolvers.ts` — `resolve_bot` (capability: `bot_query`)

For broker-mediated tools (`assess_strategy_preset`, `change_strategy_preset`): verify broker-side enforcement per D6. If present, add a code comment documenting why tool-level gating is skipped. If absent, wire them.

**1.5 — Document `submit_decision` exclusion**

Add a comment block at the top of the `submitDecisionTool` definition in `trading.ts`:

```typescript
// Capability gating intentionally omitted for submit_decision.
//
// This tool is broker-mediated: it publishes DECISION_SUBMIT via publishToInbound
// and blocks up to 30s on blpop for the engine's reply. The broker enforces
// capability policy (rate limits, concurrency, enable/disable) and returns
// status: 'rejected' with capability denial codes.
//
// Adding tool-level gating would create:
// 1. Double-counting: recordStart holds the concurrency slot for the full blpop
//    wait (up to 30s), preventing legitimate sequential submissions.
// 2. Rate-limit stacking: two independent sliding windows produce inconsistent
//    denial messages.
// 3. Timeout race: grant timeoutMs (30s) matches blpop timeout (30s), risking
//    a false timeout on a successful trade execution.
//
// See docs/features/pending/002-capability-gating-enforcement/001-plan.md D4.
```

**1.6 — Tests**

For the `withCapabilityGating` wrapper:
- Rate-limit denial returns `capabilityDeniedResult` with `retryable: true`.
- Disabled-capability denial returns `capabilityDeniedResult` with `retryable: false`.
- Kill-switch denial returns correct result.
- `recordStart` / `recordEnd` are called on success.
- `recordEnd` is called on body failure (concurrency counter is decremented).
- Timeout fires: returns `capability.timeout` error, calls `onTimeout` if provided.
- Timeout does not fire when body completes within budget.
- No `capabilityEngine` on context: body executes ungated (backward compat).

For each newly-wired tool (can be lightweight — the wrapper tests cover the gating logic):
- Rate-limit denial test: pre-exhaust the rate counter, call the tool, assert denial.
- Verify the tool uses the correct capability name.

For `browse_interactive` timeout cleanup:
- Simulate a timeout, verify the browser session is cleaned up from `activeSessions`.

#### Files Modified

| File | Changes |
|---|---|
| `apps/worker/src/tools/tool-errors.ts` | Add `withCapabilityGating` function |
| `apps/worker/src/agents/capability-policy.ts` | Add `read_document` and `make_http_request` grants to `DEFAULT_CAPABILITY_GRANTS` |
| `apps/worker/src/tools/web-access.ts` | Replace inline gating with wrapper |
| `apps/worker/src/tools/code.ts` | Replace inline gating with wrapper |
| `apps/worker/src/tools/http-client.ts` | Replace inline gating with wrapper |
| `apps/worker/src/tools/browser.ts` | Replace inline gating with wrapper; add `onTimeout` for session cleanup |
| `apps/worker/src/tools/messaging.ts` | Add wrapper calls |
| `apps/worker/src/tools/bots.ts` | Add wrapper calls |
| `apps/worker/src/tools/skills.ts` | Add wrapper calls |
| `apps/worker/src/tools/resolvers.ts` | Add wrapper call for `resolve_bot` |
| `apps/worker/src/tools/trading.ts` | Add D4 comment block |
| `apps/worker/src/tools/tool-errors.test.ts` | Wrapper unit tests |
| `apps/worker/src/tools/browser.test.ts` | Timeout cleanup test |
| `apps/worker/src/tools/messaging.test.ts` | Denial wiring tests (new or extended) |
| `apps/worker/src/tools/bots.test.ts` | Denial wiring tests (new or extended) |
| `apps/worker/src/tools/skills.test.ts` | Denial wiring tests (new or extended) |

#### Acceptance Criteria

- All tools listed in D5 call `withCapabilityGating` with the correct capability name.
- `read_document` and `make_http_request` have grants in `DEFAULT_CAPABILITY_GRANTS` and no longer return `unknown_capability` denials.
- `submit_decision` has no tool-level gating; has a code comment documenting why (D4).
- The kill switch, when activated, denies all gated tools (verified by existing + new tests).
- `timeoutMs` is enforced: a tool that exceeds its grant's `timeoutMs` returns `capability.timeout`.
- `browse_interactive` timeout cleans up the CDP session from `activeSessions` and releases the Browserless pool slot.
- No inline gating boilerplate remains in any tool — all gating goes through the wrapper.
- `pnpm lint` passes.
- `pnpm test` passes.

---

## Appendix: Capability Grant Coverage After This Work

| Capability | Grant | Tool-level gating | Notes |
|---|---|---|---|
| `submit_decision` | Yes | No (broker-side) | D4 |
| `search_web` | Yes | Yes (wrapper) | Migrated from inline |
| `browse_url` | Yes | Yes (wrapper) | Migrated from inline |
| `read_document` | **Added** | Yes (wrapper) | D7 fix; migrated from inline |
| `execute_code` | Yes | Yes (wrapper) | Migrated from inline |
| `make_http_request` | **Added** | Yes (wrapper) | D7 fix; migrated from inline |
| `browse_interactive` | Yes | Yes (wrapper + onTimeout) | Migrated from inline |
| `publish_artifact` | Yes | **Yes (new)** | |
| `send_message` | Yes | **Yes (new)** | |
| `manage_bot` | Yes | **Yes (new)** | `create_bot`, `stop_bot`, `start_bot`, `adjust_bot_config` |
| `bot_query` | Yes | **Yes (new)** | `list_bots`, `get_bot_status`, `resolve_bot` |
| `manage_agent_skills` | Yes | **Yes (new)** | `add_skills`, `remove_skills` |
| `search_skills` | Yes | **Yes (new)** | `search_skills`, `list_skills` |
| `assess_strategy_preset` | Yes | Verify (D6) | Broker-mediated; may already be covered |
| `change_strategy_preset` | Yes | Verify (D6) | Broker-mediated; may already be covered |
| `venue_api` | Yes (never) | N/A | `tier: 'never'` — blocked at grant level |
| `raw_secrets` | Yes (never) | N/A | `tier: 'never'` — blocked at grant level |
| `database_write` | Yes (never) | N/A | `tier: 'never'` — blocked at grant level |
| `host_control` | Yes (never) | N/A | `tier: 'never'` — blocked at grant level |

Tools intentionally ungated (no grant, no gating needed):
`set_memory`, `get_memory`, `list_memory_keys`, `delete_memory`, `create_task`, `list_tasks`, `complete_task`, `schedule_reminder`, `resolve_watch`, `resolve_task`, `find_instrument`, `get_account_summary`, `search_app_docs`, `list_app_docs`, `read_app_docs`, `get_schema`.
