# Blank-Slate Agents

**Status:** Pending (depends on `docs/features/2026/08/23/001-relaxed-agent-creation-form/001-plan.md`)

## Summary

Reduce agent creation to a single click. The user clicks "Create Agent" on the agents page and immediately gets a blank-slate agent with sensible server-side defaults. Everything else — goal, skills, strategy, connections — happens after creation, either through the edit form, through messaging (Telegram/chat), or by the agent itself via new self-management tools.

This feature builds on the relaxed form field requirements implemented in the prerequisite feature (relaxed-agent-creation-form). That feature makes all form fields optional and resolves server-side defaults. This feature adds:

1. **One-click creation entry points** — buttons that call `POST /agents` with an empty body.
2. **Post-creation guidance** — banner on the detail page explaining next steps.
3. **Agent self-management tools** — `update_my_prompt` and `manage_my_skills` so agents can configure themselves at runtime.
4. **Worker prompt context** — blank-slate agents get a guidance block telling them to await and internalize creator instructions.

## Product Principles

1. **Role/type is a frontend concept.** An agent is defined by its current prompt + skills, not by a creation-time category. A "trading agent" is just an agent with trading skills. An agent with no skills is implicitly custom. The backend never branches on role/type.
2. **Agents are reconfigurable mid-flight.** Prompt and skills are mutable state, not creation-time constants. Users may change them after creation, and agents may change them themselves (with the same permissions model that already lets agents manage their own bots).

## Prerequisites (already implemented or in-progress)

The following are handled by the relaxed-agent-creation-form feature and are NOT part of this plan:

- [x] `name` optional in API → server auto-generates
- [x] `prompt` optional in API → server resolves blank-slate prompt from `agentDefaults.blankPrompt`
- [x] `executionDefaults` optional for trading agents → server resolves paper/shadow
- [x] Model fallback to operator defaults (`agentRuntime.llm.modelDefaults`)
- [x] Default capital for trading agents from `agentDefaults.defaultCapital`
- [x] `agentDefaults` operator config section in `config/default.yaml`
- [x] Frontend form validation relaxed (name, goal, capital no longer required)
- [x] Progressive disclosure form layout
- [x] Frontend omits empty fields from payload

## Goals (this plan only)

- One-click creation from the agents page and from `/agents/new`.
- Post-creation guidance for blank-slate agents.
- Mid-flight reconfiguration: agent-initiated prompt and skill changes via new tools.
- `lastPromptUpdateSource` tracking (user vs agent) visible on the detail page.
- Prompt change journaling for audit.

## Non-Goals

- Removing the full create/edit form or Guided Setup chat. One-click is additive.
- Live trading without a connection. One-click agents always start in test mode.
- Agents self-provisioning connections/credentials.
- Removing `capabilityMode`/`hybridMode` from the backend.
- Auto-configuring Telegram/notification preferences at creation.

## Recommended Product Semantics

### One-click flow

- "Create Agent" button on `/agents` and `/agents/new` calls `POST /agents` with an empty body.
- Server: auto-generates name, resolves default blank prompt, stamps execution mode = test, assigns no skills, no connections, uses operator model defaults.
- Response navigates to `/agents/:id` where the user can configure or start chatting.
- The agent detail page shows: "Test mode — simulated funds. No real money is used." plus a `Configure` affordance.

### Mid-flight reconfiguration

- **User → agent:** already supported via edit form and Telegram/chat messaging. The gap is the user telling the agent "send motivational quotes each morning" and the agent *persisting* that as its new goal.
- **Agent → self:** new tools let the agent update its own prompt and manage its own skill assignments.
- **Safety:** Agent Mode Purity holds. The agent's prompt is the agent's own domain — changing it is not a policy injection. User-configured risk limits remain immutable. Skill self-assignment must respect plan entitlements (same validation as the API).
- **Visibility:** A `lastPromptUpdateSource: 'user' | 'agent'` field on the agent record makes it clear when the agent has modified its own prompt. The detail page surfaces this.

## Architecture Decisions

1. **Agent self-management reuses the inbound message pattern.** New `AGENT_MESSAGE_TYPES` entries + payload schemas in `packages/domain/src/agent-protocol.ts`, handled in `apps/worker/src/agents/agent-message-broker.ts` (same path as `MANAGE_BOT`), validated against plan entitlements via a shared helper extracted from `apps/api/src/routes/agents.ts`.
2. **New tools are registered in the domain tool catalog.** `KNOWN_AGENT_TOOL_NAMES` + `TOOL_CATALOG` in `packages/domain/src/tools.ts` must include any new tool or `assertToolCatalogMatchesRegistry` fails at worker startup.
3. **Prompt changes take effect next tick.** Do not hot-reload the running system prompt mid-session. The worker reads the prompt at session/tick start.
4. **Prompt history is journaled.** Changes are recorded with `source: 'user' | 'agent'`, old value, new value, and timestamp. Minimal journal events — not a full audit log, just enough to answer "who changed what when."
5. **Blank-slate detection uses a `isDefaultPrompt` flag.** Rather than string-comparing against the operator config default, stamp a boolean `isDefaultPrompt` on the agent record at creation time. Cleared on first prompt update. The worker uses this to inject the guidance block.

---

## Detailed Plan

### 1. Domain: new inbound message types

**Files:**
- `packages/domain/src/agent-protocol.ts` (and tests)

**Changes:**
- Add `AGENT_MESSAGE_TYPES.UPDATE_AGENT_PROMPT` with payload schema `{ prompt: string (max 4000) }`.
- Add `AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS` with payload schema `{ action: 'list' | 'assign' | 'remove', skillIds?: string[] }`.

### 2. Domain: register new tools in catalog

**Files:**
- `packages/domain/src/tools.ts` (and tests)

**Changes:**
- Add `update_my_prompt` (category: existing management category) and `manage_my_skills` to `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG`.
- Add tool schemas to the schema surface used by `get_schema`.

### 3. DB: schema additions

**Files:**
- `packages/db/src/schema/` (agents table)
- Migration file

**Changes:**
- Add `isDefaultPrompt: boolean` column to agents table (default: false for existing agents; true when created with blank prompt).
- Add `lastPromptUpdateSource: 'user' | 'agent' | null` column (nullable, default null).
- Consider: `prompt_journal` table or JSONB array column for prompt history. Recommendation: separate `agent_prompt_history` table with `{ id, agentId, source, oldPrompt, newPrompt, createdAt }`.

### 4. Worker: handle new inbound message types

**Files:**
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/agent-message-broker.test.ts`

**Changes:**
- `UPDATE_AGENT_PROMPT`:
  - Validate prompt length (max 4000).
  - Persist to `agents.prompt` via repository.
  - Set `isDefaultPrompt = false`.
  - Set `lastPromptUpdateSource = 'agent'`.
  - Insert journal entry.
  - Log the change.
- `MANAGE_AGENT_SKILLS`:
  - Validate against plan entitlements using a shared helper extracted from `apps/api/src/routes/agents.ts` (`resolveSkillAssignmentsForUser` / `resolveSkillPlanEntitlements`). Agent self-assignment must not bypass plan gating.
  - Persist via the same skill-assignment logic as `syncAgentSkillAssignments`, with `assignmentSource: 'agent_self'` (new enum value if the column type requires it — check schema).
- Skill changes take effect next tick.
- Prompt changes take effect next tick.

### 5. Worker: new agent tools

**Files:**
- New `apps/worker/src/tools/self-management.ts` (or split: `update-my-prompt.ts`, `manage-my-skills.ts`)
- `apps/worker/src/tools/index.ts`
- Tool tests

**Changes:**
- `update_my_prompt`:
  - Input: `{ prompt: string, rationale?: string }`.
  - Publishes `UPDATE_AGENT_PROMPT` inbound message.
  - Description must state the change takes effect next tick and that user-configured constraints (risk limits) are unaffected.
- `manage_my_skills`:
  - Input: `{ action: 'list' | 'assign' | 'remove', skillIds?: string[] }`.
  - `list` returns skills available to this agent under its plan entitlements (read-only).
  - `assign`/`remove` publish `MANAGE_AGENT_SKILLS` and return an acknowledgment ("effective next tick").
  - Follow `change-strategy-preset.ts` / `bots.ts` patterns (publish inbound + acknowledge).
- Expose both to agents by default. Operator kill-switch in config if trivial.

### 6. Worker: prompt context acknowledges self-configuration

**Files:**
- Prompt composition (`apps/worker/src/runtime-composition.ts` and related)

**Changes:**
- When the agent has `isDefaultPrompt = true`, inject a short guidance block: "Your creator has not given you a goal yet. When they send you a message describing what they want, treat it as your mission and persist it with `update_my_prompt` if it is a durable change. Use `manage_my_skills` to discover and adopt skills that match your mission."
- This block is omitted when `isDefaultPrompt = false`.

### 7. API: stamp `isDefaultPrompt` on creation

**Files:**
- `apps/api/src/routes/agents.ts` (POST handler)
- `apps/api/src/routes/agents.test.ts`

**Changes:**
- When `POST /agents` resolves the blank-slate prompt (user didn't provide one), set `isDefaultPrompt = true` on the new agent record.
- When the user provides an explicit prompt, set `isDefaultPrompt = false`.
- On `PATCH /agents` prompt update: set `isDefaultPrompt = false`, `lastPromptUpdateSource = 'user'`, insert journal entry.

### 8. Frontend: one-click creation entry points

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/CreateAgentPage.tsx`
- i18n locale files

**Changes:**
- Primary "Create Agent" button on `/agents`: calls `POST /agents` with empty body, navigates to `/agents/:id`. Busy state with spinner; error handling for `billing.top_up_required` and agent-limit errors.
- On `/agents/new`, add a prominent "One-click" affordance above the existing form/chat toggle: "Just want an agent now? [Create Agent]" — creates instantly and navigates away.
- Keep the full form and Guided Setup untouched.

### 9. Frontend: post-creation guidance

**Files:**
- `apps/web/src/features/agents/` agent detail page components
- i18n locales

**Changes:**
- When a one-click agent is detected (`isDefaultPrompt = true`, no skills, test mode), show a dismissible banner on the detail page:
  - "Your agent is in Test mode with simulated funds. No real money is used."
  - "Give your agent a mission: [Open chat] or [Configure]."
- The existing Configure/edit affordance covers everything else.

### 10. Frontend: surface `lastPromptUpdateSource`

**Files:**
- Agent detail page components

**Changes:**
- When `lastPromptUpdateSource === 'agent'`, show a subtle indicator near the prompt display: "Last updated by agent" with timestamp.
- This gives the creator visibility into when the agent modified its own purpose.

### 11. Landing page proof card

- Verify the existing "Get your agent in one click" proof card matches the delivered behavior. Update copy if needed.

### 12. i18n

- All new user-facing strings in `en.ts`, `ar.ts`, `hi.ts`; run the i18n regression test.

---

## Testing Plan

### Domain
- New payload schemas accept/reject correct shapes.
- Tool catalog assertions pass with the new tools registered.

### API
- `POST /agents` with empty body creates an agent with `isDefaultPrompt = true`.
- `PATCH /agents` with prompt update sets `isDefaultPrompt = false`, `lastPromptUpdateSource = 'user'`.
- Auto-generated names never trip reserved-name validation.

### Worker
- `update_my_prompt` persists a new prompt; sets `isDefaultPrompt = false`, `lastPromptUpdateSource = 'agent'`.
- `manage_my_skills list` returns only plan-entitled skills.
- `manage_my_skills assign` with a non-entitled skill is rejected.
- Blank-prompt guidance block appears only for `isDefaultPrompt = true` agents.
- Existing agents (`isDefaultPrompt = false`) are unaffected.
- Prompt journal entries are created on every prompt change.

### Web
- One-click button on `/agents` creates an agent and navigates to the detail page.
- Post-creation banner renders for blank-slate agents and is dismissible.
- `lastPromptUpdateSource` indicator renders when agent has self-modified.
- Landing page proof card copy and link verified.

### Manual / UAT
- Full loop: click create → detail page → open chat → "send motivational quotes to my husband each morning" → agent asks for Gmail → after connection, agent persists goal via `update_my_prompt` and assigns an email skill via `manage_my_skills`.

---

## Rollout

- DB migration for `isDefaultPrompt`, `lastPromptUpdateSource`, and `agent_prompt_history` table.
- One-click flow is additive; existing forms/chat keep working.
- Consider gating the agent self-management tools behind operator config while the mid-flight loop is being validated.

## Open Questions

1. **Auto-name scheme.** Recommendation: `AG-XXXX` (prefix+hex), consistent with the chat route pattern. Collision-free without a counter query.
2. **`update_my_prompt` permission.** Recommendation: allowed by default (agent's own domain per Agent Mode Purity), with an operator kill-switch.
3. **Skill changes from the agent mid-session.** Recommendation: next tick/session for safety, with explicit acknowledgment text.
4. **Prompt history retention.** Recommendation: keep last 20 entries per agent, prune older on write.
