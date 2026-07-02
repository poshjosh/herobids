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
- `adjust_bot_config` tool enforcement
- `ToolContext` extension to carry `executionMode`
- `agent.ts` toolContext builder
- `evaluate-agent` SKILL.md anomaly checks
- `agent_messages` schema to store tool-call arguments

### Out of scope
- `PATCH /bots/:id/config` HTTP endpoint (user-direct path — tracked separately as an open question)
- Existing live bots that resulted from this incident (operational remediation, not a code change)
- Broker `adjust_config` action (already enforced; no change needed)

---

## Implementation Steps

### Step 1 — Add `executionMode` to `ToolContext`

**File:** `packages/domain/src/tools.ts`

Add an optional field to the `ToolContext` interface:

```ts
/** The agent's own execution mode. Used by tools that enforce mode-rank constraints. */
executionMode?: 'paper' | 'shadow' | 'live';
```

Placement: after the existing `phase` field, before `redis`.

---

### Step 2 — Populate `executionMode` in the tool-context builder

**File:** `apps/worker/src/agent.ts`

In the `toolContext` object literal (around line 1482), add:

```ts
executionMode: (agentConfig.executionMode ?? 'paper') as 'paper' | 'shadow' | 'live',
```

`agentConfig.executionMode` is already in scope as a closure variable at this call site.

---

### Step 3 — Enforce mode-rank in `adjust_bot_config`

**File:** `apps/worker/src/tools/bots.ts`

In `adjustBotConfigTool.execute`, after reading `configTarget` and before calling `deepMergeConfig`, insert a mode-rank check:

```ts
const requestedMode = config.execution?.mode;
if (requestedMode) {
  const MODE_RANK: Record<string, number> = { paper: 0, shadow: 1, live: 2 };
  const agentRank = MODE_RANK[ctx.executionMode ?? 'paper'] ?? 0;
  const requestedRank = MODE_RANK[requestedMode] ?? 0;
  if (requestedRank > agentRank) {
    const permitted = Object.keys(MODE_RANK).filter(
      (m) => (MODE_RANK[m] ?? 0) <= agentRank
    );
    return {
      success: false,
      error: `Cannot adjust a bot to execution mode "${requestedMode}". ` +
             `Permitted execution modes for this agent: ${permitted.join(', ')}.`,
      fault: false,
    };
  }
}
```

This mirrors the exact logic in `agent-message-broker.ts` (lines 659–665 and 846–852) so enforcement is identical across both paths.

---

### Step 4 — Add unit tests for the new enforcement

**File:** `apps/worker/src/tools/bots.test.ts` (or wherever bot-tool tests live)

Add test cases:
- `rejects paper agent adjusting bot to shadow mode`
- `rejects paper agent adjusting bot to live mode`
- `rejects shadow agent adjusting bot to live mode`
- `allows paper agent adjusting bot to paper mode`
- `allows shadow agent adjusting bot to shadow mode`
- `allows shadow agent adjusting bot to paper mode` (downgrade is always allowed)
- `allows live agent adjusting bot to any mode`
- `no-op when execution.mode is absent from the adjustment` (must not reject)

---

### Step 5 — Store tool-call arguments in `agent_messages`

**Current state:** `agent_messages` records for `agent.tool.call` store only `toolName`, `tickId`, `correlationId`, and `phase`. The arguments the agent passed are not persisted.

**Change:** Extend the payload stored in `agent_messages` for `tool.call` events to include the sanitised tool-call arguments (excluding anything that could be large, like code strings — cap at ~2 KB). This enables retrospective audits without needing to replay the entire session.

Files to change:
- `apps/worker/src/agent.ts` — where `AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL` is emitted (around line 1540); add `args: sanitisedArgs` to the emitted payload.
- Define `sanitisedArgs` as: JSON-serialise the validated params, truncate the JSON string at 2 048 chars if over limit.

---

### Step 6 — Update the evaluate-agent skill

**File:** `.github/skills/evaluate-agent/SKILL.md`

**6a — Add execution-mode coherence check to Step 6 (Anomalies):**

Add to the "Are restrictions enforced?" bullet:

> **Execution-mode coherence:** For each agent under evaluation, query all bots where `creator_id = <agent-id>` and verify `config->'execution'->>'mode'` rank ≤ agent's `execution_mode`. Flag any bot where the bot mode outranks the agent mode as a HIGH anomaly. Include the bot's `created_at` and `updated_at` to determine whether the escalation happened at creation or via a config update.

**6b — Add `adjust_bot_config` mode-escalation check:**

Add a new bullet under "Anomalies":

> **Bot config escalation audit:** Query `agent_messages` for all `agent.tool.call` records where `payload->>'toolName' = 'adjust_bot_config'`. For each such call, join to the `bots` table and compare the bot's current `config->'execution'->>'mode'` against the agent's `execution_mode`. If the bot mode outranks the agent mode and the bot's `updated_at` is close to the tool call's `created_at`, flag this as a HIGH security anomaly: "agent escalated bot execution mode via adjust_bot_config".

**6c — Separate policy anomalies from operational anomalies:**

Split the existing "Anomalies" section into two subsections:

- **Policy anomalies** (HIGH by default): execution-mode coherence violations, unauthorised access attempts, risk-limit bypass attempts. These map to bugs or security issues.
- **Operational anomalies**: rate-limit hits, ticker-fetch failures, stuck lifecycle states, memory issues. These map to degraded-but-expected behaviour.

This prevents a burst of `fetchTicker failed` warnings from drowning out a single execution-mode violation.

---

## Testing Plan

| Layer | What to test |
|---|---|
| Unit — `adjust_bot_config` | Mode-rank enforcement (Step 4 cases above) |
| Unit — broker `adjust_config` | Existing tests should continue passing unchanged |
| Integration (optional) | Agent in shadow mode calls `adjust_bot_config` with `mode: live`; verify rejection and no DB change |

---

## Open Questions

### Q1 — Should `PATCH /bots/:id/config` also enforce agent execution-mode coherence?

The HTTP endpoint allows any authenticated user to patch any bot they own to live mode, including bots originally created by a shadow-mode agent. The current investigation was via the tool path, not the API path, but the same escalation is possible via the UI or direct API call.

**Options:**
- a) Restrict: if `creatorType = 'agent'`, look up the agent's `executionMode` and apply the same `MODE_RANK` check.
- b) Allow: treat the user-direct API as an explicit override (the user owns the bot and the account; they can make it live if their plan allows it).
- c) Warn only: allow the update but emit a journal event / log warning so evaluations can surface it.

**Implication of (a):** It would prevent users from intentionally upgrading an agent-created bot to live after they've tested it — they'd have to recreate the bot directly or change the agent's mode first.

---

### Q2 — Should `adjust_bot_config` route through the broker instead of writing the DB directly?

Currently, `create_bot` uses `publishToInbound` → broker → DB. `adjust_bot_config` skips the broker. Routing `adjust_bot_config` through the broker as an `adjust_config` action would centralise all enforcement in one place and remove the need for Step 1–3 above.

**Trade-off:** It would add broker round-trip latency to every config adjustment, and it changes the tool from a synchronous write to an async "submitted" pattern (matching `create_bot`'s note: *"bot creation submitted — you will see it on the next tick"*). This may confuse agents that call `adjust_bot_config` and immediately read back the config.

**Recommendation:** Keep the direct path for now, add the inline guard (Steps 1–3). Revisit consolidation in a future refactor.

---

### Q3 — What happens to the two existing live bots from this incident?

Bots `6b9b0d00` (SOL) and `22d67242` (BTC) are currently running with `execution.mode: "live"` but their actors started in shadow mode. Their `instanceExecutionModes` in the worker registry has them as shadow, but their persisted config says live.

On the next restart (worker restart, `adjust_config`, or reclaim sweep) they will start as live actors. This may be unintentional.

**Needs a decision:** Should these bots be manually downgraded to shadow mode in the DB, or stopped, before the fix is deployed?

---

### Q4 — Should `executionMode` in `ToolContext` be required or optional?

Making it optional (`executionMode?: string`) means the enforcement in `adjust_bot_config` needs a fallback default (`?? 'paper'`), which is conservative. Making it required would require updating all test factories and would be a larger diff. The plan uses optional with a `'paper'` fallback, which is safe-by-default.

---

### Q5 — Should the evaluation tool-call argument storage (Step 5) be gated by config?

Storing full arguments for every tool call will increase `agent_messages` table size, especially for tools like `execute_code` that can have large `code` strings. The 2 KB cap partially addresses this, but operators with cost-sensitive deployments may want to disable it entirely.

**Options:**
- a) Always-on with the 2 KB cap (simplest, consistent)
- b) Gated by a new `agentRuntime.observability.storeToolArgs: boolean` config flag (defaults true)
- c) Per-tool opt-in via a `storeArgs: boolean` field on `AgentTool`
