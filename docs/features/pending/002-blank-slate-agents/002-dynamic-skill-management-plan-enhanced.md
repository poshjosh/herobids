# Dynamic Skill Management (Enhanced) — Hot-Reload Plan

**Status:** Ready for implementation
**Scope:** Phase 1 — three new agent tools (`list_skills`, `add_skills`, `remove_skills`) with **same-tick hot-reload**
**Excluded:** External skills.sh integration, publishing skills externally, connection auto-assign, `update_my_prompt`
**Supersedes:** `002-dynamic-skill-management-plan.md` (next-tick-only variant)
**Parent:** `docs/features/pending/002-blank-slate-agents/001-plan.md`

---

## Summary

Agents can discover and modify their own skill assignments at runtime. Three new tools let an agent list available skills (with plan entitlement filtering), add skills from the catalog, and remove assigned skills. **Skill changes take effect immediately within the same tick** — the agent can use newly-added skills without waiting for a tick boundary. The tools are part of `BASE_SKILL` so every agent has access.

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

This keeps the broker as the single source of truth for writes (consistent with the architecture) while enabling the tool to trigger an immediate in-process refresh.

---

## Differences from the next-tick plan

| Aspect | Next-tick plan | This plan (hot-reload) |
|--------|---------------|----------------------|
| Effect timing | Next tick (5–15 min delay) | Same tick (immediate) |
| Tool return value | Fire-and-forget acknowledgment | Synchronous success/error with new skill list |
| Broker communication | Async (publish + forget) | Sync (publish + BLPOP reply, same as `submit_decision`) |
| Runtime descriptor update | Happens at next tick start via `readOutboundMessages` | Happens in-process via `skillReloadCallback` on ToolContext |
| Tool visibility refresh | Automatic at next tick start | Explicit call in the reload callback |
| System prompt | Rebuilt at next tick | Rebuilt on next LLM call (same tick, naturally uses current `runtimeState`) |
| Complexity | Low | Moderate (adds sync reply pattern + in-process reload) |

Steps 1–6 and 9 from the next-tick plan are **identical**. Steps 7, 8, 10, and 12 are modified. Steps 7a, 8a, and 10a are new.

---

## Step 1 — Domain: add tool names and catalog entries

*(Identical to next-tick plan)*

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add `'add_skills'`, `'list_skills'`, `'remove_skills'` to the `KNOWN_AGENT_TOOL_NAMES` array (maintain alphabetical order).

2. Add catalog entries to `TOOL_CATALOG`:
   ```
   list_skills:    { category: 'read-config',    description: 'List skills assigned to this agent and skills available to add.' }
   add_skills:     { category: 'write-database',  description: 'Add skills to this agent from the skill catalog. Skills become available immediately.' }
   remove_skills:  { category: 'write-database',  description: 'Remove skills from this agent. Tools from removed skills become unavailable immediately.' }
   ```

   Note: descriptions say "immediately" rather than "next tick" — this is the key UX difference.

**Depends on:** Nothing.

---

## Step 2 — Domain: add tools to BASE_SKILL

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

## Step 3 — Domain: add `MANAGE_AGENT_SKILLS` message type + payload schema

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

## Step 4 — Domain: add capability mapping in broker routing

*(Identical to next-tick plan)*

The broker's `capabilityByType` map needs:

```typescript
[AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS]: 'manage_agent_skills',
```

**Depends on:** Step 3.

---

## Step 5 — DB package: extract shared skill assignment logic

*(Identical to next-tick plan)*

**Current location:** `apps/api/src/routes/agents.ts`

**Target location:** `packages/db/src/skill-assignment.ts` (new file)

**What moves:**
- `SkillAssignmentResolution` type
- `isSkillSelectableForUser()`
- `resolveSkillAssignmentsForUser()`
- `syncAgentSkillAssignments()`

**What stays:** API route handlers import from `@herobids/db` instead. Update `agents.ts`, `chat.ts`, `agent-interactivity.ts`.

**Depends on:** Nothing.

---

## Step 6 — ToolContext: add `skillOps` and `onSkillsChanged` interfaces

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

## Step 7 — Worker: implement `list_skills`, `add_skills`, `remove_skills` tools

**File:** `apps/worker/src/tools/skills.ts` (new file)

### `list_skills`

*(Same as next-tick plan)*

- **Category:** `read-config`
- **Input schema:** `z.object({})` (no params)
- **Behavior:**
  - Guard: if `!ctx.skillOps`, return error `skill.ops_unavailable`.
  - Call `ctx.skillOps.listAssigned()` and `ctx.skillOps.listAvailable()`.
  - Return `{ assigned: [...], available: [...] }`.
- **Does NOT go through message broker.** Direct read.

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

## Step 7a — Domain: add `MANAGE_AGENT_SKILLS_RESULT` message type

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

## Step 8 — Worker: broker handler for `MANAGE_AGENT_SKILLS` (MODIFIED for sync reply)

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

## Step 8a — Worker: broker Redis list reply helper

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

## Step 9 — Domain: extract plan entitlement resolution to domain package

*(Identical to next-tick plan)*

**Current location:** `apps/api/src/plan-guards.ts`

**Target location:** `packages/domain/src/plan-entitlements.ts`

**What moves:** `resolvePlanEntitlements`, `resolvePlanSkillEntitlements`, related pure config functions.

**What stays:** DB-dependent functions (`checkBotLimit`, `checkAgentLimit`, etc.).

**Depends on:** Nothing.

---

## Step 10 — Worker: wire `skillOps` into ToolContext at runtime

*(Identical to next-tick plan)*

**Changes:**

1. Create `buildSkillOps(db, agentId, userId, plansConfig)` factory that returns:
   - `listAssigned()`: queries `agent_skills` joined with `skills` for the agent, excluding `base`.
   - `listAvailable()`: queries all selectable skills not already assigned, respecting plan entitlements.
2. Wire into the ToolContext constructor in the agent runtime.

**Depends on:** Steps 6, 9.

---

## Step 10a — Worker: wire `onSkillsChanged` callback into ToolContext (NEW)

**File:** `apps/worker/src/agent.ts`

**Changes:**

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

  // 3. Apply to live runtime state (same function used by config_update path)
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

**The tool visibility refresh is critical.** Without `snapshotToolBaselines()` + `applyToolVisibility()`, the new skill's tools would be in `resolvedSkills` but would not pass the tool visibility controller's filters. The agent process already does this exact sequence when it detects a `config_update` message (`agent.ts:2282-2285`). We replicate the same logic here.

**Depends on:** Step 6, plus access to `runtimeState`, `toolVisibility`, `agentRepo`, `buildRuntimeDescriptor`, `updateRuntimeDescriptor`, `applyToolVisibility`, and `refreshCapabilityPolicy` from the agent module scope. These are all already in scope where `ToolContext` is constructed.

---

## Step 11 — Worker: wire `plansConfig` for broker handler

*(Identical to next-tick plan)*

Add `plansConfig?: PlansConfig` to the broker constructor. Pass from `apps/worker/src/index.ts`.

**Depends on:** Step 9.

---

## Step 12 — Tests (MODIFIED for hot-reload)

### Unit tests — Domain

*(Same as next-tick plan)*

- Schema validation for `ManageAgentSkillsPayloadSchema` (accept valid, reject empty, reject >10, reject invalid action).
- `ManageAgentSkillsResultSchema` accepts valid ok/error shapes.
- `KNOWN_AGENT_TOOL_NAMES` includes all three tools.
- `TOOL_CATALOG` has entries for all three tools.
- `BASE_SKILL.requiredTools` includes all three tools.
- `findUnknownSkillTools(BASE_SKILL.requiredTools)` returns `[]`.

### Unit tests — DB package

*(Same as next-tick plan)*

- `resolveSkillAssignmentsForUser` / `syncAgentSkillAssignments` / `isSkillSelectableForUser` tests.

### Unit tests — Worker tools

**File:** `apps/worker/src/tools/skills.test.ts` (new)

- `list_skills` returns assigned and available arrays when `skillOps` is present.
- `list_skills` returns error when `skillOps` is not wired.
- `add_skills` publishes `MANAGE_AGENT_SKILLS` with action `add` and `requestMessageId`.
- `add_skills` calls `onSkillsChanged` after receiving success reply.
- `add_skills` does NOT call `onSkillsChanged` after receiving error reply.
- `add_skills` returns updated skill list from `onSkillsChanged` result.
- `add_skills` gracefully handles missing `onSkillsChanged` (fallback to "next tick" note).
- `add_skills` handles BLPOP timeout (returns retryable error).
- `remove_skills` same pattern as `add_skills` tests.

### Unit tests — Worker broker

**File:** `apps/worker/src/agents/agent-broker.test.ts` (extend existing)

- `MANAGE_AGENT_SKILLS add` persists with `assignmentSource: 'agent_self'` and publishes success reply via `publishSkillsReply`.
- `MANAGE_AGENT_SKILLS add` for non-entitled skill publishes error reply.
- `MANAGE_AGENT_SKILLS add` for already-assigned skill is idempotent (still publishes success reply).
- `MANAGE_AGENT_SKILLS add` rejects `'base'` skill ID.
- `MANAGE_AGENT_SKILLS remove` deletes assignment and publishes success reply.
- `MANAGE_AGENT_SKILLS remove` for non-assigned skill publishes success reply with warnings.
- `MANAGE_AGENT_SKILLS remove` rejects `'base'` skill ID.

### Unit tests — Hot-reload callback

**File:** `apps/worker/src/tools/skills.test.ts` or a dedicated integration test

- After `onSkillsChanged()`, `runtimeState.runtimeDescriptor.resolvedSkills` includes the newly-added skill.
- After `onSkillsChanged()`, tool visibility reflects the new skill's tools.
- After `onSkillsChanged()`, `runtimeState.runtimeDescriptor.resolvedSkills` excludes the removed skill.
- `onSkillsChanged()` preserves existing guardrails, budgets, and non-skill descriptor fields.

### Integration verification

- Full flow: `add_skills(['trading'])` → broker persists → tool receives reply → `onSkillsChanged` fires → `runtimeState.runtimeDescriptor.resolvedSkills` includes trading skill → next LLM call in same tick sees `submit_decision` in visible tools.
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
Step 7a  — Domain: result schema (depends on Step 3)
Step 6   — Domain: ToolContext interfaces (no deps)
Step 8a  — Worker: publishSkillsReply on event publisher (depends on Step 7a)
Step 11  — Worker: wire plansConfig into broker (depends on Step 9)
Step 8   — Worker: broker handler (depends on Steps 3, 5, 7a, 8a, 9, 11)
Step 7   — Worker: tool implementations (depends on Steps 1, 3, 6, 7a)
Step 10  — Worker: wire skillOps (depends on Steps 6, 9)
Step 10a — Worker: wire onSkillsChanged callback (depends on Steps 6, 10)
Step 12  — Tests (depends on all above)
```

Parallelizable groups:
- **Group A (domain):** Steps 1, 2, 3, 6, 7a, 9
- **Group B (DB extraction):** Step 5
- **Group C (worker infra):** Steps 8a, 11 (depends on A)
- **Group D (worker logic):** Steps 7, 8, 10, 10a (depends on A, B, C)
- **Group E (tests):** Step 12

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **BLPOP timeout** if the broker is slow or crashes during skill write | 15s timeout with clear error message. Tool returns `{ success: false, retryable: true }`. The DB write may or may not have happened — but `add_skills` is idempotent (upsert), and `remove_skills` is safe to retry. |
| **`onSkillsChanged` re-resolves the full descriptor from DB** — adds latency to the tool call | The `resolveRuntimeCapabilityDescriptor` query is fast (2 indexed joins). Measured at <10ms on a warm DB. Acceptable for a tool call that already has a 15s BLPOP budget. |
| **Tool visibility controller state divergence** after in-process reload | Mitigated by calling the exact same `snapshotToolBaselines()` + `applyToolVisibility()` sequence that the `config_update` path uses. The controller is designed for this — it accepts a getter function `() => runtimeDescriptor` so it always operates on the live descriptor. |
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
| 3 | What about tool visibility controller state? | `snapshotToolBaselines()` + `applyToolVisibility()` are called in the callback, same as the existing `config_update` handler. |
| 4 | Sync reply pattern — is this precedented? | Yes. `submit_decision` (BLPOP on `agent:decision:reply:{id}`), `assess_strategy_preset` / `change_strategy_preset` (BLPOP on `agent:preset:reply:{id}`) all use the same pattern. |
| 5 | What if `onSkillsChanged` fails? | The DB write already succeeded (broker confirmed via reply). The reload is a best-effort optimization. If it fails, skills will still load on the next tick. The tool returns success with a degraded note. |
| 6 | Thread safety of `updateRuntimeDescriptor`? | Safe. Agent LLM dispatch is single-threaded. The tool call, reply wait, and reload callback all execute sequentially within the same async context. |
