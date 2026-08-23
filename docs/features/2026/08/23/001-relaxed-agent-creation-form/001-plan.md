# Plan: Relaxed Agent Creation Form

**Feature:** relaxed-agent-creation-form
**Date:** 2026-08-23
**Status:** Implemented

## Summary

Make the agent creation form less intimidating by relaxing field requirements and improving visual clarity. The API already accepts most fields as optional and guards against invalid states — the problem is that the frontend forces the user to provide values that could be pre-resolved with sensible defaults. This plan makes the frontend stop requiring fields unnecessarily, pre-filling defaults instead, and annotating optional sections so users know they can skip them.

This is the foundational step toward blank-slate agents (see `docs/features/pending/002-blank-slate-agents/001-plan.md`), but scoped to just the field optionality and UX clarity — no new API endpoints, no self-management tools, no one-click button, no form layout restructuring.

## Goals

- Fields that the user doesn't care about are pre-filled with sensible defaults — the user can submit without touching them.
- Optional sections (skills, connections) are clearly marked so users know they can skip them.
- The skills section is collapsed by default to reduce visual weight.
- The API is unchanged. The frontend always sends valid, complete payloads.
- Existing agents and fully-filled submissions continue to work identically.

## Non-Goals

- Changing the API schema or validation rules.
- Restructuring the form layout (no tier-1/tier-2 split, no progressive disclosure overhaul).
- Adding a "one-click create" button.
- Changing the agent detail page or post-creation guidance.
- Removing the Guided Setup chat flow.
- Moving defaults to operator config (hardcoded in frontend for v1).

## Current State

### Form layout (step: 'intent')

```
1. Skill Preset selector (trading / personal-assistant / custom)
2. Custom skill picker (shown inline when "custom" selected)
3. PromptInputBlock (goal textarea + style selector + file upload)
4. AgentFormBody:
   - Capital (trading only)
   - Connection slot
   - Telegram Chat ID
   - Name
   - [Cancel + Review buttons]
   - Advanced Settings (collapsed accordion with tabs)
5. Review step → Create
```

### What changes

```
1. Skill Preset selector (unchanged)
2. Skills section — ALWAYS COLLAPSED, with contextual expand label:
   - Preset selected: "Edit skills (Optional)"
   - Custom selected: "Add skills (Optional)"
3. PromptInputBlock:
   - Remove "(What should the AI agent do?)" subtitle on mobile
   - Goal field: do NOT mark as optional, keep existing placeholder
   - If user leaves goal empty, send default prompt at submission
4. AgentFormBody:
   - Capital: pre-filled with "1000" for trading (existing behavior, keep)
   - Connection slot: add "(Optional)" to section header
   - Telegram Chat ID (unchanged)
   - Name: pre-filled with "{style}-agent-{hex}" format
   - [Cancel + Review buttons]
   - Advanced Settings (unchanged)
5. Review step → Create
```

## Architecture Decisions

1. **No API changes.** The frontend always sends a complete valid payload.
2. **Defaults are hardcoded in the frontend for v1.** Default prompt, default capital, name generation.
3. **Name format:** `{style}-agent-{4 hex chars}` (e.g., `bold-agent-A7F3`). Readable, collision-free.
4. **"(Optional)" labels are targeted, not global.** Only on skills and connection sections — the two that most commonly block users. A distinct color differentiates them from field labels.
5. **Skills section is always collapsed.** Reduces visual weight. The preset selector above already communicates what's selected (via the muted skill-name line below it).

## Default Values (hardcoded in frontend, v1)

| Field | Default value | Notes |
|---|---|---|
| `name` | `{style}-agent-{4 hex chars}` | e.g., `balanced-agent-A7F3`. Regenerates on style change. |
| `prompt` | `"You have not yet been given a goal. Do not call any tools. Do not take any action. Wait for your creator to send you instructions. If no instructions have been received, respond with a single word: "OK"."` | Sent when goal field is empty. Explicit no-op to prevent spurious tool calls or token waste if the user starts the agent before configuring it. |
| `executionDefaults` | `{ mode: 'paper' }` | Resolves to shadow if connection present (existing backend logic). |
| `capital` | `"1000"` | Pre-filled for trading agents. User can change or clear (validation catches empty). |
| Provider/model | From operator `modelDefaults` (fetched via `ai/settings`) | Existing auto-fill behavior. |
| `style` | `'balanced'` | Already the default today. |

## Implementation Steps

### Step 1: Update name generation — DONE

**Files:**
- `apps/web/src/features/agents/agent-name.ts`

**Changes:**
- Replace `generateAgentName(style, counter)` → `balanced-agent-3` with: `generateAgentName(style)` → `balanced-agent-A7F3`.
- Use `crypto.getRandomValues` (browser) to generate 2 random bytes → 4 hex chars (uppercase).
- Drop the sequential counter parameter.
- On style change, regenerate (existing behavior via `nameIsAutoGenerated` flag).

### Step 2: Make skills section always collapsed — DONE

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (CreateAgentFlow, step 'intent')

**Changes:**
- The custom skill picker (currently shown inline when `skillPreset === 'custom'`) becomes a collapsible section that is **always collapsed by default**, regardless of preset.
- Expand label depends on preset:
  - Non-custom preset: **"Edit skills (Optional)"**
  - Custom preset: **"Add skills (Optional)"**
- The "(Optional)" text is styled in a distinct muted/accent color (e.g., `var(--color-text-muted)` or a dedicated `var(--color-optional-label)` — use the same color as other "(Optional)" annotations for consistency).
- When expanded, shows the `SkillPicker` component (same as today).
- The muted skill-name line below the preset selector stays (shows what's auto-selected).

### Step 3: Add "(Optional)" to connection section header — DONE

**Files:**
- `apps/web/src/features/agents/AgentFormBody.tsx` (connection slot rendering)
- Or the parent (`AgentsPage.tsx`) where the connection slot is composed

**Changes:**
- Add "(Optional)" annotation to the connection/platform link section header text.
- Same distinct color as the skills "(Optional)" label.
- No other changes to connection behavior.

### Step 4: Remove goal subtitle on mobile — DONE

**Files:**
- `apps/web/src/features/agents/PromptInputBlock.tsx` (or wherever the "(What should the AI agent do?)" text lives)

**Changes:**
- The subtitle/description text "(What should the AI agent do?)" below the goal label is hidden on mobile viewports.
- Implementation: CSS media query (`@media (max-width: 768px)` or similar breakpoint) to hide it, OR a responsive class.
- On desktop: unchanged, subtitle remains visible.

### Step 5: Remove goal required validation — DONE

**Files:**
- `apps/web/src/features/agents/form-validation.ts`

**Changes:**
- Remove the check: `if (showIntelligence && !intent.goal.trim()) { errors.goal = 'Objective / prompt is required.'; }`
- Goal is no longer required. If empty, the submission handler sends the default prompt.
- All other validation checks remain unchanged (name, capital, venue, connections, bounds checks).

### Step 6: Send default prompt when goal is empty — DONE

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (submission handler in CreateAgentFlow)

**Changes:**
- When building the API payload for `POST /agents`:
  - If `intent.goal` is empty (after trim), send `prompt: "You have not yet been given a goal. Do not call any tools. Do not take any action. Wait for your creator to send you instructions. If no instructions have been received, respond with a single word: \"OK\"."` instead of an empty string.
  - If `intent.goal` is non-empty, send it as `prompt` (existing behavior).
- This ensures the API never receives an empty `prompt` (which would fail the superRefine rule).
- The default prompt is explicit about doing nothing — prevents spurious tool calls and minimizes token usage if the user starts the agent before giving it a real goal.

### Step 7: "(Optional)" label styling — DONE

**Files:**
- CSS file (global styles or a shared component)

**Changes:**
- Define a consistent style for "(Optional)" text across the form:
  - Font size: slightly smaller than the field label (e.g., `0.75rem` or `0.8125rem`).
  - Color: a distinct muted color that's clearly different from the field label but not a warning/error color. Use `var(--color-text-muted)` or define `var(--color-optional-hint)`.
  - Weight: normal (not bold).
- Apply consistently to both the skills section and connection section.

### Step 8: i18n — DONE

**Files:**
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add/update strings:
  - Skills section expand label (preset): "Edit skills (Optional)" / equivalent translations
  - Skills section expand label (custom): "Add skills (Optional)" / equivalent translations
  - Connection section "(Optional)" annotation
- Run the i18n regression test.

## Verification

### Frontend tests
1. Name field pre-fills with `{style}-agent-{hex}` format on form mount.
2. Changing style regenerates the name (when `nameIsAutoGenerated` is true).
3. Skills section is collapsed by default for all presets (trading, personal-assistant, custom).
4. Skills section shows "Edit skills (Optional)" for non-custom presets.
5. Skills section shows "Add skills (Optional)" for custom preset.
6. Skills section expands on click, shows SkillPicker.
7. "(Optional)" text on skills and connection has the distinct muted color.
8. Goal subtitle "(What should the AI agent do?)" is hidden on mobile viewport.
9. Empty goal field does NOT trigger a validation error.
10. Empty goal field results in default prompt being sent to API.
11. Non-empty goal field is sent as-is.
12. Name validation still fires if user clears the pre-filled name.
13. Capital validation still fires if user clears the pre-filled value (trading).
14. All other validation unchanged (venue, connections, bounds).

### Manual / UAT
15. Walk through: open form → select "Trading" → leave everything default → Review → Create → agent created with: auto-generated name, default prompt, paper mode, 1000 capital.
16. Walk through: open form → select "Custom" → expand "Add skills" → pick email skill → leave goal empty → Create → agent created with email skill, default prompt.
17. Walk through: expand skills → deselect a preset skill → name unchanged → Create → works with modified skills.
18. Walk through on mobile: goal subtitle not visible, form still functions.
19. Walk through: clear name field → try to submit → "Name is required" error fires.
20. Walk through: fill in a custom goal → Create → custom goal used as prompt (not the default).

## Risks / Considerations

1. **Users might not notice the collapsible skills section.** Mitigation: the expand label is styled as an interactive element (underline or button-like affordance), and the preset skill names still show in the muted line below the preset selector.

2. **Default prompt wording.** "You have not yet been given a goal..." is explicit about doing nothing. It prevents tool calls and produces a single "OK" token if the agent runs without a real goal. The user never sees this in the form — it only appears on the agent detail page and in the runtime context.

3. **Name generation collision risk.** 4 hex chars = 65,536 possibilities. For a single user creating agents, collisions are astronomically unlikely. Even across all users, the name doesn't need to be globally unique — it's scoped to the user.

4. **"(Optional)" in RTL languages (Arabic).** Ensure the "(Optional)" text placement works in RTL layout. Since it's inline with the section header, standard RTL flow should handle it, but verify during i18n testing.

## Deferred

- Progressive disclosure (tier-1/tier-2 form restructuring).
- One-click "Create Agent" button (empty-body POST).
- Post-creation guidance banner.
- Agent self-management tools.
- Moving defaults to operator config.
