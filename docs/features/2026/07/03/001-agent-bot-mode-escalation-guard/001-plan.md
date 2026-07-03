# Plan: Agent Bot Mode Escalation Guard

**Status:** draft  
**Created:** 2026-07-03  
**Feature ID:** agent-bot-mode-escalation-guard

## Problem

A shadow-mode agent was able to escalate two of its bots to live execution mode via the `adjust_bot_config` tool, bypassing all enforcement. The tool called `ctx.botRepo.updateBotConfig()` directly — it never routes through the broker's `handleManageBot`, which is the only place the `MODE_RANK` escalation check exists.

The evaluation that ran after the session did not detect the escalation either, because it has no check for execution-mode coherence between an agent and its bots.

### Root cause

Two separate gaps:

**Gap 1 — Enforcement gap**: `adjust_bot_config` is a *direct tool* (writes to DB via `ctx.botRepo`). The broker's `MODE_RANK` check only covers the `manage_bot` message path. Any tool that writes bot config directly bypasses it.

**Gap 2 — Observability gap**: The evaluation skill has no audit step for execution-mode coherence. The only observable symptom (`fetchTicker failed` warnings) was indistinguishable from a normal venue-symbol format issue.

---

## Goals

1. Make execution-mode escalation via `adjust_bot_config` impossible, with a clear rejection message.
2. Add a defence-in-depth check at the tool-context level so future direct-DB tools cannot accidentally bypass mode enforcement.
3. Extend the evaluate-agent skill to audit execution-mode coherence and flag mode-escalation tool calls as HIGH-severity anomalies.
4. Store enough tool-call detail to make retrospective audits feasible.

---

## Scope

### In scope
- Shared `checkModeEscalation` enforcement helper (removes duplication from broker + new tool call site)
- `adjust_bot_config` tool enforcement (uses the shared helper)
- `ToolContext` extension to carry `executionMode`
- `agent.ts` toolContext builder
- Agent notification when a user patches an agent-created bot's config via the HTTP API
- `evaluate-agent` SKILL.md anomaly checks
- `agent_messages` schema to store tool-call arguments

### Out of scope
- Broker `adjust_config` action (already enforced; refactored to use shared helper but behaviour unchanged)
- Restricting `PATCH /bots/:id/config` by agent execution mode — users may intentionally upgrade agent bots; resolved as allow + notify (see Q1 resolution below)

---

## Implementation Steps

### Step 1 — Extract a shared `checkModeEscalation` helper

**File:** `packages/domain/src/trading/mode-rank.ts` (new file)

Create a small, zero-dependency utility that both the broker and the tool can import:

```ts
export const MODE_RANK: Record<string, number> = { paper: 0, shadow: 1, live: 2 };

export function checkModeEscalation(
  requestedMode: string,
  agentMode: string,
  context: 'create' | 'adjust' = 'adjust',
): { allowed: true } | { allowed: false; error: string } {
  const agentRank = MODE_RANK[agentMode] ?? 0;
  const requestedRank = MODE_RANK[requestedMode] ?? 0;
  if (requestedRank > agentRank) {
    const permitted = Object.keys(MODE_RANK)
      .filter((m) => (MODE_RANK[m] ?? 0) <= agentRank)
      .join(', ');
    const verb = context === 'create' ? 'create a bot with' : 'adjust a bot to';
    return {
      allowed: false,
      error: `Cannot ${verb} execution mode "${requestedMode}". Permitted execution modes: ${permitted}.`,
    };
  }
  return { allowed: true };
}
```

Export it from `packages/domain/src/trading/index.ts` (or the domain barrel).

**Also update `agent-message-broker.ts`:** Replace the two inline `MODE_RANK` blocks (lines ~659 and ~846) with calls to `checkModeEscalation`. This removes the duplication that motivated Q2 without changing any behaviour.

---

### Step 2 — Add `executionMode` to `ToolContext`

**File:** `packages/domain/src/tools.ts`

Add a required field to the `ToolContext` interface:

```ts
/** The agent's own execution mode. Used by tools that enforce mode-rank constraints. */
executionMode: 'paper' | 'shadow' | 'live';
```

Placement: after the existing `phase` field, before `redis`.

All existing `ToolContext` construction sites (test factories and production code) must be updated to supply this field. For test factories, add `executionMode: 'paper'` unless the test specifically exercises a different mode.

---

### Step 3 — Populate `executionMode` in the tool-context builder

**File:** `apps/worker/src/agent.ts`

In the `toolContext` object literal (around line 1482), add:

```ts
executionMode: (agentConfig.executionMode ?? 'paper') as 'paper' | 'shadow' | 'live',
```

`agentConfig.executionMode` is already in scope as a closure variable at this call site.

---

### Step 4 — Enforce mode-rank in `adjust_bot_config`

**File:** `apps/worker/src/tools/bots.ts`

Import `checkModeEscalation` from `@herobids/domain`. In `adjustBotConfigTool.execute`, after reading `configTarget` and before calling `deepMergeConfig`:

```ts
const requestedMode = config.execution?.mode;
if (requestedMode) {
  const check = checkModeEscalation(requestedMode, ctx.executionMode ?? 'paper');
  if (!check.allowed) {
    return { success: false, error: check.error, fault: false };
  }
}
```

The tool stays fully synchronous. The check delegates all enforcement logic to the shared helper. Because `executionMode` is now required on `ToolContext`, the `?? 'paper'` fallback can be dropped here if desired, though keeping it is harmless.

---

### Step 5 — Notify the agent when a user patches its bot's config

**Context:** Users are permitted to change an agent-created bot's execution mode via `PATCH /bots/:id/config` (this is intentional — see Q1 resolution). However the agent must be informed automatically so it can reason about the change in its next tick.

**File:** `apps/api/src/routes/bots.ts`

In the `PATCH /bots/:id/config` handler, after the successful `db.update(...)` call, check whether the bot was agent-created and whether the execution mode changed. If both are true, publish a notification to the agent's inbound stream:

```ts
if (existing.creatorType === 'agent' && existing.creatorId && newExecutionMode) {
  const previousMode = (existing.config as Record<string, unknown>)
    ?.['execution']?.['mode'] as string | undefined;
  if (previousMode !== newExecutionMode) {
    await agentEventPublisher.emitBotConfigChanged(existing.creatorId, {
      botId: id,
      changedBy: 'user',
      previousExecutionMode: previousMode ?? null,
      newExecutionMode,
      changedAt: new Date().toISOString(),
    });
  }
}
```

The `agentEventPublisher` (or equivalent) publishes to the agent's inbound Redis stream using the existing event infrastructure. The agent will see this as a context update on its next tick, similar to how `emitInstanceStatus` works today.

If the API does not currently have access to the event publisher, wire it in via the `botRoutes` factory function — the same way `queue` and `db` are already injected.

**Note:** This notification should also be emitted for any other field changes to agent-created bots (symbol, strategy, risk params) — not only execution-mode changes. Scope this step to execution-mode changes for now; generalising is a follow-up.

---

### Step 6 — Add unit tests

**`packages/domain/src/trading/mode-rank.test.ts`** (new):
- `checkModeEscalation` returns allowed for same-rank
- `checkModeEscalation` returns allowed for downgrade
- `checkModeEscalation` returns error for escalation, with correct permitted list
- error message uses 'create' vs 'adjust' verb correctly

**`apps/worker/src/tools/bots.test.ts`** (additions):
- `rejects paper agent adjusting bot to shadow mode`
- `rejects paper agent adjusting bot to live mode`
- `rejects shadow agent adjusting bot to live mode`
- `allows paper agent adjusting bot to paper mode`
- `allows shadow agent adjusting bot to shadow mode`
- `allows shadow agent adjusting bot to paper mode` (downgrade is always allowed)
- `allows live agent adjusting bot to any mode`
- `no-op when execution.mode is absent from the adjustment` (must not reject)

**`apps/worker/src/agents/agent-broker.test.ts`** (regression):
- Existing broker `adjust_config` tests must continue passing after the inline logic is replaced with `checkModeEscalation`

---

### Step 7 — Store tool-call arguments in `agent_messages`

**Current state:** `agent_messages` records for `agent.tool.call` store only `toolName`, `tickId`, `correlationId`, and `phase`. The arguments the agent passed are not persisted.

**Change:** Extend the payload stored in `agent_messages` for `tool.call` events to include the sanitised tool-call arguments for every tool call, always on. This enables retrospective audits without needing to replay the entire session.

Files to change:
- `apps/worker/src/agent.ts` — where `AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL` is emitted (around line 1540); add `args: sanitisedArgs` to the emitted payload.
- Sanitisation: JSON-serialise the validated params object and truncate the resulting string at **2 048 characters** if it exceeds the cap. The truncated value is stored as-is (suffix with `…` to signal truncation). No per-tool exclusions.

---

### Step 8 — Update the evaluate-agent skill

**File:** `.github/skills/evaluate-agent/SKILL.md`

**8a — Add execution-mode coherence check to Step 6 (Anomalies):**

Add to the "Are restrictions enforced?" bullet:

> **Execution-mode coherence:** For each agent under evaluation, query all bots where `creator_id = <agent-id>` and verify `config->'execution'->>'mode'` rank ≤ agent's `execution_mode`. Flag any bot where the bot mode outranks the agent mode as a HIGH anomaly. Include the bot's `created_at` and `updated_at` to determine whether the escalation happened at creation or via a config update.

**8b — Add `adjust_bot_config` mode-escalation check:**

Add a new bullet under "Policy anomalies":

> **Bot config escalation audit:** Query `agent_messages` for all `agent.tool.call` records where `payload->>'toolName' = 'adjust_bot_config'`. For each such call, join to the `bots` table and compare the bot's current `config->'execution'->>'mode'` against the agent's `execution_mode`. If the bot mode outranks the agent mode and the bot's `updated_at` is close to the tool call's `created_at`, flag this as a HIGH security anomaly: "agent escalated bot execution mode via adjust_bot_config". If Step 7 (arg storage) has been implemented, query the stored args directly instead of inferring from timestamps.

**8c — Separate policy anomalies from operational anomalies:**

Split the existing "Anomalies" section into two subsections:

- **Policy anomalies** (HIGH by default): execution-mode coherence violations, unauthorised access attempts, risk-limit bypass attempts. These map to bugs or security issues.
- **Operational anomalies**: rate-limit hits, ticker-fetch failures, stuck lifecycle states, memory issues. These map to degraded-but-expected behaviour.

This prevents a burst of `fetchTicker failed` warnings from drowning out a single execution-mode violation.

---

## Testing Plan

| Layer | What to test |
|---|---|
| Unit — `checkModeEscalation` helper | All rank combinations, correct error message copy |
| Unit — `adjust_bot_config` tool | Mode-rank enforcement (Step 6 cases above) |
| Unit — broker `adjust_config` | Regression: existing tests must pass unchanged after refactor to shared helper |
| Unit — broker `create_and_start` | Regression: same |
| Integration (optional) | Agent in shadow mode calls `adjust_bot_config` with `mode: live`; verify rejection and no DB change |

---

## Resolved Questions

### Q1 ✅ — `PATCH /bots/:id/config` enforcement

**Decision:** Allow. A user can intentionally upgrade an agent's bot to live mode (they own the bot and the account, just as they can delete it). The restriction only applies to the agent acting autonomously. The API path is left unrestricted.

**Action:** Add agent notification (Step 5) — when the user changes an agent-created bot's execution mode via the API, publish an event to the agent's inbound stream so it learns about the change automatically on its next tick.

---

### Q2 ✅ — Keeping `adjust_bot_config` synchronous

**Decision:** Do not route through the broker. Extract a shared `checkModeEscalation` helper (Step 1) and call it inline in both the broker and the tool. The tool stays synchronous; the broker is refactored to use the shared helper (no behaviour change). No new async patterns introduced.

---

### Q3 ✅ — Existing live bots from the incident

**Decision:** Both bots (`6b9b0d00` / SOL and `22d67242` / BTC) have been deleted. No further action needed.

---

## Open Questions

### Q4 ✅ — `executionMode` in `ToolContext` is required

**Decision:** Required (`executionMode: 'paper' | 'shadow' | 'live'`). TypeScript will error at every construction site that omits it; no silent fallback. All test factories get `executionMode: 'paper'` added (mechanical change, no logic). See Step 2.

---

### Q5 ✅ — Tool-call argument storage: always-on, 2 KB cap

**Decision:** Option (a). Every `agent.tool.call` event stores the JSON-serialised tool arguments, truncated at 2 048 characters. Simple, consistent, no config or per-tool flags. See Step 7.
