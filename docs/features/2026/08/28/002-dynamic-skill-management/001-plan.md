# Dynamic Skill Management (Enhanced) — Hot-Reload Plan

**Status:** Ready for implementation
**Scope:** Phase 1 — three new agent tools (`list_skills`, `add_skills`, `remove_skills`) with **same-tick hot-reload**, including same-tick LLM tool-list refresh
**Excluded:** External skills.sh integration, publishing skills externally, connection auto-assign, `update_my_prompt`
**Parent:** `docs/features/pending/002-blank-slate-agents/001-plan.md`

---

## Summary

Agents can discover and modify their own skill assignments at runtime. Three new tools let an agent list available skills (with plan entitlement filtering), add skills from the catalog, and remove assigned skills. **Skill changes take effect immediately within the same tick** — but only if the runtime refreshes both the live descriptor and the LLM's callable tool definitions after a successful skill change. The tools are part of `BASE_SKILL` so every agent has access.

---

## Why hot-reload matters

Without hot-reload, an agent that needs a new skill to complete a task must:

1. Tick N: Receive "Task A" → realize it needs Skill X → call `add_skills(['skill-x'])` → DB write → tick ends
2. Tick N+1 (5–15 minutes later): Runtime descriptor rebuilt → agent can now execute Task A

This is a poor user experience. The user asks for something, the agent figures out what it needs, then sits idle for a full tick interval.

With hot-reload, the same flow completes in a single tick:

1. Tick N: Receive "Task A" → realize it needs Skill X → call `add_skills(['skill-x'])` → DB write + in-process descriptor update + tool visibility refresh → agent immediately has Skill X tools available → executes Task A

---

## Design constraint: no mid-tick outbound reads

The agent process reads outbound messages **once at tick start** (`readOutboundMessages()` at `agent.ts:2178`), before LLM dispatch. There is no mid-tick read. This means the standard `config_update` outbound message path — where the broker publishes to `agent:outbound:{agentId}` and the agent reads it — cannot deliver a hot-reload during the same tick that initiated the skill change.

**Solution:** The `add_skills`/`remove_skills` tools perform the hot-reload **in-process** after the broker confirms the DB write. The tool:
1. Publishes the inbound message (broker handles DB write)
2. Waits for the broker's synchronous reply (Redis list BLPOP, same pattern as `submit_decision` and `assess_strategy_preset`)
3. On success, calls a `skillReloadCallback` injected via `ToolContext` that re-resolves the runtime descriptor from DB and applies it to the live `runtimeState`
4. Forces the judge loop to refresh its callable tool list before the next LLM turn in the same tick

This keeps the broker as the single source of truth for writes (consistent with the architecture) while enabling the tool to trigger an immediate in-process refresh.

## Design constraint: judge loop tool definitions are currently static

The judge loop currently snapshots its tool definitions once before `runStructuredToolLoop(...)` starts. The loop then reuses that same `tools` array for every turn. Updating `runtimeState.runtimeDescriptor.resolvedSkills` alone is therefore **not sufficient** for same-tick skill adoption: the next LLM turn would still only see the old callable tools.

**Required addition:** this plan must refresh the callable tool list after `onSkillsChanged()`. Two valid implementation options:

1. **Preferred:** extend `runStructuredToolLoop` to accept a per-turn tool-definition getter so each turn uses the latest visible tools.
2. **Acceptable fallback:** treat a successful skill change as a loop-boundary event and restart/re-enter the judge loop with rebuilt tool definitions and the accumulated conversation state.

This plan assumes option 1 unless implementation friction proves too high. If option 2 is chosen, preserve conversation history and tool results so the model does not lose context mid-tick.

---

## Differences from the next-tick plan

| Aspect | Next-tick plan | This plan (hot-reload) |
|--------|---------------|----------------------|
| Effect timing | Next tick (5–15 min delay) | Same tick (immediate) |
| Tool return value | Fire-and-forget acknowledgment | Synchronous success/error with new skill list |
| Broker communication | Async (publish + forget) | Sync (publish + BLPOP reply, same as `submit_decision`) |
| Runtime descriptor update | Happens at next tick start via `readOutboundMessages` | Happens in-process via `skillReloadCallback` on ToolContext |
| Tool visibility refresh | Automatic at next tick start | Explicit call in the reload callback |
| Callable LLM tools | Refreshed next tick | Must be refreshed before the next same-tick LLM turn |
| System prompt | Rebuilt at next tick | Rebuilt on next LLM call (same tick, naturally uses current `runtimeState`) |
| Complexity | Low | Moderate-to-high (adds sync reply pattern + in-process reload + tool-list refresh) |

Steps 1–6 and 9 from the next-tick plan are **identical** except where noted below. Steps 7, 8, 10, and 12 are modified. Steps 4a, 7a, 8a, 10a, and 10b are new.

---

## Step 1 — Domain: add tool names and catalog entries — DONE

*(Identical to next-tick plan)*

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add `'add_skills'`, `'list_skills'`, `'remove_skills'` to the `KNOWN_AGENT_TOOL_NAMES` array (maintain alphabetical order).

2. Add catalog entries to `TOOL_CATALOG`:
  ```
  list_skills:    { category: 'read-database',  description: 'List skills assigned to this agent and skills available to add.' }
  add_skills:     { category: 'write-database', description: 'Add skills to this agent from the skill catalog. Skills become available immediately.' }
  remove_skills:  { category: 'write-database', description: 'Remove skills from this agent. Tools from removed skills become unavailable immediately.' }
  ```

   Note: descriptions say "immediately" rather than "next tick" — this is the key UX difference.

**Depends on:** Nothing.

---

## Step 2 — Domain: add tools to BASE_SKILL — DONE

*(Identical to next-tick plan, with updated instructions text)*

**File:** `packages/domain/src/skills.ts`

**Changes:**

1. Add `'list_skills'`, `'add_skills'`, `'remove_skills'` to `BASE_SKILL.requiredTools`.

2. Append to `BASE_SKILL.instructions`:
   ```
   - Use `list_skills` to discover what skills you have and what skills are available to add.
   - Use `add_skills` to adopt new skills. The skill's tools become available immediately.
   - Use `remove_skills` to drop skills you no longer need.
   ```

**Depends on:** Step 1.

---

## Step 3 — Domain: add `MANAGE_AGENT_SKILLS` message type + payload schema — DONE

*(Identical to next-tick plan)*

**File:** `packages/domain/src/agent-protocol.ts`

**Changes:**

1. Add payload schema:
   ```typescript
   export const ManageAgentSkillsPayloadSchema = z.object({
     action: z.enum(['add', 'remove']),
     skillIds: z.array(z.string().min(1)).min(1).max(10),
   });
   export type ManageAgentSkillsPayload = z.infer<typeof ManageAgentSkillsPayloadSchema>;
   ```

2. Add to `AGENT_MESSAGE_TYPES`:
   ```typescript
   MANAGE_AGENT_SKILLS: 'agent.manage_skills',
   ```

3. Register in `MESSAGE_PAYLOAD_SCHEMAS`:
   ```typescript
   [AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS]: ManageAgentSkillsPayloadSchema,
   ```

**Depends on:** Nothing.

---

## Step 4 — Domain: add capability mapping in broker routing — DONE

*(Identical to next-tick plan)*

The broker's `capabilityByType` map needs:

```typescript
[AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS]: 'manage_agent_skills',
```

**Depends on:** Step 3.

---

## Step 4a — Worker/API: grant `manage_agent_skills` capability explicitly — DONE

The new brokered message type must also be allowed by the capability policy layer. Adding a broker routing entry alone is insufficient.

**Files:**
- `apps/worker/src/agents/capability-policy.ts`
- `apps/api/src/agents/agent-create-normalization.ts`
- Any agent PATCH/update flow that re-derives `toolPolicy` from `skillIds`

**Changes:**

1. Add a default capability grant for `manage_agent_skills` to `DEFAULT_CAPABILITY_GRANTS`:
   ```typescript
   {
     capability: 'manage_agent_skills',
     tier: 'brokered',
     enabled: true,
     limits: { maxPerMinute: 10, maxConcurrent: 1, timeoutMs: 30_000 },
   }
   ```

   Rationale: these tools live on `BASE_SKILL`, so every agent that can invoke base tools must be able to invoke the broker path.

2. Keep this capability out of skill-derived per-agent overrides unless product requirements change later. Unlike `manage_bot`, it should not depend on a non-base skill.

3. Add/update broker tests so a `MANAGE_AGENT_SKILLS` envelope is accepted without extra per-agent policy mutation.

**Depends on:** Steps 3 and 4.

---

## Step 5 — DB package: extract shared skill assignment logic — DONE

*(Identical to next-tick plan)*

**Current location:** `apps/api/src/routes/agents.ts`

**Target location:** `packages/db/src/skill-assignment.ts` (new file)

**What moves:**
- `SkillAssignmentResolution` type
- `isSkillSelectableForUser()`
- `resolveSkillAssignmentsForUser()`
- `syncAgentSkillAssignments()`

**What stays:** API route handlers import from `@herobids/db` instead. Update `agents.ts`, `chat.ts`, `agent-interactivity.ts`.

**Required extraction details:**

1. Widen `assignmentSource` on `syncAgentSkillAssignments()` so the shared helper accepts all currently-used sources, not just the two values from `agents.ts` today.

  Minimum required union for this plan:
  ```typescript
  'user_select' | 'guided_setup' | 'blueprint_instantiate' | 'agent_self'
  ```

  A plain `string` is also acceptable if the project prefers avoiding repeated union drift for audit labels.

2. Re-export the extracted helpers from `packages/db/src/index.ts` so callers can import them from `@herobids/db` without deep imports.

**Depends on:** Nothing.

---

## Step 6 — ToolContext: add `skillOps` and `onSkillsChanged` interfaces — DONE

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add `skillOps` to `ToolContext` (same as next-tick plan):
   ```typescript
   skillOps?: {
     listAssigned(): Promise<Array<{ id: string; name: string; description: string }>>;
     listAvailable(): Promise<Array<{ id: string; name: string; description: string }>>;
   };
   ```

2. **NEW:** Add `onSkillsChanged` callback to `ToolContext`:
   ```typescript
   /**
    * Called by add_skills/remove_skills after the broker confirms the DB write.
    * Re-resolves the runtime descriptor from DB and applies it to the live
    * runtime state, refreshing tool visibility and the system prompt.
    * Returns the updated list of assigned skill IDs (excluding base).
    */
   onSkillsChanged?: () => Promise<string[]>;
   ```

   This is the mechanism for in-process hot-reload. The callback is implemented in the agent process (Step 10a) where it has access to `runtimeState`, `toolVisibility`, and the DB.

**Depends on:** Nothing.

---

## Step 7 — Worker: implement `list_skills`, `add_skills`, `remove_skills` tools — DONE

**File:** `apps/worker/src/tools/skills.ts` (new file)

### `list_skills`

*(Same as next-tick plan)*

- **Category:** `read-database`
- **Input schema:** `z.object({})` (no params)
- **Behavior:**
  - Guard: if `!ctx.skillOps`, return error `skill.ops_unavailable`.
  - Call `ctx.skillOps.listAssigned()` and `ctx.skillOps.listAvailable()`.
  - Return `{ assigned: [...], available: [...] }`.
- **Does NOT go through message broker.** Direct read.

### Runtime degradation wiring

These tools are DB-backed and must participate in the runtime degradation system.

- Add `list_skills`, `add_skills`, and `remove_skills` to the worker's database-dependent tool set so they are hidden/blocked consistently when DB-backed tools are degraded.
- Because `list_skills` is DB-backed, do **not** classify it as `read-config`.
- Add/adjust tests so a database degradation excludes these tools from the visible tool set the same way it excludes other DB-backed tools.

### `add_skills` (MODIFIED for hot-reload)

- **Category:** `write-database`
- **Input schema:**
  ```typescript
  z.object({
    skillIds: z.array(z.string().min(1)).min(1).max(10),
  })
  ```
- **Behavior:**
  1. Validate params.
  2. Publish `MANAGE_AGENT_SKILLS` inbound message with `{ action: 'add', skillIds }` and a `requestMessageId`.
  3. BLPOP on `agent:skills:reply:{requestMessageId}` with a 15s timeout (same pattern as `submit_decision` and `assess_strategy_preset`).
  4. If reply indicates error → return the error to the agent.
  5. If reply indicates success → call `ctx.onSkillsChanged()` to trigger in-process hot-reload.
  6. Return `{ success: true, added: [...skillIds], activeSkills: <updated list from onSkillsChanged> }`.
  7. If `onSkillsChanged` is not wired (fallback) → return success with a note that changes take effect next tick.

### `remove_skills` (MODIFIED for hot-reload)

- **Category:** `write-database`
- **Input schema:**
  ```typescript
  z.object({
    skillIds: z.array(z.string().min(1)).min(1).max(10),
  })
  ```
- **Behavior:**
  1. Validate params.
  2. Publish `MANAGE_AGENT_SKILLS` inbound message with `{ action: 'remove', skillIds }` and a `requestMessageId`.
  3. BLPOP on `agent:skills:reply:{requestMessageId}` with a 15s timeout.
  4. If reply indicates error → return the error to the agent.
  5. If reply indicates success → call `ctx.onSkillsChanged()` to trigger in-process hot-reload.
  6. Return `{ success: true, removed: [...skillIds], activeSkills: <updated list from onSkillsChanged> }`.
  7. If `onSkillsChanged` is not wired (fallback) → return success with a note that changes take effect next tick.

### Registration

**File:** `apps/worker/src/tools/index.ts`

- Import `skillTools` from `./skills.js`.
- Add to the `allTools` array in `createToolRegistry()`.

**Depends on:** Steps 1, 3, 6.

---

## Step 7a — Domain: add `MANAGE_AGENT_SKILLS_RESULT` message type — DONE

**File:** `packages/domain/src/agent-protocol.ts`

**Changes:**

Add the result type that the broker publishes via Redis list reply:

```typescript
export const ManageAgentSkillsResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  action: z.enum(['add', 'remove']),
  /** Skill IDs that were successfully added/removed */
  skillIds: z.array(z.string()).default([]),
  /** Skill IDs that were requested but not found / not assigned (non-fatal for remove) */
  warnings: z.array(z.string()).default([]),
  /** Error details when status is 'error' */
  error: z.string().optional(),
  errorCode: z.string().optional(),
});
export type ManageAgentSkillsResult = z.infer<typeof ManageAgentSkillsResultSchema>;
```

No need to add this to `INSTANCE_MESSAGE_TYPES` — the reply goes via a Redis list (keyed by `requestMessageId`), not the outbound stream. This is the same pattern used by `publishDecisionReply` and `publishPresetToolReply`.

**Depends on:** Step 3.

---

## Step 8 — Worker: broker handler for `MANAGE_AGENT_SKILLS` (MODIFIED for sync reply) — DONE

**File:** `apps/worker/src/agents/agent-message-broker.ts`

**Changes:**

Steps 1–5 are identical to the next-tick plan (imports, capability map entry, switch case routing).

Step 6 — `handleManageAgentSkills(agentId, envelope, payload)`:

**For `action: 'add'`:**
1. Load agent to get `userId`.
2. Load user's `planId` and `isAdmin`.
3. Resolve plan skill entitlements via the domain function.
4. Get currently assigned skillIds.
5. Call `resolveSkillAssignmentsForUser(db, userId, [...existing, ...payload.skillIds], new Set(existing), canViewMarketplaceSkills)`.
6. If validation error → **publish error reply to Redis list** (see Step 8a).
7. If success → `syncAgentSkillAssignments(db, agentId, userId, assignments, 'agent_self')`.
8. **Publish success reply to Redis list** with the list of added skillIds.

**For `action: 'remove'`:**
1. Load current agent skill assignments.
2. Validate requested skillIds are currently assigned. Collect any not-assigned IDs as warnings.
3. Filter out the requested skillIds, call `syncAgentSkillAssignments` with remaining.
4. **Publish success reply to Redis list** with removed skillIds + warnings for any not-assigned.

**Base skill protection:** Reject if `'base'` is in `payload.skillIds`.

**Depends on:** Steps 3, 5, 7a, 8a, 9, 11.

---

## Step 8a — Worker: broker Redis list reply helper — DONE

**File:** `apps/worker/src/agents/instance-event-publisher.ts`

**Changes:**

Add a new method to `InstanceEventPublisher`:

```typescript
/**
 * Publish a skill management reply to a Redis list so the agent's
 * add_skills/remove_skills tool can BLPOP it for synchronous feedback.
 */
async publishSkillsReply(
  requestMessageId: string,
  result: ManageAgentSkillsResult,
): Promise<void> {
  const replyKey = `agent:skills:reply:${requestMessageId}`;
  await this.redis.lpush(replyKey, JSON.stringify(result));
  await this.redis.expire(replyKey, 60);
}
```

This follows the exact pattern of `publishDecisionReply` and `publishPresetToolReply`.

**Depends on:** Step 7a (for the `ManageAgentSkillsResult` type).

---

## Step 9 — Domain: extract plan entitlement resolution to domain package — DONE

*(Identical to next-tick plan)*

**Current location:** `apps/api/src/plan-guards.ts`

**Target location:** `packages/domain/src/plan-entitlements.ts`

**What moves:** `resolvePlanEntitlements`, `resolvePlanSkillEntitlements`, related pure config functions.

**What stays:** DB-dependent functions (`checkBotLimit`, `checkAgentLimit`, etc.).

**Required extraction details:**

1. Re-export the new module from `packages/domain/src/index.ts` so worker and API code can import from `@herobids/domain` without deep imports.
2. Keep any DB-calling plan checks in `apps/api/src/plan-guards.ts`; only the pure entitlement resolution functions move.

**Depends on:** Nothing.

---

## Step 10 — Worker: wire `skillOps` into ToolContext at runtime — DONE

*(Identical to next-tick plan)*

**Changes:**

1. Create `buildSkillOps(db, agentId, userId, plansConfig)` factory that returns:
   - `listAssigned()`: queries `agent_skills` joined with `skills` for the agent, excluding `base`.
   - `listAvailable()`: queries all selectable skills not already assigned, respecting plan entitlements.
2. Wire into the ToolContext constructor in the agent runtime.

**Depends on:** Steps 6, 9.

---

## Step 10a — Worker: wire `onSkillsChanged` callback into ToolContext (NEW) — DONE

**File:** `apps/worker/src/agent.ts`

**Changes:**

Before wiring the callback, add the missing imports/wiring explicitly:

1. Import `buildRuntimeDescriptor` from `@herobids/db`.
2. Import `updateRuntimeDescriptor` from `./runtime-composition.js`.
3. Reuse the existing module-level `agentRepo` instance for `getRuntimeCapabilityDescriptor(...)`; no `ToolContext` shape change is required for that lookup.

Wire the `onSkillsChanged` callback where `ToolContext` is constructed. The callback:

```typescript
onSkillsChanged: async () => {
  // 1. Re-resolve the capability descriptor from DB (same as session start)
  const capabilityDescriptor = await agentRepo.getRuntimeCapabilityDescriptor(AGENT_ID!);

  // 2. Build a fresh runtime descriptor with the new skills
  const freshDescriptor = buildRuntimeDescriptor({
    agentId: AGENT_ID!,
    name: runtimeState.runtimeDescriptor.name,
    goal: runtimeState.runtimeDescriptor.goal,
    executionMode: runtimeState.runtimeDescriptor.executionMode,
    authorizationMode: runtimeState.runtimeDescriptor.authorizationMode,
    toolPolicy: runtimeState.runtimeDescriptor.toolPolicy,
    budgets: runtimeState.runtimeDescriptor.budgets,
    capabilityDescriptor,
    // ... carry forward existing guardrail values from current descriptor
  });

  // 3. Apply the full replacement descriptor to live runtime state
  updateRuntimeDescriptor(runtimeState, freshDescriptor);

  // 4. Refresh tool visibility baselines so new tools are visible
  //    and removed tools are hidden
  toolVisibility.snapshotToolBaselines();
  applyToolVisibility();

  // 5. Refresh capability policy grants (tool policy may reference new tools)
  refreshCapabilityPolicy();

  // 6. Return the updated skill list for the tool's response
  return freshDescriptor.resolvedSkills
    .filter(s => s.id !== 'base')
    .map(s => s.id);
},
```

**Why this works:** The system prompt is built lazily — `composeSystemPrompt(runtimeState, ...)` reads from `runtimeState.runtimeDescriptor.resolvedSkills` at call time. After `updateRuntimeDescriptor` replaces it, the next LLM call within the same tick automatically sees the updated skills. No explicit prompt rebuild needed.

**The fresh descriptor must be complete, not partial.** This callback is effectively synthesizing the same kind of full `RuntimeDescriptor` payload that the outbound `agent.runtime.config_update` path carries. Re-resolving from DB is therefore required; a partial patch is not sufficient.

**The tool visibility refresh is critical.** Without `snapshotToolBaselines()` + `applyToolVisibility()`, the new skill's tools would be in `resolvedSkills` but would not pass the tool visibility controller's filters. The existing `config_update` flow reaches the same end state in two steps: the descriptor update is applied through `applyRuntimeMessage(...)`, and the later `agent.runtime.config_update` check triggers `snapshotToolBaselines()` + `applyToolVisibility()`. This callback should mirror that combined effect; it is not literally reusing the same call site.

**Important:** this callback alone does **not** make newly-added tools callable in the current judge loop. It updates runtime state and visibility, but the LLM tool-definition list must also be refreshed per Step 10b.

**Depends on:** Step 6, plus access to `runtimeState`, `toolVisibility`, `agentRepo`, `applyToolVisibility`, and `refreshCapabilityPolicy` from the agent module scope, and the new import wiring for `buildRuntimeDescriptor` and `updateRuntimeDescriptor` described above.

---

## Step 10b — Worker: refresh callable tool definitions in the judge loop (NEW) — DONE

**Files:**
- `apps/worker/src/structured-tool-loop.ts`
- `apps/worker/src/agent.ts`

**Problem:** `runStructuredToolLoop(...)` currently receives a static `tools` array before the loop starts. Even after `onSkillsChanged()` updates `runtimeState`, subsequent turns in that same loop keep using the original tool definitions.

**Required change:** refresh tool definitions after a skill change so the next same-tick judge turn can call newly-added tools.

### Preferred approach — per-turn tool getter

1. Extend `StructuredToolLoopOptions` with something like:
  ```typescript
  getTools?: () => LlmToolDefinition[];
  ```
2. At each loop turn, resolve:
  ```typescript
  const activeTools = options.getTools ? options.getTools() : options.tools;
  ```
3. Pass `activeTools` into `callLlmWithRetry(...)` instead of the original static array.
4. In `agent.ts`, wire `getTools` to rebuild definitions from `toolRegistry.getDefinitions([...allowedTools()])` so it sees the updated visible tool set after `onSkillsChanged()` runs.

### Acceptable fallback — loop restart

If the per-turn getter is too invasive, allow `add_skills` / `remove_skills` to signal that the current judge loop should terminate and be re-entered immediately with rebuilt tool definitions and preserved message history.

### Acceptance condition

After `add_skills(['trading'])` succeeds inside a judge loop, the **very next judge LLM turn in the same tick** must receive `submit_decision` in its tool definitions.

**Depends on:** Step 10a.

---

## Step 11 — Worker: wire `plansConfig` for broker handler — DONE

*(Identical to next-tick plan)*

Add `plansConfig?: PlansConfig` to the broker constructor. Pass from `apps/worker/src/index.ts`.

**Depends on:** Step 9.

---

## Step 12 — Tests (MODIFIED for hot-reload) — DONE

### Unit tests — Domain

*(Same as next-tick plan)*

- Schema validation for `ManageAgentSkillsPayloadSchema` (accept valid, reject empty, reject >10, reject invalid action).
- `ManageAgentSkillsResultSchema` accepts valid ok/error shapes.
- `KNOWN_AGENT_TOOL_NAMES` includes all three tools.
- `TOOL_CATALOG` has entries for all three tools.
- `BASE_SKILL.requiredTools` includes all three tools.
- `findUnknownSkillTools(BASE_SKILL.requiredTools)` returns `[]`.
- `plan-entitlements.ts` exports are re-exported from `packages/domain/src/index.ts`.

### Unit tests — DB package

*(Same as next-tick plan)*

- `resolveSkillAssignmentsForUser` / `syncAgentSkillAssignments` / `isSkillSelectableForUser` tests.
- `syncAgentSkillAssignments` accepts `agent_self` and `blueprint_instantiate` assignment sources.
- Extracted helpers are re-exported from `packages/db/src/index.ts`.

### Unit tests — Worker tools

**File:** `apps/worker/src/tools/skills.test.ts` (new)

- `list_skills` returns assigned and available arrays when `skillOps` is present.
- `list_skills` returns error when `skillOps` is not wired.
- `list_skills` is registered as `read-database`.
- `add_skills` publishes `MANAGE_AGENT_SKILLS` with action `add` and `requestMessageId`.
- `add_skills` calls `onSkillsChanged` after receiving success reply.
- `add_skills` does NOT call `onSkillsChanged` after receiving error reply.
- `add_skills` returns updated skill list from `onSkillsChanged` result.
- `add_skills` gracefully handles missing `onSkillsChanged` (fallback to "next tick" note).
- `add_skills` handles BLPOP timeout (returns retryable error).
- `remove_skills` same pattern as `add_skills` tests.
- DB degradation hides `list_skills`, `add_skills`, and `remove_skills` from the visible tool set.

### Unit tests — Worker broker

**File:** `apps/worker/src/agents/agent-broker.test.ts` (extend existing)

- `MANAGE_AGENT_SKILLS add` persists with `assignmentSource: 'agent_self'` and publishes success reply via `publishSkillsReply`.
- `MANAGE_AGENT_SKILLS add` for non-entitled skill publishes error reply.
- `MANAGE_AGENT_SKILLS add` for already-assigned skill is idempotent (still publishes success reply).
- `MANAGE_AGENT_SKILLS add` rejects `'base'` skill ID.
- `MANAGE_AGENT_SKILLS remove` deletes assignment and publishes success reply.
- `MANAGE_AGENT_SKILLS remove` for non-assigned skill publishes success reply with warnings.
- `MANAGE_AGENT_SKILLS remove` rejects `'base'` skill ID.
- `MANAGE_AGENT_SKILLS` is accepted by capability policy without requiring a per-agent custom override.

### Unit tests — Hot-reload callback

**File:** `apps/worker/src/tools/skills.test.ts` or a dedicated integration test

- After `onSkillsChanged()`, `runtimeState.runtimeDescriptor.resolvedSkills` includes the newly-added skill.
- After `onSkillsChanged()`, tool visibility reflects the new skill's tools.
- After `onSkillsChanged()`, `runtimeState.runtimeDescriptor.resolvedSkills` excludes the removed skill.
- `onSkillsChanged()` preserves existing guardrails, budgets, and non-skill descriptor fields.

### Unit tests — Judge loop tool refresh

- The structured tool loop uses refreshed tool definitions on the turn after a successful skill change.
- After `onSkillsChanged()`, the next same-tick judge turn receives newly visible tools in its LLM request.
- If the fallback loop-restart implementation is chosen, preserved message history survives the restart boundary.

### Integration verification

- Full flow: `add_skills(['trading'])` → broker persists → tool receives reply → `onSkillsChanged` fires → `runtimeState.runtimeDescriptor.resolvedSkills` includes trading skill → judge loop refreshes callable tool definitions → next LLM call in same tick sees `submit_decision` in visible tools.
- Full flow: `remove_skills(['trading'])` → broker persists → tool receives reply → `onSkillsChanged` fires → trading tools no longer visible.
- Existing API skill assignment flow continues to work after extraction.
- Existing `config_update` path (connection changes) still works correctly after the new callback is added.

---

## Implementation Order

```
Step 9   — Extract plan entitlements to domain (no deps)
Step 5   — Extract skill assignment logic to DB package (no deps)
Step 1   — Domain: tool names + catalog (no deps)
Step 2   — Domain: BASE_SKILL.requiredTools (depends on Step 1)
Step 3   — Domain: message type + payload schema (no deps)
Step 4a  — Worker/API: capability grant wiring (depends on Steps 3, 4)
Step 7a  — Domain: result schema (depends on Step 3)
Step 6   — Domain: ToolContext interfaces (no deps)
Step 8a  — Worker: publishSkillsReply on event publisher (depends on Step 7a)
Step 11  — Worker: wire plansConfig into broker (depends on Step 9)
Step 8   — Worker: broker handler (depends on Steps 3, 5, 7a, 8a, 9, 11)
Step 7   — Worker: tool implementations (depends on Steps 1, 3, 6, 7a)
Step 10  — Worker: wire skillOps (depends on Steps 6, 9)
Step 10a — Worker: wire onSkillsChanged callback (depends on Steps 6, 10)
Step 10b — Worker: refresh judge-loop tool definitions (depends on Step 10a)
Step 12  — Tests (depends on all above)
```

Parallelizable groups:
- **Group A (domain):** Steps 1, 2, 3, 6, 7a, 9
- **Group B (DB extraction):** Step 5
- **Group C (worker infra):** Steps 4a, 8a, 11 (depends on A)
- **Group D (worker logic):** Steps 7, 8, 10, 10a, 10b (depends on A, B, C)
- **Group E (tests):** Step 12

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **BLPOP timeout** if the broker is slow or crashes during skill write | 15s timeout with clear error message. Tool returns `{ success: false, retryable: true }`. The DB write may or may not have happened — but `add_skills` is idempotent (upsert), and `remove_skills` is safe to retry. |
| **`onSkillsChanged` re-resolves the full descriptor from DB** — adds latency to the tool call | The `resolveRuntimeCapabilityDescriptor` query is fast (2 indexed joins). Measured at <10ms on a warm DB. Acceptable for a tool call that already has a 15s BLPOP budget. |
| **Callable tool list remains stale within the active judge loop** | Mitigated by Step 10b: either recompute LLM tool definitions per turn or restart the judge loop immediately after a successful skill change. Updating `runtimeState` alone is not sufficient. |
| **Tool visibility controller state divergence** after in-process reload | Mitigated by calling the exact same `snapshotToolBaselines()` + `applyToolVisibility()` sequence that the `config_update` path uses. The controller is designed for this — it accepts a getter function `() => runtimeDescriptor` so it always operates on the live descriptor. |
| **Capability policy denies the new brokered message type** | Mitigated by Step 4a: add a default `manage_agent_skills` grant so base-skill agents can invoke the broker path without per-agent overrides. |
| **Extraction introduces import or audit-label drift** | Mitigated by explicitly re-exporting the extracted modules and widening `assignmentSource` to include `agent_self` and existing labels like `blueprint_instantiate`. |
| **Race condition: agent calls `add_skills` twice concurrently** | Not possible in the current architecture — the agent's LLM dispatch is single-threaded. Tool calls within a tick are sequential. |
| **System prompt is not explicitly rebuilt after reload** | By design. `buildSystemPrompt()` reads from `runtimeState.runtimeDescriptor` at call time. After `updateRuntimeDescriptor()` replaces it, the next LLM call naturally sees the updated skills. No explicit rebuild needed — this is how the existing `config_update` path works. |
| **Positional mock drift in API tests** after function extraction | Same mitigation as next-tick plan: query order unchanged, verify with `pnpm test --filter @herobids/api`. |
| **Broker constructor parameter growth** | Same as next-tick plan. Acceptable. |

---

## Open Questions (all resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | How does hot-reload work if `readOutboundMessages` runs once at tick start? | The tool triggers reload in-process via `onSkillsChanged` callback. No outbound message needed for same-tick effect. |
| 2 | Does the system prompt need explicit rebuild after reload? | No. `buildSystemPrompt()` reads from `runtimeState.runtimeDescriptor` at call time. The next LLM call in the same tick sees the updated descriptor. |
| 3 | Is runtime descriptor refresh alone enough for same-tick tool adoption? | No. The judge loop must also refresh its callable tool definitions per Step 10b. |
| 4 | What about tool visibility controller state? | `snapshotToolBaselines()` + `applyToolVisibility()` are called in the callback, same as the existing `config_update` handler. |
| 5 | Sync reply pattern — is this precedented? | Yes. `submit_decision` (BLPOP on `agent:decision:reply:{id}`), `assess_strategy_preset` / `change_strategy_preset` (BLPOP on `agent:preset:reply:{id}`) all use the same pattern. |
| 6 | How is the new brokered message type allowed through capability policy? | By adding a default `manage_agent_skills` grant in Step 4a rather than relying on skill-derived overrides. |
| 7 | What if `onSkillsChanged` fails? | The DB write already succeeded (broker confirmed via reply). The reload is a best-effort optimization. If it fails, skills will still load on the next tick. The tool returns success with a degraded note. |
| 8 | Thread safety of `updateRuntimeDescriptor`? | Safe. Agent LLM dispatch is single-threaded. The tool call, reply wait, and reload callback all execute sequentially within the same async context. |
