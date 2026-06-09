# 022 — Agent Tool Improvements (Steps 1–3)

Rename `decision_submit`, fix tool result-return, add bot lifecycle tools, add read
tools (analytics + positions), update skills.

**Depends on:** nothing — all work is in-process or against existing DB schema.
**Blocks:** 023 (trading skill needs `submit_decision` stable name).

---

## Background

Three problems today:

1. **Naming inconsistency.** `create_bot` is verb_noun; `decision_submit` is noun_verb.
   All tools must follow verb_noun: `submit_decision`.

2. **No tool result feedback.** `executeTool()` returns `void`. Brokered tools
  (`create_bot`, `decision_submit`, `send_message`, `publish_artifact`) are pure
   fire-and-forget — the LLM never learns whether a call succeeded, fails, or what
   data was produced. The only exception is `code_execute`, which already calls
   `addToHistory('user', result)`. This makes the `bot-management` skill broken in
   practice: the agent calls `create_bot` and receives no bot ID, no confirmation,
   no error.

3. **Missing tools.** The `bot-management` skill lists `create_bot` and
   `decision_submit` as its tools, but the agent can't list bots, can't stop or start
   them, and can't read analytics or positions. The `risk-monitoring` skill has no
   query tools at all.

---

## Scope

### Phase 0 — Result-return fix (prerequisite for everything else)

Change `executeTool()` so every tool feeds a result back to the LLM conversation.

**Mechanism** — two categories:

| Category | Tools | Return path |
|---|---|---|
| **Direct** | all new read tools + `set_memory` | `addToHistory('user', JSON.stringify(result))` immediately after execution |
| **Brokered** | `send_message`, `publish_artifact`, `decision_submit`, `create_bot` | Return an acknowledgment string immediately; deep results arrive via `instance.status` on next tick (unchanged from today) |

**Signature change:**

```ts
// Before
async function executeTool(call: ToolCall): Promise<void>

// After
async function executeTool(call: ToolCall): Promise<void>
// (signature unchanged — result written to history as side-effect inside the function)
```

Concrete change: after each tool's `switch` case, call `addToHistory('user', result)`
where `result` is:

```ts
// Brokered tools — immediate ack
'send_message': `{"ok":true,"note":"message queued for delivery"}`
'publish_artifact': `{"ok":true,"artifactId":"<uuid>"}`
'decision_submit' → 'submit_decision': `{"ok":true,"decisionId":"<uuid>","note":"decision submitted to engine"}`
'create_bot': `{"ok":true,"note":"bot creation submitted — you will see it in the bot list on the next tick"}`

// Direct tools — real result
'set_memory': `{"ok":true,"key":"<key>"}`
```

All new tools return real structured results (see Phase 2 and 3 below).

---

### Phase 1 — Rename `decision_submit` → `submit_decision`

Rename everywhere. Every occurrence is a string literal — no type or interface carries
the name, so this is a pure text search-and-replace.

**Files to update:**

| File | Change |
|---|---|
| `apps/worker/src/agent.ts` | `case 'decision_submit':` → `case 'submit_decision':` |
| `apps/worker/src/agent.ts` | acknowledgment result string |
| `packages/domain/src/skills.ts` | `BOT_MANAGEMENT_SKILL.requiredTools` |
| `packages/db/src/agent-runtime-descriptor.ts` | `row.requiredTools.includes('decision_submit')` |
| `apps/worker/src/agents/capability-sandbox.test.ts` | all `'decision_submit'` string literals |
| `apps/worker/src/agents/capability-policy.ts` | comment if present |
| `apps/worker/src/runtime-composition.test.ts` | `requiredTools` array |
| Any seed data or DB migration that inserts `decision_submit` | update string value |

After renaming, `submit_decision` must be removed from `bot-management` and moved
to the new `trading` skill (see Phase 4).

---

### Phase 2 — Bot lifecycle tools (direct in-process)

All these tools execute directly inside the agent process — no broker round-trip.
They query or mutate the DB and return a structured JSON result immediately, which
is appended to conversation history before the next LLM call.

**Why direct, not brokered?**
- The broker is the right place for operations that affect running BullMQ jobs
  (e.g. enqueuing a start job). But status updates and config changes are simple DB
  writes. Separating "update DB" from "signal the job" keeps things simple.
- Immediate feedback: the LLM knows the result in the same tick.

#### 2a — `list_bots`

Returns all bots created by this agent with current status, config summary, and P&L.

```ts
tool name:  list_bots
args:       {} (none required)
returns:    { bots: Array<{ id, name, status, strategyPreset?, symbol?, createdAt }> }
```

Implementation:
- Call `botRepo.getBotsByCreator('agent', AGENT_ID)`
- Map to a safe summary (omit full config JSONB — too verbose for LLM context)
- Return as JSON string → `addToHistory('user', result)`

#### 2b — `get_bot_status`

Returns detailed status for a single bot.

```ts
tool name:  get_bot_status
args:       { botId: string }
returns:    { id, status, strategyPreset?, symbol?, startedAt?, stoppedAt?, config }
```

Implementation:
- Query `bots` table by `id`, verify `creatorId === AGENT_ID` (ownership check)
- Return full config (agent created it, so it can see it)

#### 2c — `stop_bot`

Marks bot stopped in DB. The running BullMQ job is responsible for respecting this
(it must poll `bots.status` or subscribe to a Redis pub/sub channel — see "Signal
mechanism" note below).

```ts
tool name:  stop_bot
args:       { botId: string, reason?: string }
returns:    { ok: boolean, botId, previousStatus, note? }
```

Implementation:
- Verify `creatorId === AGENT_ID`
- Update `bots.status = 'stopped'`, `bots.stoppedAt = now()`
- Publish `bot:stop:{botId}` signal to Redis (pub/sub channel or stream entry) so
  the running job can self-terminate without polling
- Return result

**Signal mechanism note:** The BullMQ bot job must subscribe to `bot:stop:{botId}`
(Redis pub/sub) or periodically check `bots.status`. If neither is currently
implemented in `apps/worker/src/runtime.ts`, that must be added as part of this
feature. Check `runtime.ts` — there are already `case 'stop':` and `case 'start':`
branches that may provide this.

#### 2d — `start_bot`

Re-starts a stopped/crashed bot. Re-uses the existing `botStart` BullMQ callback
pattern, but triggered from the tool dispatch rather than from the broker.

```ts
tool name:  start_bot
args:       { botId: string }
returns:    { ok: boolean, botId, status: 'running', note? }
```

Implementation:
- Verify `creatorId === AGENT_ID` and `status !== 'running'`
- Update `bots.status = 'running'`, `bots.startedAt = now()`
- Enqueue BullMQ start job (same `botStart` callback the broker uses)
  → The agent process must have access to this callback; if it doesn't today,
  inject it via the same path used for `create_bot`

#### 2e — `adjust_bot_config`

Updates a bot's config JSONB. The running job will pick up the new config on its
next cycle (jobs already re-read config from DB periodically or on each tick).

```ts
tool name:  adjust_bot_config
args:       { botId: string, config: Record<string, unknown> }
returns:    { ok: boolean, botId, note: "config updated — takes effect on next bot tick" }
```

Implementation:
- Verify `creatorId === AGENT_ID`
- Deep-merge `config` over existing `bots.config` JSONB
- Update `bots.updatedAt = now()`
- Do NOT validate the full config schema here (the bot runtime will reject
  invalid values on its next tick and update status to 'crashed' with a reason)

---

### Phase 3 — Read tools: analytics and positions (direct in-process)

#### 3a — `get_analytics`

Returns trading analytics for bots created by this agent.

```ts
tool name:  get_analytics
args:       { botId?: string, days?: number }
returns:    { totalTrades, winRate, totalPnlUsd, avgHoldTimeHours, byBot?: [...] }
```

Implementation:
- Query `fills` table filtered by `creatorId = AGENT_ID` (and optionally `botId`)
- Compute: win rate (fills with pnl > 0 / total fills), total realized PnL,
  average hold time
- `days` defaults to 7; cap at 90
- The analytics queries already exist for the API analytics endpoint — reuse that
  query logic (likely in `packages/db/src/repositories.ts` or a dedicated analytics
  module)

#### 3b — `list_positions`

Returns currently open positions across all this agent's bots.

```ts
tool name:  list_positions
args:       {}
returns:    {
  positions: Array<{
    botId, instrumentId, side, size, entryPrice,
    currentMarkPrice, unrealizedPnlUsd, openedAt
  }>
}
```

Implementation:
- Query `positions` table filtered by bot IDs belonging to this agent
- Join with current mark prices (from `OracleMarkSource` or the mark cache in DB)
- If no mark source is available, return positions without unrealized PnL (note in result)

**Note on mark prices:** The worker already resolves mark prices for the engine's
risk gate. Check whether a mark cache/snapshot is available in-process before
adding a new external call.

---

### Phase 4 — Update skills

#### `bot-management` skill update

Remove `submit_decision` from `requiredTools` (it moves to `trading`).
Add: `list_bots`, `get_bot_status`, `stop_bot`, `start_bot`, `adjust_bot_config`,
`get_analytics`.

Updated instructions: describe each new tool with its signature per the
skill-authoring guide format.

#### `risk-monitoring` skill update

Add: `list_positions`, `get_analytics` to `requiredTools`.
Update instructions accordingly.

#### New `trading` skill

```ts
{
  id: 'trading',
  name: 'Trading',
  description: 'Submit direct trade decisions to the engine for the agent\'s bound venue.',
  instructions: `You have access to direct trading tools:
- Use \`submit_decision\` to submit a trade intent (long/short/flat) for a specific instrument.
- Use \`list_positions\` to check open positions before making new decisions.
- Instrument IDs for Hyperliquid perpetuals: "BTC", "SOL", "ETH", "ARB", etc.
...`,
  requiredTools: ['submit_decision', 'list_positions'],
  capabilityFamilies: ['trading'],
  bindingRequirements: { trading: { minBindings: 1, requireReady: true } },
  contextRequirements: ['positions', 'costs'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss'],
  suggestedTickIntervalMs: 300_000, // 5 minutes
  visibility: 'public',
}
```

#### `SKILL_PRESET_MAP` update

```ts
trading: ['bot-management'],   // unchanged — existing preset
direct-trading: ['trading'],   // new preset for direct-submit workflow
```

---

### Phase 5 — `agent-runtime-descriptor.ts` update

The `inferSkillFromRow` function currently checks `requiredTools.includes('decision_submit')`.
Update to `'submit_decision'` and add the new tool names to the heuristic that
determines whether a user-authored skill requires trading context.

---

## Files changed

| File | Change |
|---|---|
| `apps/worker/src/agent.ts` | Rename tool case; add result feedback to all tool cases; add cases for 6 new tools |
| `packages/domain/src/skills.ts` | Update `BOT_MANAGEMENT_SKILL`, `RISK_MONITORING_SKILL`; add `TRADING_SKILL` and `SYSTEM_SKILLS` |
| `packages/db/src/repositories.ts` | Add `stopBot()`, `updateBotConfig()`, `getBotById()`, analytics query helpers |
| `packages/db/src/agent-runtime-descriptor.ts` | Update `decision_submit` → `submit_decision` reference |
| `apps/worker/src/runtime-composition.ts` | Add tool names to trading-context heuristic if needed |
| `apps/worker/src/agents/capability-sandbox.test.ts` | Rename all `decision_submit` literals |
| `apps/worker/src/runtime-composition.test.ts` | Rename all `decision_submit` literals |
| DB seed / migration | If `decision_submit` is stored as a string in the skills table rows, add a migration to rename it |

---

## Testing

- Unit: `executeTool` now appends to history — test that each tool case produces
  the correct history entry.
- Unit: `stop_bot` / `start_bot` validate ownership before updating DB.
- Unit: `get_analytics` returns correct computed fields from mock fill data.
- Integration: end-to-end agent tick that calls `list_bots` and sees the result
  in the next LLM message.
- Regression: existing `decision_submit` capability-sandbox tests renamed and green.

---

## Open questions

1. Does `apps/worker/src/runtime.ts` already implement a mechanism for a running
   BullMQ job to poll `bots.status` and self-terminate? If not, that must be added
   for `stop_bot` to be effective (bot would keep running even after DB status change).
2. Are there any existing DB migrations that insert `decision_submit` as a string
   value (e.g. in seed data for the built-in skills)? If so a data migration is needed.
