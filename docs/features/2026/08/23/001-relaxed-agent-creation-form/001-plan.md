# Plan: Relaxed Agent Creation Form

**Feature:** relaxed-agent-creation-form
**Date:** 2026-08-23
**Status:** Draft

## Summary

Make the agent creation and edit forms less intimidating by relaxing field requirements. The API already accepts most fields as optional and guards against invalid states — the problem is that the frontend forces the user to provide values that could be pre-resolved with sensible defaults. This plan makes the frontend stop requiring fields unnecessarily, pre-filling defaults instead, and communicating optionality clearly via progressive disclosure.

This is the foundational step toward blank-slate agents (see `docs/features/pending/002-blank-slate-agents/001-plan.md`), but scoped to just the field optionality and UX clarity — no new API endpoints, no self-management tools, no one-click button.

## Goals

- Fields that the user doesn't care about are pre-filled with sensible defaults — the user can submit without touching them.
- The form communicates clearly which fields matter and what happens if defaults are used.
- The API is unchanged. The frontend always sends valid, complete payloads — it just resolves defaults client-side when the user doesn't provide values.
- Existing agents and form-submitted agents with all fields filled continue to work identically (backward compatible).

## Non-Goals

- Changing the API schema or validation rules. The API guards stay as-is.
- Adding a "one-click create" button or empty-body POST. That's a follow-up feature.
- Adding agent self-management tools.
- Changing the agent detail page or post-creation guidance.
- Removing the Guided Setup chat flow.
- Moving defaults to operator config (deferred — hardcoded in frontend for v1).

## Current State

### Fields currently required by the frontend (`form-validation.ts`)

| Field | When required | Validation |
|---|---|---|
| `name` | Always | Must not be empty |
| `goal` (prompt) | When `capabilityMode` is `intelligence` or `hybrid` | Must not be empty |
| `capital` | When `requiresTradingSetup` is true | Must be a positive number |
| `venue` | When `executionMode === 'live'` | Must not be empty |
| `connectionIds` | When venue is selected and no connection granted | Must have at least 1 |

### What the API actually requires

| Field | API rule | Can the frontend pre-fill? |
|---|---|---|
| `name` | `z.string().min(1).max(100)` | Yes — auto-generate |
| `prompt` | Required when no `technical` | Yes — use a default prompt |
| `executionDefaults` | Required when trading-capable | Yes — `{ mode: 'paper' }` |
| Provider/model | 400 if no agent policy + no user AI settings | Yes — use operator defaults from `modelDefaults` |
| `capital` | Optional (but frontend forces it for trading) | Yes — use `"1000"` |

### Key insight

The API is fine. It validates against invalid states. The frontend is the bottleneck — it rejects the form before the user can submit, demanding values that have obvious defaults.

## Architecture Decisions

1. **No API changes.** The frontend always sends a complete, valid payload. It resolves defaults client-side for any field the user doesn't fill.
2. **Defaults are hardcoded in the frontend for v1.** Default prompt text, default capital, name generation — all live in the frontend code. A follow-up can extract them to a config endpoint if needed.
3. **Name includes style for readability.** Format: `{style}-agent-{hex}` (e.g., `bold-agent-A7F3`). Human-readable, indicates the agent's personality, collision-free via the hex suffix.
4. **Progressive disclosure communicates optionality.** Rather than labeling fields "optional," the form uses a two-tier layout: minimal visible surface (always-ready to submit) + expandable customization section.

## Default Values (hardcoded in frontend, v1)

| Field | Default value | Notes |
|---|---|---|
| `name` | `{style}-agent-{4 hex chars}` | e.g., `balanced-agent-A7F3`. Regenerates on style change. |
| `prompt` | `"Await instructions from your creator."` | Signals blank-slate agent. |
| `executionDefaults` | `{ mode: 'paper' }` | Safe default. Resolves to shadow if connection present (existing backend logic via `resolveExecutionModeForSkills`). |
| `capital` | `"1000"` | For trading agents only. Represents simulated USDC. |
| Provider/model | From `agentRuntime.llm.modelDefaults` (fetched via existing `ai/settings` or `ai/available-models` endpoint) | Frontend already queries these on mount. |
| `style` | `'balanced'` | Already the default today. |
| `capabilityMode` | `'intelligence'` | Already the default today. |

## UX Approach: Progressive Disclosure

### Problem

If all fields are visible and most have defaults, the user doesn't know where to start or what matters. Labeling 15 fields "optional" creates visual noise.

### Solution: Two-tier form

**Tier 1 — Always visible (the "quick create" surface):**
- **Agent type** selector (trading / personal assistant / custom) — pre-selects skills and defaults. Already exists as the capability mode / skill preset selector.
- **Name** — pre-filled with `{style}-agent-{hex}` (e.g., `balanced-agent-A7F3`). Editable. Helper text: "Auto-generated. Change it anytime."
- **Create** button — always enabled. Creates with all defaults.

**Tier 2 — Expandable ("Customize" section):**
- **Objective / prompt** — empty text area. Helper text: "Leave blank to start with a blank-slate agent that awaits your instructions."
- **Capital** — shows the default (`1000`). Helper text: "Simulated USDC allocation for trading agents."
- **Execution mode** — dropdown defaulting to "Test". Helper text: "Test mode uses simulated funds."
- **Strategy** — dropdown (momentum, range, etc.). Only shown for trading agents.
- **Style** — careful / balanced / bold. Pre-selected: balanced. Changing this regenerates the name.
- **Connection** — only shown for live mode.
- **Model / provider** — only shown if the user wants to override defaults. Helper text: "Default: [model name from operator settings]."

**Advanced Settings** (existing section, unchanged):
- Tick interval, risk limits, platform assessment, etc.

### Visual indicators

- Tier 1 fields that have defaults show the default value inline (pre-filled, editable).
- The "Customize" section is collapsed by default with a label like "Configure agent" or "More options".
- No "optional" badge spam. Optionality is communicated through: pre-filled defaults, progressive disclosure (hidden = optional), and the Create button being always-enabled.
- The strongest signal that defaults are fine: the Create button works immediately.

## Implementation Steps

### Step 1: Update name generation

**Files:**
- `apps/web/src/features/agents/agent-name.ts`

**Changes:**
- Replace the current `generateAgentName(style, counter)` → `balanced-agent-3` with a new implementation: `generateAgentName(style)` → `balanced-agent-A7F3`.
- Use `crypto.getRandomValues` (browser) to generate 2 random bytes → 4 hex chars (uppercase).
- Drop the sequential counter parameter — hex suffix is always unique enough.
- On style change, regenerate the name (existing behavior, just with new format).

### Step 2: Remove goal/prompt required validation

**Files:**
- `apps/web/src/features/agents/form-validation.ts`
- Tests if they exist

**Changes:**
- `goal`: remove the "Objective / prompt is required" check. When the goal field is empty, the frontend sends the default prompt at submission time. A blank goal is now an intentional valid state.
- **Keep all other validation unchanged:**
  - `name` stays required — user could clear the pre-filled name.
  - `capital` stays required for trading agents — user could clear the pre-filled `1000`.
  - `venue` stays required for live mode.
  - `connectionIds` stays required when venue is selected.
  - All "if provided, must be valid" checks stay unchanged.

### Step 3: Update form submission to send defaults for empty fields

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (CreateAgentFlow submission handler)

**Changes:**
- When building the API payload:
  - `name`: if empty (shouldn't happen due to pre-fill), generate one. Always send.
  - `prompt`: if goal field is empty, send the default prompt text. Always send a non-empty prompt.
  - `capital`: if empty and trading agent, send `"1000"`. Non-trading agents: omit (already the case).
  - `executionDefaults`: if not explicitly set by the user, send `{ mode: 'paper' }` for trading agents (existing logic already does this — verify and ensure it's not gated by the user touching the field).
  - Provider/model: if user hasn't selected a model, resolve from the `modelDefaults` already fetched from the `ai/settings` endpoint. Build a `modelPolicy` from those defaults.

### Step 4: Progressive disclosure layout

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (CreateAgentFlow component)

**Changes:**
- Restructure the form into two tiers:
  - **Tier 1 (always visible):** Type selector + Name + Create button.
  - **Tier 2 (collapsed "Customize" disclosure):** Goal, capital, execution mode, strategy, style, venue, connection, model/provider.
- The "Customize" section uses a disclosure/accordion pattern (collapsed by default).
- Advanced Settings section remains as-is (already a disclosure).
- Style field being in tier 2 means the name won't regenerate until the user opens Customize and changes style. The initial name uses the default style (`balanced`). This is fine — if they change style, the name updates.

### Step 5: Helper text for fields

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx`
- i18n locale files

**Changes:**
- Add helper/description text below each field in the Customize section:
  - Name: "Auto-generated from your agent's style. Change it anytime."
  - Goal: "Leave blank for a blank-slate agent that awaits your instructions."
  - Capital: "Default: 1000 USDC (simulated). Only used for trading agents."
  - Execution mode: "Test mode uses simulated funds. No real money is used."
  - Model: "Using [default model]. Change in Settings to apply to all agents."
- These are static descriptive text, not validation messages.

### Step 6: Ensure model defaults are always available

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (CreateAgentFlow)

**Changes:**
- The form already queries `ai/settings` and `ai/available-models` on mount. Verify that `modelDefaults` (provider, lightModel, heavyModel) are available from these responses.
- When building the payload, if the user hasn't touched model/provider fields, construct a `modelPolicy` from the fetched `modelDefaults`. This ensures the API never rejects for "provider required."
- If the user HAS saved their own AI settings (user-level defaults), those already flow through — the form currently uses them. No change needed for that path.

### Step 7: i18n

**Files:**
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add strings for:
  - Customize section label
  - Helper text for each field
  - Auto-generated name indicator
- Run the i18n regression test.

## Verification

### Frontend tests
1. Form submits successfully when only type is selected and defaults are kept.
2. Name field pre-fills with `{style}-agent-{hex}` format.
3. Changing style regenerates the name.
4. Customize section is collapsed by default.
5. Empty goal field results in default prompt being sent to API.
6. Pre-filled capital (`1000`) for trading agent is sent when user doesn't change it.
7. Model defaults are sent when user hasn't configured a provider.
8. Validation catches cleared name (user deletes the pre-filled name → "Name is required").
9. Validation catches cleared capital for trading agent (user deletes `1000` → "Capital is required").
10. Validation still catches invalid values when fields ARE filled (e.g., capital = "abc").
11. Live mode still requires venue + connection (hard requirement unchanged).
12. Helper text renders for each field in the Customize section.

### Manual / UAT
11. Walk through: open form → select "Trading" → click "Create Agent" without expanding Customize → agent created with defaults → verify: has name like `balanced-agent-A7F3`, default prompt, paper mode, 1000 capital, operator model.
12. Walk through: open form → select "Custom" → click "Create Agent" → agent created with intelligence mode, default prompt, no capital, no skills.
13. Walk through: open form → expand Customize → fill in goal, change style to "bold", change capital → create → values respected, name regenerated to `bold-agent-XXXX`.
14. Walk through: open form → expand Customize → select live mode → venue + connection become required → cannot submit without them.

## Risks / Considerations

1. **Model defaults might not be available.** If the `ai/settings` query fails or returns no `modelDefaults`, the form can't auto-fill the provider. Mitigation: disable the Create button until `modelDefaults` loads, or show an inline error ("Unable to load model defaults — please select a model manually"). This is an edge case (operator config issue).

2. **Name regeneration on style change.** If the user manually edits the name, then changes style, should the name regenerate and overwrite their edit? No — the existing `nameIsAutoGenerated` flag already handles this. If the user has typed their own name, style changes don't touch it.

3. **Default prompt wording.** "Await instructions from your creator" is generic but clear. It might feel odd for users who expect the agent to do something immediately. Mitigation: the post-creation detail page should make it clear the agent needs a mission. This is addressed in the blank-slate agents follow-up.

4. **Backward compatibility.** Users who already know the form and fill everything in — nothing changes for them. The Customize section just starts collapsed; if they expand it, all the same fields are there.

## Deferred (follow-up in blank-slate agents plan)

- "Create Agent" one-click button on `/agents` page (empty-body POST, requires API to accept empty body).
- Post-creation guidance banner ("Give your agent a mission").
- Agent self-management tools (`update_my_prompt`, `manage_my_skills`).
- Worker prompt context acknowledging blank-slate agents.
- Moving defaults to operator config (`agentDefaults` section).
- Landing page proof card verification.
