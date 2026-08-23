# Plan: Relaxed Agent Creation Form

**Feature:** relaxed-agent-creation-form
**Date:** 2026-08-23
**Status:** Draft

## Summary

Make the agent creation and edit forms less intimidating by relaxing field requirements. Fields that the backend treats as optional should not be forced in the frontend. Fields that require a value should resolve sensible server-side defaults when the user omits them. The result: a user can create an agent by filling in only the fields they care about, and the form communicates this clearly.

This is the foundational step toward blank-slate agents (see `docs/features/pending/002-blank-slate-agents/001-plan.md`), but scoped to just the field optionality and UX clarity — no new API endpoints, no self-management tools, no one-click button.

## Goals

- Fields that are optional in the backend are not required by the frontend form.
- Fields that need a value (e.g., `name`, `executionDefaults.mode` for trading agents) resolve a sensible default when omitted, and the form communicates what that default will be.
- The user clearly understands which fields are optional and what happens if they leave them blank.
- Existing agents and form-submitted agents with all fields filled continue to work identically (backward compatible).

## Non-Goals

- Adding a "one-click create" button or empty-body POST. That's a follow-up feature.
- Adding agent self-management tools (`update_my_prompt`, `manage_my_skills`).
- Changing the agent detail page or post-creation guidance.
- Removing the Guided Setup chat flow.
- Redesigning the form layout or visual style beyond optionality indicators.

## Current State

### Fields currently required by the frontend (`form-validation.ts`)

| Field | When required | Validation |
|---|---|---|
| `name` | Always | Must not be empty |
| `goal` (prompt) | When `capabilityMode` is `intelligence` or `hybrid` | Must not be empty |
| `capital` | When `requiresTradingSetup` is true | Must be a positive number |
| `venue` | When `executionMode === 'live'` | Must not be empty |
| `connectionIds` | When venue is selected and no connection granted | Must have at least 1 |

### Fields currently required by the API (`CreateAgentSchema` superRefine)

| Field | When required | Rule |
|---|---|---|
| `name` | Always | `z.string().min(1).max(100)` |
| `prompt` | When no `technical` config | superRefine: "prompt is required when no technical config is provided" |
| `executionDefaults` | When trading-capable | superRefine: trading skills or hybrid mode |
| Provider/model | Effectively always | 400 if no agent model policy AND no user AI settings |

### Server-side defaults already available

| Field | Default source |
|---|---|
| `capabilityMode` | `'intelligence'` (hardcoded in `resolveUnifiedConfig`) |
| `style` | `'balanced'` (form default) |
| `maxBots` | Plan limit (resolved in `prepareAgentCreateFields`) |
| `toolPolicy` | Derived from `skillIds` |
| `executionDefaults.mode` | Resolved by `resolveExecutionModeForSkills` (paper when no connection) |
| LLM provider/model | Operator defaults: `agentRuntime.llm.modelDefaults.{provider, lightModel, heavyModel}` in `config/default.yaml` |
| `name` | Auto-generated in chat route (`generateAgentName`); frontend has `generateAgentName(style, counter)` |

## Architecture Decisions

1. **Backend changes are minimal.** The API schema already has most fields optional. The main changes are: (a) remove the `prompt` superRefine requirement (resolve a default instead), (b) resolve `executionDefaults` server-side when omitted for trading agents, (c) fall back to operator model defaults when no user/agent model is configured, (d) make `name` optional (auto-generate server-side).

2. **Default prompt is operator-configurable.** Add an `agentDefaults` section to `config/default.yaml` with a `blankPrompt` text. When the user omits `prompt` and no `technical` config is provided, use this instead of rejecting. The prompt signals "awaiting instructions" rather than assuming a trading goal.

3. **Model fallback uses existing operator config.** `agentRuntime.llm.modelDefaults.{provider, lightModel, heavyModel}` already exists. When neither the agent nor the user has model settings, fall back to these operator defaults. Remove the 400 rejection — agents can always be created.

4. **Form UX uses progressive disclosure.** Rather than labeling every field "optional" (which is noisy), the form shows a minimal initial state with just 1-2 fields pre-filled and a clear "Configure more" expansion. The advanced section already exists — we extend this pattern to the primary fields.

## UX Approach: Progressive Disclosure

### Problem

If all fields are visible and all are optional, the user doesn't know where to start or what matters. Labeling 15 fields "optional" creates visual noise.

### Solution: Two-tier form

**Tier 1 — Always visible (the "quick create" surface):**
- **Agent type** selector (trading / personal assistant / custom) — pre-selects skills and defaults. Already exists as the capability mode selector.
- **Name** — pre-filled with an auto-generated name (e.g., `AG-7F3A`). Editable. Helper text: "Auto-generated. Change it if you'd like."
- **Create** button — always enabled. Creates with all defaults.

**Tier 2 — Expandable ("Customize" section):**
- **Objective / prompt** — empty text area. Helper text: "Leave blank to start with a blank-slate agent that awaits your instructions."
- **Capital** — empty by default for trading agents. Helper text: "Default: 1000 USDC (simulated)."
- **Execution mode** — dropdown defaulting to "Test". Helper text: "Test mode uses simulated funds."
- **Strategy** — dropdown (momentum, range, etc.). Only shown for trading agents.
- **Style** — careful / balanced / bold. Pre-selected: balanced.
- **Connection** — only shown for live mode.
- **Model / provider** — only shown if the user wants to override operator/user defaults.

**Advanced Settings** (existing section, unchanged):
- Tick interval, risk limits, platform assessment, etc.

### Visual indicators

- Tier 1 fields that have defaults show the default value inline (greyed-out placeholder or pre-filled).
- The "Customize" section has a collapsed-by-default disclosure with a label like "Configure agent" or "More options" and a count badge: "(7 options)".
- No "optional" badge spam. The UX communicates optionality through pre-filled defaults and progressive disclosure — if it's hidden, it's optional.

### Alternative considered: "optional" labels

Adding "(optional)" next to each field. Rejected because:
- When most fields are optional, labeling them all is redundant and noisy.
- Progressive disclosure is a stronger signal: hidden = optional, visible = important.
- The "Create" button being always-enabled is the strongest affordance that the form is ready.

## Implementation Steps

### Step 1: Operator config — add `agentDefaults` section

**Files:**
- `config/default.yaml`
- `packages/domain/src/config/` (schema expansion + validation)

**Changes:**
- Add `agentDefaults` section to `config/default.yaml`:
  ```yaml
  agentDefaults:
    blankPrompt: "You are an AI agent on the OpenAIdom platform. You have not yet been given a specific goal. Await instructions from your creator."
    defaultCapital: "1000"
    namePrefix: "AG"
  ```
- Add Zod schema for `agentDefaults` in the domain config types.
- Validate at startup (fail fast).

### Step 2: API — make `name` optional, auto-generate when omitted

**Files:**
- `apps/api/src/routes/agents.ts` (schema + handler)
- `apps/api/src/routes/agents.test.ts`

**Changes:**
- Change `CreateAgentSchema.name` from `AgentNameSchema` (required) to `AgentNameSchema.optional()`.
- In the `POST /agents` handler, when `name` is not provided, generate one server-side using the pattern from the chat route: `prefix-HEXHEX` (e.g., `AG-7F3A`). Use `agentDefaults.namePrefix` from operator config.
- The generated name must pass `AgentNameSchema` validation (never collides with reserved names "all" / "*").

### Step 3: API — remove `prompt` requirement, resolve default

**Files:**
- `apps/api/src/routes/agents.ts` (superRefine rule)
- `apps/api/src/routes/agents.test.ts`

**Changes:**
- Remove the superRefine rule: `if (!data.technical && !data.prompt) → error`.
- In the handler, when `prompt` is not provided and no `technical` config exists, resolve `agentDefaults.blankPrompt` from operator config.
- Pass the resolved prompt to `prepareAgentCreateFields` and the DB insert.

### Step 4: API — resolve `executionDefaults` when omitted for trading agents

**Files:**
- `apps/api/src/routes/agents.ts` (superRefine rule + handler)
- `apps/api/src/routes/agents.test.ts`

**Changes:**
- Remove the superRefine rule: `if (isTradingCapable && !data.executionDefaults) → error`.
- In the handler, when a trading-capable agent is created without `executionDefaults`, resolve a default: `{ mode: 'paper' }` (no connections = paper; has connections = shadow). Reuse `resolveExecutionModeForSkills` which already handles this logic.
- If the user provides `executionDefaults`, use them as-is (existing behavior).

### Step 5: API — fall back to operator model defaults

**Files:**
- `apps/api/src/routes/agents.ts` (model validation block)
- `apps/api/src/routes/agents.test.ts`

**Changes:**
- Currently: if no agent model policy AND no user AI settings → 400.
- New: if no agent model policy AND no user AI settings → resolve from `agentRuntime.llm.modelDefaults.{provider, lightModel, heavyModel}` and stamp the agent's model policy with these values.
- The agent is created with an explicit model policy derived from operator defaults. It can run immediately.

### Step 6: API — resolve default capital for trading agents

**Files:**
- `apps/api/src/routes/agents.ts` (handler)
- `apps/api/src/routes/agents.test.ts`

**Changes:**
- When a trading-capable agent is created without `capital`, resolve `agentDefaults.defaultCapital` from operator config.
- Ensure downstream risk calculation (`dailyLossLimitDefaultRatio * capital`) works correctly with the resolved default.
- Non-trading agents: capital remains null (no change).

### Step 7: Frontend — relax `validateCreateAgentForm`

**Files:**
- `apps/web/src/features/agents/form-validation.ts`
- `apps/web/src/features/agents/form-validation.test.ts` (if exists)

**Changes:**
- `name`: remove the "Name is required" check. When empty, the server auto-generates.
- `goal`: remove the "Objective / prompt is required" check. When empty, the server uses the blank-slate prompt.
- `capital`: remove the "Capital is required" check for trading agents. When empty, the server uses `agentDefaults.defaultCapital`.
- Keep `venue` required for live mode (this is a hard infrastructure requirement — live trading needs a venue).
- Keep `connectionIds` required when venue is selected (same reason).
- Keep all "if provided, must be valid" checks (positive number, within bounds, etc.) unchanged.

### Step 8: Frontend — progressive disclosure form layout

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (CreateAgentFlow)
- `apps/web/src/features/agents/CreateAgentPage.tsx`
- i18n locale files

**Changes:**

**Tier 1 (always visible):**
- Agent type selector (existing capability mode / skill preset selector) — keep as-is.
- Name field — pre-fill with auto-generated name from `generateAgentName(style, nameCounterRef.current)`. Show as editable with a greyed "auto-generated" indicator.
- "Create Agent" button — always enabled (no validation blocks it for tier 1).

**Tier 2 (expandable "Customize" disclosure):**
- Move `goal`, `capital`, `executionMode`, `strategyPreset`, `style`, `venue`, `connectionIds`, and model/provider fields into a collapsible section.
- Default: collapsed.
- Label: "Customize" or "Configure agent" with optional count badge.
- Each field shows helper text explaining the default when left blank:
  - Goal: "Leave blank for a blank-slate agent that awaits your instructions."
  - Capital: "Default: 1000 USDC (simulated). Only relevant for trading agents."
  - Execution mode: "Default: Test (simulated funds, no real trades)."
  - Model: "Default: [operator default model name]. Change in Settings for all agents."

**Advanced Settings** — unchanged (already a collapsed section).

### Step 9: Frontend — pre-fill name from server defaults

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/agent-name.ts`

**Changes:**
- Update `generateAgentName` to use a prefix+hex pattern matching the server-side format: `AG-XXXX` (or fetch the prefix from a new `/agents/defaults` endpoint if we want server/client consistency — TBD, could also just hardcode the same prefix on both sides for v1).
- When the form mounts, pre-fill the name field with the auto-generated name. Mark it as "auto-generated" (existing `nameIsAutoGenerated` state).
- If the user clears the name field entirely, omit `name` from the payload and let the server generate.

### Step 10: Frontend — update form submission to omit empty optional fields

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (form submission handler)

**Changes:**
- When submitting the create form, omit fields from the API payload when they are empty/unset:
  - `name`: omit if empty (server auto-generates).
  - `prompt`: omit if empty (server uses blank prompt).
  - `capital`: omit if empty (server uses default for trading agents).
  - `executionDefaults`: omit if not explicitly set (server resolves).
- Keep existing behavior: when a field IS provided, send it as-is.

### Step 11: i18n

**Files:**
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add strings for:
  - Customize section label
  - Helper text for each field's default behavior
  - Auto-generated name indicator text
- Run the i18n regression test to ensure all locales stay aligned.

## Verification

### API tests
1. `POST /agents` with empty body (only optional fields) → creates agent with auto-generated name, blank prompt, no skills, paper mode, operator model defaults.
2. `POST /agents` with `name` omitted → auto-generated name in response.
3. `POST /agents` with `prompt` omitted and no `technical` → blank-slate prompt persisted.
4. `POST /agents` with trading skills but no `executionDefaults` → resolved to paper mode.
5. `POST /agents` with no model policy and no user AI settings → operator defaults stamped.
6. `POST /agents` with trading skills but no `capital` → `agentDefaults.defaultCapital` persisted.
7. `POST /agents` with all fields provided → existing behavior unchanged.
8. Auto-generated names never collide with reserved names ("all", "*").

### Frontend tests
9. Form submits successfully with all fields empty (except type selection).
10. Name field pre-fills with auto-generated value.
11. Customize section is collapsed by default.
12. Helper text renders for each field.
13. Validation still catches invalid values when fields ARE filled (e.g., capital = "abc").
14. Live mode still requires venue + connection (hard requirement unchanged).

### Manual / UAT
15. Walk through: open form → select "Trading" → click "Create Agent" without filling anything else → agent created with defaults → verify on detail page: has name, blank prompt, paper mode, 1000 capital, operator model.
16. Walk through: open form → select "Custom" → click "Create Agent" → agent created with intelligence mode, blank prompt, no capital, no skills.
17. Walk through: open form → expand Customize → fill in goal, change capital → create → values respected.

## Risks / Considerations

1. **Server/client name format divergence.** If the frontend generates `balanced-agent-3` but the server generates `AG-7F3A`, there's a mismatch. Mitigation: align both to the prefix+hex format. The frontend pre-fills; if the user doesn't touch it, we can either send it or omit it (server regenerates). Omitting is simpler — the pre-fill is just a preview.

2. **Existing users expect required fields.** Users accustomed to the current form might be confused when fields disappear or become optional. Mitigation: progressive disclosure means the fields are still available (just collapsed), and the helper text explains defaults.

3. **Blank-slate agents might confuse the runtime.** An agent with "await instructions" prompt and no skills — what does it do when started? It runs a tick, sees no tools, and produces a "waiting for instructions" response. This is harmless but could confuse users. Mitigation: the agent detail page should already show status and prompt — the user sees it's blank. A follow-up feature (post-creation guidance banner) addresses this more directly.

4. **Capital default for non-trading agents.** Non-trading agents don't use capital. The server should NOT stamp a default capital for non-trading agents — only for trading-capable ones. Verify this in tests.

## Deferred (follow-up in one-click plan)

- "Create Agent" one-click button on `/agents` page (empty-body POST).
- Post-creation guidance banner ("Give your agent a mission").
- Agent self-management tools (`update_my_prompt`, `manage_my_skills`).
- Worker prompt context acknowledging blank-slate agents.
- Landing page proof card verification.
