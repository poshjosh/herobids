# One-Click Agent Creation

## Summary

Reduce agent creation to a single click. The user clicks "Create Agent" and immediately gets a blank-slate agent with sensible server-side defaults: an auto-generated name, a default "awaiting purpose" prompt, no skills, always in test/paper mode. Everything else — goal, skills, strategy, connections — happens after creation, either through the edit form, through messaging (Telegram/chat), or by the agent itself.

This feature also establishes two product principles:

1. **Role/type is a frontend concept.** An agent is defined by its current prompt + skills, not by a creation-time category. A "trading agent" is just an agent with trading skills. An agent with no skills is implicitly custom. The backend never branches on role/type.
2. **Agents are reconfigurable mid-flight.** Prompt and skills are mutable state, not creation-time constants. Users may change them after creation, and agents may change them themselves (with the same permissions model that already lets agents manage their own bots).

## Goals

- One-click creation from the agents page and from `/agents/new`.
- Every currently-mandatory form field becomes optional: `name`, `goal`/`prompt`, `capital`.
- Blank-slate agents: server resolves a default prompt when the user provides none.
- Mid-flight reconfiguration: prompt and skill changes after creation, including agent-initiated changes via new tools.
- Role/type demoted to frontend semantics — no new backend branching on role/type.

## Non-Goals (v1)

- Removing the full create/edit form or Guided Setup chat. One-click is additive.
- Live trading without a connection. One-click agents always start in test mode (paper when no connection exists, shadow when one does).
- Agents self-provisioning connections/credentials. OAuth and API keys require browser flows and user action; agents may only request them conversationally (already possible via Guided Setup and messaging).
- Removing `capabilityMode`/`hybridMode` from the backend. v1 treats them as derived/stamped metadata; a later feature can fully derive them from skills.
- Auto-configuring Telegram/notification preferences at creation.

## Recommended Product Semantics

### One-click flow

- "Create Agent" button on `/agents` and `/agents/new` calls `POST /agents` with an empty body (or only optional overrides).
- Server: auto-generates name, resolves default prompt, resolves default capital, stamps execution mode = test, assigns no skills, no connections.
- Response redirects to `/agents/:id` where the user can configure or start chatting.
- The agent detail page must clearly show: "Test mode — simulated funds. No real money is used." plus a `Configure` affordance.

### Blank-slate agent defaults

| Field | Default | Source |
|---|---|---|
| Name | Auto-generated (`Agent <n>` or adjective-noun, TBD) | Server |
| Prompt | "You are an AI agent on the OpenAIdom platform. You have not yet been given a goal or skills. Await instructions from your creator. When you receive a goal, internalize it as your purpose and use available tools to acquire skills you need." | Operator config (`config/default.yaml`) |
| Skills | none (implicitly custom) | Server |
| Capital | `1000` (only for trading-capable agents) | Operator config |
| Execution mode | `test` → paper (no connection) / shadow (has connection) | Existing logic (`mapExecutionMode` in `chat.ts`) |
| Style | `balanced` | Existing logic |
| Capability mode | `intelligence`; derived `hybrid` when trading skills present | Existing logic |

### Mid-flight reconfiguration

- **User → agent:** already supported via edit form and Telegram/chat messaging. The gap is the user telling the agent "send motivational quotes each morning" and the agent *persisting* that as its new goal.
- **Agent → self:** new tools (see below) let the agent update its own prompt and manage its own skill assignments.
- **Safety:** Agent Mode Purity holds. The agent's prompt is the agent's own domain — changing it is not a policy injection. User-configured risk limits remain immutable. Skill self-assignment must respect plan entitlements (same validation as the API).

## Architecture Decisions

1. **Defaults live in operator config.** Follow the config layering rule (`config/default.yaml`). Default prompt texts and default capital are operator-owned, not hardcoded. The current v1 defaults hardcoded in `synthesizePrompt()` (`chat.ts`) move here.
2. **Prompt resolution is shared.** Extract the default-prompt resolution used by Guided Setup into a shared helper (`apps/api/src/agents/`), so `POST /agents`, Guided Setup, and one-click all synthesize from the same operator-config defaults.
3. **Agent self-management reuses the inbound message pattern.** New `AGENT_MESSAGE_TYPES` entries + payload schemas in `packages/domain/src/agent-protocol.ts`, handled in `apps/worker/src/agents/agent-message-broker.ts` (same path as `MANAGE_BOT`), validated against plan entitlements via a shared helper extracted from `apps/api/src/routes/agents.ts`.
4. **New tools are registered in the domain tool catalog.** `KNOWN_AGENT_TOOL_NAMES` + `TOOL_CATALOG` in `packages/domain/src/tools.ts` must include any new tool or `assertToolCatalogMatchesRegistry` fails at worker startup.
5. **`skillPresetId` remains metadata.** No schema change — it already lives in `unifiedConfig.metadata`.

---

## Detailed Plan

### 1. Operator config: agent creation defaults

Files:
- `config/default.yaml`
- `packages/domain/src/config/` schema if operator config requires expansion
- config validation tests

Changes:
- Add an `agentDefaults` section (name TBD; must not collide with existing `agentRiskDefaults`):
  ```yaml
  agentDefaults:
    blankPrompt: "You are an AI agent on the OpenAIdom platform. ..."
    defaultCapital: "1000"
    namePrefix: "Agent"
  ```
- Preset-specific default goals currently hardcoded in `synthesizePrompt()` (`"Grow this portfolio"`, `"Assist with daily tasks and information retrieval"`, etc.) move here too, so all defaults are operator-configurable.
- Validate at startup via Zod (fail fast).

### 2. Domain: new inbound message types + tool catalog entries

Files:
- `packages/domain/src/agent-protocol.ts` (and tests)

Changes:
- Add `AGENT_MESSAGE_TYPES.UPDATE_AGENT_PROMPT` with payload schema `{ prompt: string (max 4000) }`.
- Add `AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS` with payload schema `{ action: 'list' | 'assign' | 'remove', skillIds?: string[] }`.
- `list` could be served from the existing tool catalog/schema surface instead of the broker — decide during implementation; broker handling keeps one write path for persistence.

### 3. Domain: register new tools in catalog

Files:
- `packages/domain/src/tools.ts` (and tests)

Changes:
- Add `update_my_prompt` (category: `manage-self` or existing management category) and `manage_my_skills` to `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG`.
- Add tool schemas to the schema surface used by `get_schema`.

### 4. API: relax `POST /agents` requirements

Files:
- `apps/api/src/routes/agents.ts`
- `apps/api/src/agents/agent-create-normalization.ts`
- `apps/api/src/routes/chat.ts` (extract shared prompt resolution)
- `apps/api/src/routes/agents.test.ts`, functional tests

Changes:
- `CreateAgentSchema`:
  - `name` becomes optional → server auto-generates when omitted (must still pass `AgentNameSchema` reserved-name validation; generated names never collide with reserved names).
  - Remove/replace the `superRefine` rule requiring `prompt` when no `technical`: when both are absent, resolve the blank default prompt from operator config.
- Extract `resolveDefaultPrompt(preset, capital, appConfig)` from `synthesizePrompt()` into a shared helper; keep `synthesizePrompt` behavior for Guided Setup.
- Default capital: when a trading-capable agent is created without `capital`, resolve from `agentDefaults.defaultCapital`.
- Derive `capabilityMode` from skills when not provided (skills with trading capability family → hybrid; else intelligence). Do not introduce role/type branching.
- Keep the `hybrid` requires `technical`-or-`strategyPreset` guard unchanged.

### 5. API: risk resolution with default capital

Files:
- Wherever `dailyLossLimit` is resolved from `capital` (grep `dailyLossLimitDefaultRatio`)
- `apps/api/src/routes/agents.test.ts`

Changes:
- Confirm trading-capable agents with resolved default capital produce a sensible daily loss limit.
- Ensure no code path throws when `capital` is null for non-trading agents (already should not — verify with a test).

### 6. Worker: handle new inbound message types

Files:
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/agent-message-broker.test.ts`

Changes:
- `UPDATE_AGENT_PROMPT`: validate prompt length, persist to `agents.prompt` via repository, log the change (audit trail — who changed what: `user` vs `agent`).
- `MANAGE_AGENT_SKILLS`:
  - Validate against plan entitlements using a shared helper extracted from `apps/api/src/routes/agents.ts` (`resolveSkillAssignmentsForUser` / `resolveSkillPlanEntitlements`). Agent self-assignment must not bypass plan gating.
  - Persist via the same skill-assignment logic as `syncAgentSkillAssignments`, with `assignmentSource: 'agent_self'` (new enum value if the column type requires it — check schema).
- Skill changes take effect next session/tick (the runtime reads skills per session — verify; if skills are loaded at session start, log "effective on next tick").
- Prompt changes take effect next tick — do not hot-reload the running system prompt mid-session.

### 7. Worker: new agent tools

Files:
- new `apps/worker/src/tools/self-management.ts` (or split: `update-my-prompt.ts`, `manage-my-skills.ts`)
- `apps/worker/src/tools/index.ts`
- tool tests

Changes:
- `update_my_prompt`:
  - Input: `{ prompt: string, rationale?: string }`.
  - Publishes `UPDATE_AGENT_PROMPT` inbound message.
  - Description must state the change takes effect next tick and that user-configured constraints (risk limits) are unaffected.
- `manage_my_skills`:
  - Input: `{ action: 'list' | 'assign' | 'remove', skillIds?: string[] }`.
  - `list` returns skills available to this agent under its plan entitlements (read-only).
  - `assign`/`remove` publish `MANAGE_AGENT_SKILLS` and return an acknowledgment ("effective next tick").
  - Follow `change-strategy-preset.ts` / `bots.ts` patterns (publish inbound + acknowledge).
- Expose both to agents by default. Consider whether a creator-facing permission should gate `update_my_prompt` — default recommendation: allowed (it is the agent's own domain), but add an operator kill-switch in config if trivial.

### 8. Worker: prompt context acknowledges self-configuration

Files:
- Prompt composition (`apps/worker/src/runtime-composition.ts` and related)

Changes:
- When the agent has a blank/default prompt (created one-click), inject a short guidance block: "Your creator has not given you a goal yet. When they send you a message describing what they want, treat it as your mission and persist it with `update_my_prompt` if it is a durable change. Use `manage_my_skills` to discover and adopt skills that match your mission."
- This block must only appear while the prompt is the default blank prompt (flag via config or a marker), not for every agent.

### 9. Frontend: one-click creation entry points

Files:
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/CreateAgentPage.tsx`
- `apps/web/src/lib/api-client.ts` (if a dedicated `createBlankAgent()` helper is warranted)
- i18n: `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

Changes:
- Primary "Create Agent" button on `/agents`: calls `POST /agents` with empty body, navigates to `/agents/:id`. Busy state with spinner; error handling for `billing.top_up_required` and agent-limit errors.
- On `/agents/new`, add a prominent "One-click" affordance above the existing form/chat toggle: "Just want an agent now? [Create Agent]" — creates instantly and navigates away.
- Keep the full form and Guided Setup untouched.

### 10. Frontend: relax form validation

Files:
- `apps/web/src/features/agents/form-validation.ts`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- create-flow tests, `EditAgentModal.render.test.tsx`

Changes:
- `name`: optional — if empty, omit from payload and let the server auto-generate. Add helper text "Leave blank for an auto-generated name."
- `goal`: optional — omit from payload; server supplies the default blank prompt. Update helper text.
- `capital`: optional for trading agents — omit from payload; server resolves `agentDefaults.defaultCapital`. Add helper text showing the default that will apply.
- Venue/connection rules unchanged (live mode still requires a connection).
- Verify `ADVANCED_FIELD_TAB` and error-surfacing still work when fields are empty-but-valid.

### 11. Frontend: post-creation guidance

Files:
- `apps/web/src/features/agents/` agent detail page components
- i18n locales

Changes:
- When a one-click agent is created (no prompt, no skills, test mode), show a dismissible banner on the detail page:
  - "Your agent is in Test mode with simulated funds. No real money is used."
  - "Give your agent a mission: [Open chat] or [Configure]."
- The existing `Configure`/edit affordance covers everything else.

### 12. Landing page proof card

- Verify the existing "Get your agent in one click" proof card (`apps/web/src/features/landing/LandingPagePlaceholder.tsx`, tests in `LandingPagePlaceholder.test.tsx`) matches the delivered behavior and copy. Update copy if needed ("one click" must literally be one click after this feature ships).

### 13. i18n

- All new user-facing strings in `en.ts`, `ar.ts`, `hi.ts`; run the i18n regression test.

---

## Testing Plan

### Domain
- New payload schemas accept/reject correct shapes.
- Tool catalog assertions pass with the new tools registered.

### API
- `POST /agents` with empty body creates an agent: auto-generated name, default blank prompt, no skills, test mode, default capital when trading-capable.
- `POST /agents` with no prompt and no technical resolves the operator-config default prompt.
- Auto-generated names never trip reserved-name validation.
- Trading agent without capital resolves `agentDefaults.defaultCapital` and produces a valid daily loss limit.
- `PATCH /agents` prompt and skill updates still work and respect entitlements.

### Worker
- `update_my_prompt` persists a new prompt; the change is visible in the next tick's context.
- `manage_my_skills list` returns only plan-entitled skills.
- `manage_my_skills assign` with a non-entitled skill is rejected.
- Blank-prompt guidance block appears only for default-prompt agents.
- Existing agents (non-blank prompts) are unaffected.

### Web
- One-click button on `/agents` creates an agent and navigates to the detail page.
- Empty name/goal/capital submits successfully in the form.
- Post-creation banner renders for one-click agents and is dismissible.
- Landing page proof card copy and link verified.

### Manual / UAT
- Full loop: click create → detail page → open chat → "send motivational quotes to my husband each morning" → agent asks for Gmail → after connection, agent persists goal via `update_my_prompt` and assigns an email skill via `manage_my_skills` (this requires the mid-flight tools to be live — otherwise verify the conversational ask + manual configure fallback).

---

## Rollout

- No DB migration expected (config + code only), unless `assignmentSource` enum expansion is needed — verify in step 6.
- One-click flow is additive; existing forms/chat keep working.
- No feature flag strictly required, but consider gating the agent self-management tools behind operator config while the mid-flight loop is being validated.

## Open Questions

1. **Auto-name scheme.** `Agent <n>` is simple and predictable; adjective-noun names feel warmer but add a word-list dependency. Which do we want for v1?
2. **`update_my_prompt` permission.** Allowed for all agents by default, or creator-gated? Recommendation: allowed by default (agent's own domain per Agent Mode Purity), with an operator kill-switch.
3. **Skill changes from the agent mid-session.** Do skill changes take effect immediately or next tick? Recommendation: next tick/session for safety, with explicit acknowledgment text.
4. **Prompt history.** Should prompt changes be journaled (who changed it, when, old → new) for audit? Recommendation: yes, minimal journal events.
