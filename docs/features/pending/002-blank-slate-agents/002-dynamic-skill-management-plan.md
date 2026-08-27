# Dynamic Skill Management — Implementation Plan

**Status:** Ready for implementation
**Scope:** Phase 1 only — three new agent tools: `list_skills`, `add_skills`, `remove_skills`
**Excluded:** External skills.sh, publishing, connection auto-assign, `update_my_prompt`
**Parent:** `docs/features/pending/002-blank-slate-agents/001-plan.md`

---

## Summary

Agents can discover and modify their own skill assignments at runtime. Three new tools let an agent list available skills (with plan entitlement filtering), add skills from the catalog, and remove assigned skills. Changes take effect on the next tick (no mid-tick hot-reload). The tools are part of `BASE_SKILL` so every agent has access.

---

## Step 1 — Domain: add tool names and catalog entries

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add `'add_skills'`, `'list_skills'`, `'remove_skills'` to the `KNOWN_AGENT_TOOL_NAMES` array (maintain alphabetical order).

2. Add catalog entries to `TOOL_CATALOG`:
   ```
   list_skills:    { category: 'read-config',    description: 'List assigned and available skills. Available skills are filtered by plan entitlements.' }
   add_skills:     { category: 'write-database',  description: 'Add skills to this agent from the skill catalog. Changes take effect next tick.' }
   remove_skills:  { category: 'write-database',  description: 'Remove skills from this agent. Changes take effect next tick.' }
   ```

**Depends on:** Nothing.

---

## Step 2 — Domain: add tools to BASE_SKILL.requiredTools

**File:** `packages/domain/src/skills.ts`

**Changes:**

1. Add `'list_skills'`, `'add_skills'`, `'remove_skills'` to `BASE_SKILL.requiredTools`.

2. Update `BASE_SKILL.instructions` to include usage guidance for the three new tools:
   - `list_skills` to discover skills you can adopt.
   - `add_skills` to adopt new skills (effective next tick).
   - `remove_skills` to drop skills you no longer need (effective next tick).

**Depends on:** Step 1 (tool names must exist in `KNOWN_AGENT_TOOL_NAMES`).

---

## Step 3 — Domain: add `MANAGE_AGENT_SKILLS` message type + payload schema

**File:** `packages/domain/src/agent-protocol.ts`

**Changes:**

1. Add a new payload schema:
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

**Design note:** `list` is not an action here — `list_skills` is a direct DB read in the tool, not brokered. Only `add` and `remove` go through the message broker (write operations).

**Depends on:** Nothing.

---

## Step 4 — Domain: add capability mapping in broker routing

The broker's `capabilityByType` map (in `processInbound`) needs the new message type so the capability policy engine can enforce grants:

```typescript
[AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS]: 'manage_agent_skills',
```

This will be implemented as part of the broker handler in Step 7, but the capability name `manage_agent_skills` is documented here for awareness.

**Depends on:** Step 3.

---

## Step 5 — DB package: extract shared skill assignment logic

**Current location:** `apps/api/src/routes/agents.ts` — functions `resolveSkillAssignmentsForUser`, `syncAgentSkillAssignments`, `isSkillSelectableForUser`, and the `SkillAssignmentResolution` type.

**Target location:** `packages/db/src/skill-assignment.ts` (new file)

**Changes:**

1. Create `packages/db/src/skill-assignment.ts` with:
   - `SkillAssignmentResolution` type: `{ skillId: string; skillRevisionId: string }`
   - `isSkillSelectableForUser(input)` — pure function, takes `{ skill, userId, entitledSkillIds, preservedSkillIds, canViewMarketplaceSkills }`
   - `resolveSkillAssignmentsForUser(db, userId, skillIds, preservedSkillIds, canViewMarketplaceSkills)` — validates existence, selectability, resolves revisions
   - `syncAgentSkillAssignments(db, agentId, userId, assignments, assignmentSource)` — transactional DB write with upsert + usage event tracking

   The `assignmentSource` parameter type broadens from `'user_select' | 'guided_setup'` to `string` (the DB column is `text`, already freeform). Callers pass the appropriate value: `'user_select'`, `'guided_setup'`, or `'agent_self'`.

2. Export from `packages/db/src/index.ts`:
   ```typescript
   export { resolveSkillAssignmentsForUser, syncAgentSkillAssignments, isSkillSelectableForUser } from './skill-assignment.js';
   export type { SkillAssignmentResolution } from './skill-assignment.js';
   ```

3. Update `apps/api/src/routes/agents.ts`:
   - Remove the extracted functions and type.
   - Import them from `@herobids/db`.
   - Re-export if needed for `chat.ts` and `agent-interactivity.ts` (or update those imports too).

4. Update `apps/api/src/routes/chat.ts`:
   - Change import from `./agents.js` to `@herobids/db`.

5. Update `apps/api/src/routes/agent-interactivity.ts`:
   - This file has its own duplicated versions of `resolveSkillAssignmentsForUser` and `syncAgentSkillAssignments` (local closures). Replace with imports from `@herobids/db`.
   - Note: The `agent-interactivity.ts` versions are closures that capture `db` from the outer scope. The extracted functions take `db` as an explicit parameter, so this is a straightforward conversion.

**Why `packages/db` and not `packages/domain`:** The functions depend on Drizzle ORM, table schemas (`skills`, `skillRevisions`, `skillEntitlements`, `agentSkills`, `skillUsageEvents`), and database types. These are DB-layer concerns. Both `apps/api` and `apps/worker` can import from `@herobids/db` per the dependency direction: `domain` <- `engine` <- `db` <- `apps/*`.

**Depends on:** Nothing (can be done in parallel with Steps 1-3).

---

## Step 6 — ToolContext: add `skillOps` interface

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add an optional `skillOps` field to `ToolContext`:
   ```typescript
   /** Skill catalog operations for list/add/remove skill tools. */
   skillOps?: {
     /** List assigned skills for this agent (excluding base). */
     listAssigned(): Promise<Array<{ id: string; name: string; description: string }>>;
     /** List skills available (selectable but not yet assigned, excluding base). Respects plan entitlements. */
     listAvailable(): Promise<Array<{ id: string; name: string; description: string }>>;
   };
   ```

   `list_skills` uses this interface for direct reads. `add_skills`/`remove_skills` use `ctx.publishToInbound` for writes.

**Why a dedicated interface instead of raw `ctx.db`:** Follows the established pattern (`ctx.botRepo`, `ctx.agentRepo`, `ctx.riskContractOps`). Keeps tool implementations decoupled from DB schema imports. The implementation is wired in the worker runtime.

**Depends on:** Nothing.

---

## Step 7 — Worker: implement `list_skills`, `add_skills`, `remove_skills` tools

**File:** `apps/worker/src/tools/skills.ts` (new file)

### `list_skills`

- **Category:** `read-config`
- **Input schema:** `z.object({})` (no params)
- **Behavior:**
  - Guard: if `!ctx.skillOps`, return error `skill.ops_unavailable`.
  - Call `ctx.skillOps.listAssigned()` and `ctx.skillOps.listAvailable()`.
  - Return `{ assigned: [...], available: [...] }`.
- **Does NOT go through message broker.** Direct read.

### `add_skills`

- **Category:** `write-database`
- **Input schema:**
  ```typescript
  z.object({
    skillIds: z.array(z.string().min(1)).min(1).max(10),
  })
  ```
- **Behavior:**
  - Validate params.
  - Guard: verify skillIds are non-empty.
  - Publish `MANAGE_AGENT_SKILLS` inbound message via `ctx.publishToInbound` with `{ action: 'add', skillIds }`.
  - Return `{ ok: true, note: 'Skills will be added. Changes take effect next tick.', skillIds }`.
- **The broker handler performs the actual validation and DB write (step 8).**

### `remove_skills`

- **Category:** `write-database`
- **Input schema:**
  ```typescript
  z.object({
    skillIds: z.array(z.string().min(1)).min(1).max(10),
  })
  ```
- **Behavior:**
  - Validate params.
  - Guard: verify skillIds are non-empty.
  - Publish `MANAGE_AGENT_SKILLS` inbound message via `ctx.publishToInbound` with `{ action: 'remove', skillIds }`.
  - Return `{ ok: true, note: 'Skills will be removed. Changes take effect next tick.', skillIds }`.

### Registration

**File:** `apps/worker/src/tools/index.ts`

- Import `skillTools` from `./skills.js`.
- Add `...skillTools` to the `allTools` array in `createToolRegistry()`.

**Depends on:** Steps 1, 3, 6.

---

## Step 8 — Worker: broker handler for `MANAGE_AGENT_SKILLS`

**File:** `apps/worker/src/agents/agent-message-broker.ts`

**Changes:**

1. Import `ManageAgentSkillsPayload` from `@herobids/domain`.
2. Import `resolveSkillAssignmentsForUser`, `syncAgentSkillAssignments` from `@herobids/db`.
3. Import `resolvePlanSkillEntitlements` from plan-guards (or inline the logic). **Decision:** Since `resolvePlanSkillEntitlements` lives in `apps/api/src/plan-guards.ts` and depends only on `@herobids/domain` types (`PlansConfig`), we have two options:
   - **Option A (recommended):** Move `resolvePlanSkillEntitlements` to `packages/domain/src/plans.ts` (it's a pure function over config, no DB). Then both API and worker import from domain.
   - **Option B:** Duplicate the simple one-liner in the worker. It's `return resolvePlanEntitlements(config, { planId, isAdmin }).entitlements.skills;` where `resolvePlanEntitlements` is also a pure config lookup.

   **Go with Option A** — extract `resolvePlanEntitlements` and `resolvePlanSkillEntitlements` into domain. They are pure config resolution functions with no DB dependency.

4. Add `MANAGE_AGENT_SKILLS` to the `capabilityByType` map:
   ```typescript
   [AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS]: 'manage_agent_skills',
   ```

5. Add to the switch in `processInbound`:
   ```typescript
   case AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS:
     await this.handleManageAgentSkills(
       effectiveAgentId,
       envelope,
       envelope.payload as unknown as ManageAgentSkillsPayload,
     );
     break;
   ```

6. Implement `handleManageAgentSkills(agentId, envelope, payload)`:

   **For `action: 'add'`:**
   - Load agent via `this.agentRepo.getAgent(agentId)` to get `userId`.
   - Load user's `planId` and `isAdmin` from DB (same pattern as `botLimitCheck` callback, or via a new simple query).
   - Resolve plan skill entitlements via the extracted domain function.
   - Get currently assigned skillIds for the agent.
   - Call `resolveSkillAssignmentsForUser(db, userId, [...existingSkillIds, ...payload.skillIds], new Set(existingSkillIds), canViewMarketplaceSkills)`.
   - If error → emit tool result with error to outbound.
   - If success → call `syncAgentSkillAssignments(db, agentId, userId, assignments, 'agent_self')`.
   - Emit tool result success to outbound.

   **For `action: 'remove'`:**
   - Load current agent skill assignments.
   - Filter out the requested skillIds.
   - Call `syncAgentSkillAssignments(db, agentId, userId, remainingAssignments, 'agent_self')`.
   - If a requested skillId is not currently assigned, include it in a `notAssigned` list in the response (non-fatal warning, not an error).
   - Emit tool result success to outbound.

   **Base skill protection:** Both actions should reject if `'base'` is in `payload.skillIds` (base is auto-injected, never stored in DB).

   **DB access:** The broker already receives a `db?: Database` in its constructor. Use this for skill queries.

**Depends on:** Steps 3, 5, and the plan entitlements extraction (substep of this step or Step 5).

---

## Step 9 — Domain: extract plan entitlement resolution to domain package

**Current location:** `apps/api/src/plan-guards.ts` — `resolvePlanEntitlements`, `resolvePlanSkillEntitlements`

**Target location:** `packages/domain/src/plan-entitlements.ts` (new file)

**What moves:**
- `ResolvedPlanEntitlements` interface
- `ABSOLUTE_FALLBACK_ENTITLEMENTS` constant
- `resolvePlanDefinition` helper
- `resolvePlanEntitlements` function
- `resolvePlanSkillEntitlements` function
- `resolvePlanAgentEntitlements`, `resolvePlanLimitEntitlements`, `resolvePlanBlueprintEntitlements`

**What stays in `apps/api/src/plan-guards.ts`:**
- All functions that take `db` as a parameter (`checkBotLimit`, `checkAgentLimit`, `checkVenueAccountLimit`, etc.) — these are DB-dependent and belong in the API layer.
- The `plan-guards.ts` file re-imports and re-exports the moved functions for backwards compat (or all API callers update their imports).

**Why:** `resolvePlanEntitlements` is a pure function over `PlansConfig` (already a domain type). It has zero DB dependency. Moving it to domain lets the worker import it without cross-app imports.

**Export from:** `packages/domain/src/index.ts` (or wherever the barrel export lives).

**Depends on:** Nothing (can be done in parallel).

---

## Step 10 — Worker: wire `skillOps` into ToolContext at runtime

**File:** `apps/worker/src/agents/` — wherever `ToolContext` is constructed for tool execution (likely in the agent runtime/tick execution code).

**Changes:**

1. Find where `ToolContext` is built for agent tool calls.
2. Add `skillOps` implementation that:
   - **`listAssigned()`:** Queries `agent_skills` joined with `skills` for the current agent, excluding `base`. Returns `[{ id, name, description }]`.
   - **`listAvailable()`:** Queries all skills, filters out already-assigned and `base`, applies plan entitlement filtering (needs agent's userId → user's planId → `resolvePlanSkillEntitlements`). Returns `[{ id, name, description }]`.
3. Both methods use the worker's DB handle (same one passed to the message broker).

**Implementation approach:** Create a small factory function `buildSkillOps(db, agentId)` that closes over the DB and agent ID. Wire it into the context builder.

**Depends on:** Steps 6, 9.

---

## Step 11 — Worker: wire `plansConfig` for broker handler

The broker's `handleManageAgentSkills` needs `PlansConfig` to resolve plan entitlements. The broker already receives `agentRiskDefaults` as a constructor param.

**Option A (simple):** Add `plansConfig?: PlansConfig` to the broker constructor, passed from `apps/worker/src/index.ts` (which already has `appConfig.plans`).

**Option B:** Use a callback pattern like `botLimitCheck`. But since the plan entitlement check is now a pure function in domain, a direct config pass is simpler.

**Go with Option A.** The broker constructor already accepts many config objects. One more is consistent.

**File:** `apps/worker/src/agents/agent-message-broker.ts` — add `plansConfig` param.
**File:** `apps/worker/src/index.ts` — pass `appConfig.plans` when constructing the broker (already passes `appConfig.plans` to the session manager, so this is consistent).

**Depends on:** Step 9.

---

## Step 12 — Tests

### Unit tests — Domain

**File:** New test or existing domain test file

- `ManageAgentSkillsPayloadSchema` accepts valid `{ action: 'add', skillIds: ['trading'] }`.
- `ManageAgentSkillsPayloadSchema` rejects empty skillIds array.
- `ManageAgentSkillsPayloadSchema` rejects more than 10 skillIds.
- `ManageAgentSkillsPayloadSchema` rejects invalid action.
- `KNOWN_AGENT_TOOL_NAMES` includes `list_skills`, `add_skills`, `remove_skills`.
- `TOOL_CATALOG` has entries for all three tools.
- `BASE_SKILL.requiredTools` includes all three tools.
- `findUnknownSkillTools(BASE_SKILL.requiredTools)` returns `[]`.

### Unit tests — DB package

**File:** `packages/db/src/skill-assignment.test.ts` (new)

- `resolveSkillAssignmentsForUser` returns assignments for valid skill IDs.
- `resolveSkillAssignmentsForUser` returns error for unknown skill IDs.
- `resolveSkillAssignmentsForUser` returns error for non-selectable skills.
- `resolveSkillAssignmentsForUser` handles empty input.
- `syncAgentSkillAssignments` with `'agent_self'` assignment source persists correctly.
- `isSkillSelectableForUser` returns true for system skills (authorId null).
- `isSkillSelectableForUser` returns true for user-authored skills.
- `isSkillSelectableForUser` respects `canViewMarketplaceSkills`.

### Unit tests — Worker tools

**File:** `apps/worker/src/tools/skills.test.ts` (new)

- `list_skills` returns assigned and available arrays when `skillOps` is present.
- `list_skills` returns error when `skillOps` is not wired.
- `add_skills` publishes `MANAGE_AGENT_SKILLS` with action `add`.
- `add_skills` rejects empty skillIds.
- `add_skills` rejects more than 10 skillIds.
- `remove_skills` publishes `MANAGE_AGENT_SKILLS` with action `remove`.
- `remove_skills` rejects empty skillIds.

### Unit tests — Worker broker

**File:** `apps/worker/src/agents/agent-broker.test.ts` (extend existing)

- `MANAGE_AGENT_SKILLS` with `action: 'add'` persists new skill assignments with `assignmentSource: 'agent_self'`.
- `MANAGE_AGENT_SKILLS` with `action: 'add'` for a non-entitled skill returns error.
- `MANAGE_AGENT_SKILLS` with `action: 'add'` for an already-assigned skill is idempotent.
- `MANAGE_AGENT_SKILLS` with `action: 'add'` rejects `'base'` skill ID.
- `MANAGE_AGENT_SKILLS` with `action: 'remove'` deletes the skill assignment.
- `MANAGE_AGENT_SKILLS` with `action: 'remove'` for non-assigned skill returns warning (not error).
- `MANAGE_AGENT_SKILLS` with `action: 'remove'` rejects `'base'` skill ID.
- Base skill never appears in assigned/available lists.

### Integration verification

- After `add_skills` → next call to `resolveRuntimeCapabilityDescriptor` includes the new skill's tools.
- After `remove_skills` → next call to `resolveRuntimeCapabilityDescriptor` excludes the removed skill's tools.
- Existing API skill assignment flow (`POST/PATCH /agents` with skillIds) continues to work after extraction.

---

## Implementation Order

```
Step 9  — Extract plan entitlements to domain (no deps, unblocks step 8)
Step 5  — Extract skill assignment logic to DB package (no deps, unblocks step 8)
Step 1  — Domain: tool names + catalog (no deps)
Step 2  — Domain: BASE_SKILL.requiredTools (depends on step 1)
Step 3  — Domain: message type + payload schema (no deps)
Step 6  — Domain: ToolContext.skillOps interface (no deps)
Step 7  — Worker: tool implementations (depends on steps 1, 3, 6)
Step 10 — Worker: wire skillOps into ToolContext (depends on steps 6, 9)
Step 11 — Worker: wire plansConfig into broker (depends on step 9)
Step 8  — Worker: broker handler (depends on steps 3, 5, 9, 11)
Step 12 — Tests (depends on all above)
```

Parallelizable groups:
- **Group A (domain):** Steps 1, 2, 3, 6, 9 — all domain package changes
- **Group B (DB extraction):** Step 5 — can run in parallel with Group A
- **Group C (worker):** Steps 7, 8, 10, 11 — depends on Groups A and B
- **Group D (tests):** Step 12 — after all implementation

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **Positional mock drift in API tests** after extracting functions from `agents.ts` | The extraction removes function definitions but not `db.select()` calls from the route handler. The route handler will import and call the same functions. Existing mocks should be unaffected if the query order doesn't change. Verify by running `pnpm test --filter @herobids/api`. See also `docs/bug-reports/2026/07/14/001-vitest-positional-select-mock-shift.md`. |
| **`agent-interactivity.ts` has duplicated skill logic** | The plan accounts for this — step 5 replaces the duplicated closures with shared imports. |
| **`assignmentSource` column type** | Already `text` (freeform) — no migration needed for `'agent_self'`. |
| **Circular dependency risk** | No risk. `domain` is a leaf package. `db` depends only on `domain`. Both app layers import from `db` and `domain`. |
| **Broker constructor parameter growth** | The broker already takes 14+ params. Adding `plansConfig` is one more. A future refactor could bundle these into an options object, but that's out of scope. |

---

## Open Questions (all resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should `list_skills` go through the broker? | No — direct DB read in the tool via `ctx.skillOps`. Only writes go through the broker. |
| 2 | Should `add_skills` validate before publishing? | Minimal client-side validation (schema). Full validation (plan entitlements, existence) happens in the broker handler. |
| 3 | New `assignmentSource` value? | `'agent_self'` — no migration needed (column is `text`). |
| 4 | Where to put extracted plan entitlements? | `packages/domain` — they are pure config functions with no DB dependency. |
| 5 | Where to put extracted skill assignment logic? | `packages/db` — they depend on Drizzle ORM and DB table schemas. |
