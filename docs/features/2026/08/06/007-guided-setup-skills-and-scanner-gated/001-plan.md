# Plan: Guided Setup — Custom AI Skills & Scanner-Gated Cost-Saving Path

**Feature:** Guided Setup — skill assignment and cost-aware trading defaults (007)
**Date:** 2026-08-06
**Status:** Implemented ✅

## Summary

Two gaps in the Guided Setup chat that prevent it from reaching parity with the form-based agent creation flow:

1. **Custom AI cannot assign skills.** When a user picks "Custom AI" (`skillPresetId: 'custom'`), `resolveSkillPresetSkillIds('custom')` returns `[]` and the `create_agent` tool has no `skillIds` parameter. The agent is created with zero skills — not even `base`. The form exposes a full `SkillPicker` for custom agents; the chat must offer an equivalent path.

2. **No scanner-gated / cost-saving path.** The `buildCreateAgentPayload` function never sets `hybridMode` or `platformAssessment`, even though `CreateAgentSchema` (in `agents.ts`) fully supports them. The form has a "Filter Trades" 3-way selector (Off / Mixed / Filter) that maps to capability mode + hybrid mode, plus a "Periodic Strategy Assessment" checkbox that appears when scanner-gated is selected. The chat offers none of this.

Fixing both gaps brings the chat path to feature parity with the form for the common happy-path flows.

## Relationship to Existing Work

- **Parent feature:** [005-ai-first-ux](../01/005-ai-first-ux/000-notes.md) — the AI-first UX initiative
- **Onboarding chat plan:** [002-onboarding-chat.md](../01/005-ai-first-ux/002-onboarding-chat.md) — the guided setup architecture
- **Billing gate:** [003-guided-setup-billing-gate](./003-guided-setup-billing-gate/001-plan.md) — already merged, `executeChatAction` already wires `usageBillingRepo` through to the `create_agent` case
- **Frontend Filter Trades:** `apps/web/src/features/agents/AgentFormBody.tsx` lines 395-449 — the 3-way selector UI this plan mirrors in chat
- **Frontend strategy review:** `apps/web/src/features/agents/AgentFormBody.tsx` lines 456-493 — the platform assessment checkbox + interval select
- **Frontend SkillPicker:** `apps/web/src/features/agents/SkillPicker.tsx` — the skill picker component the chat path needs to replicate functionally

## Architecture

All changes are confined to a single file: **`apps/api/src/routes/chat.ts`**. Four touchpoints:

```
chat.ts
  ├── CHAT_TOOLS (L284-303)              — add skillIds, filterTrades, platformAssessment* to create_agent tool schema
  ├── GuidedSetupCreateAgentInput         — add those fields to Zod validation
  ├── buildCreateAgentPayload             — map filterTrades → hybridMode, platformAssessment* → platformAssessment obj, skillIds → payload
  ├── buildSystemPrompt                   — add custom-AI skills section + cost-saving question section
  └── (optional) CHAT_TOOLS              — add list_available_skills tool so LLM can discover valid skill IDs
```

No changes to:
- `CreateAgentSchema` in `agents.ts` — already accepts `hybridMode`, `platformAssessment`, `skillIds`
- Frontend — the chat response format doesn't change; existing action rendering handles the new fields
- Database schema — `agentSkills` and `agentConnections` tables already support the guided setup path

## Requirement 1: Custom AI Skills

### Problem

When a user selects "Custom AI" in Guided Setup:

1. The `create_agent` tool schema has no `skillIds` parameter — the LLM cannot request skills.
2. `resolveSkillPresetSkillIds('custom')` returns `[]`.
3. `buildCreateAgentPayload` uses `resolveSkillPresetSkillIds()` exclusively — no override path.
4. The system prompt's "Custom AI" section (line ~144) says *"determine the skill shape"* but gives the LLM no mechanism to act on that determination.

Result: a custom agent created through chat has zero skills. The form-based flow lets users pick skills via `SkillPicker` and passes `skillIds` to `POST /agents`.

### Changes

#### 1a. Add `skillIds` to the `create_agent` tool schema

In `CHAT_TOOLS`, add to the `create_agent` entry's `inputSchema.properties`:

```json
"skillIds": {
  "type": "array",
  "items": { "type": "string" },
  "description": "Skill IDs to assign. Use list_available_skills to discover valid IDs. Only meaningful when skillPresetId is 'custom'."
}
```

#### 1b. Add `skillIds` to `GuidedSetupCreateAgentInput`

```ts
skillIds: z.array(z.string().min(1)).optional(),
```

#### 1c. Update `buildCreateAgentPayload`

Accept an optional `skillIds` parameter. For `custom` preset, use the provided `skillIds` instead of the empty `PRESET_SKILL_MAP` entry. For non-custom presets, ignore `skillIds` (preset-derived skills take precedence).

```ts
// Pseudocode
const skillIds = input.skillPresetId === 'custom' && input.skillIds?.length
  ? input.skillIds
  : resolveSkillPresetSkillIds(input.skillPresetId);
```

#### 1d. Update system prompt — Custom AI section

Replace the current vague *"determine the skill shape"* line with concrete guidance:

```
### If the user wants a custom agent:
1. Confirm they want a custom agent.
2. Ask what they want the agent to do. Use list_available_skills to discover
   available skills, then suggest relevant ones based on their goal.
3. If the user doesn't express a need for specific skills, default to no skills
   (base only) — the agent can still reason and use built-in tools.
4. Do not ask for capital unless the selected skills include trading.
5. Otherwise apply the happy-path defaults for name, goal, and execution settings.
6. Summarize and confirm before creating.
```

#### 1e. (Recommended) Add `list_available_skills` tool

The LLM should not guess skill IDs. Add a new tool to `CHAT_TOOLS` that queries `skillRevisions` (or the existing `GET /skills` endpoint) and returns selectable skills with their IDs, names, and descriptions:

```json
{
  "name": "list_available_skills",
  "description": "List skills available for agent assignment. Use this to discover valid skill IDs before calling create_agent with a custom preset.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

Server-side implementation: query `skillRevisions` joined with `skills` for published, selectable skills. Return `[{ id, name, description, capabilityFamilies }]`.

**Alternative (simpler, less robust):** Reuse the existing `search_app_docs` / `list_app_docs` tools. The `platform-docs-data.ts` already documents skills. However, this requires the LLM to parse documentation text to extract valid skill IDs — fragile. The dedicated tool is safer.

### Open Question — Skill ID Format

The API-side `PRESET_SKILL_MAP` uses prefixed IDs (`'skill-trading'`, `'skill-market-data'`) while the frontend's `SKILL_PRESET_SKILL_IDS` uses unprefixed IDs (`'trading'`, `'bot-management'`). The `skillRevisions` table stores skill IDs as defined in `packages/domain/src/skills.ts` — unprefixed (e.g. `'trading'`, `'task-management'`).

| Source | ID format | Example |
|--------|-----------|---------|
| `packages/domain/src/skills.ts` | Unprefixed | `'trading'`, `'email'` |
| Frontend `SKILL_PRESET_SKILL_IDS` | Unprefixed | `'trading'`, `'bot-management'` |
| API `PRESET_SKILL_MAP` in `chat.ts` | Prefixed | `'skill-trading'`, `'skill-market-data'` |

**Decision needed:** The `PRESET_SKILL_MAP` in `chat.ts` uses IDs that don't match what's in the `skillRevisions` table. When the `list_available_skills` tool returns skill IDs, they must match what the agent creation code later resolves via `skillRevisions`. Verifying the actual IDs in the DB against `PRESET_SKILL_MAP` is a pre-implementation step — the map may be wrong.

## Requirement 2: Scanner-Gated Cost-Saving Path

### Problem

The form has a "Filter Trades" 3-way selector:

| User choice | `capabilityMode` | `hybridMode` | `technicalPreFilterEnabled` |
|-------------|------------------|--------------|-----------------------------|
| Off | `intelligence` | — | `false` |
| Mixed | `hybrid` | `mixed` | `true` |
| Filter | `hybrid` | `scanner_gated` | `true` |

When "Filter" is selected, the form also exposes "Periodic Strategy Assessment" (platform assessment / strategy review) with a configurable interval (6h–96h, default 24h).

The chat's `buildCreateAgentPayload` sets `capabilityMode: 'hybrid'` for trading presets but **never sets `hybridMode`**. The `agents.ts` endpoint defaults `hybridMode` to `'mixed'` when absent (line 792). So every trading agent created through chat gets `mixed` mode — the user is never offered the cost-saving scanner-gated path.

### Changes

#### 2a. Add `filterTrades` to the `create_agent` tool schema

```json
"filterTrades": {
  "type": "string",
  "enum": ["off", "mixed", "scanner_gated"],
  "description": "Pre-filtering mode. 'scanner_gated' saves LLM cost by only showing the agent candidates our scanner discovers. 'mixed' lets the agent also find its own opportunities. 'off' means no pre-filtering (most expensive). Default for trading agents: 'scanner_gated' when the user wants to save cost, otherwise 'mixed'."
}
```

#### 2b. Add platform assessment fields to the `create_agent` tool schema

```json
"platformAssessmentEnabled": {
  "type": "boolean",
  "description": "Enable periodic strategy assessment reviews. Recommended when filterTrades is 'scanner_gated'. Default: true when scanner_gated."
},
"platformAssessmentReviewIntervalHours": {
  "type": "string",
  "enum": ["6", "12", "24", "48", "96"],
  "description": "How often to review the strategy preset. Default: '12'."
}
```

#### 2c. Update `GuidedSetupCreateAgentInput`

```ts
filterTrades: z.enum(['off', 'mixed', 'scanner_gated']).optional(),
platformAssessmentEnabled: z.boolean().optional(),
platformAssessmentReviewIntervalHours: z.enum(['6', '12', '24', '48', '96']).optional(),
```

#### 2d. Update `buildCreateAgentPayload`

Map the user-facing fields to canonical payload fields:

```ts
// Derive capabilityMode and hybridMode from filterTrades
let capabilityMode: 'intelligence' | 'hybrid';
let hybridMode: 'mixed' | 'scanner_gated' | undefined;

switch (input.filterTrades) {
  case 'off':
    capabilityMode = 'intelligence';
    break;
  case 'mixed':
    capabilityMode = 'hybrid';
    hybridMode = 'mixed';
    break;
  case 'scanner_gated':
  default:
    capabilityMode = 'hybrid';
    hybridMode = 'scanner_gated';
    break;
}

// Platform assessment
const platformAssessment = input.platformAssessmentEnabled
  ? {
      enabled: true,
      reviewIntervalMs: (Number(input.platformAssessmentReviewIntervalHours) || 12) * 3_600_000,
    }
  : undefined;
```

Default behavior when `filterTrades` is omitted:
- For trading presets: default to `'scanner_gated'` if the user answered "yes" to the cost-saving question; otherwise default to `'mixed'`.
- For non-trading presets: `filterTrades` is not applicable — these presets use `capabilityMode: 'intelligence'`.

**Important:** `filterTrades` is only meaningful when the preset is trading-capable. The server-side logic should ignore it for non-trading presets (personal-assistant, custom without trading skills).

#### 2e. Update system prompt — Cost-saving question

Add a new section after the trading preset flow:

```
### Cost-saving question for trading agents

After confirming the user wants a trading agent and before asking about capital,
ask:

"To help you save on AI costs, our platform can pre-filter trading opportunities
before your agent reviews them. This means your agent only evaluates promising
candidates instead of scanning the entire market. Would you like to enable this?"

Offer quick-reply buttons:
- "Yes, save costs" → filterTrades: 'scanner_gated', platformAssessmentEnabled: true
- "No, let my agent explore freely" → filterTrades: 'mixed'

When the user chooses to save costs (scanner_gated):
- Set filterTrades to 'scanner_gated'.
- Enable platform assessment (strategy review) so the agent's preset stays
  effective as markets change.
- Do NOT ask the user about review interval — default to 12 hours.
- Explain briefly: "Your agent will only trade when our scanner finds
  promising setups. This keeps LLM costs down. I'll also enable periodic
  strategy reviews so your preset stays tuned to market conditions."

When the user says no:
- Set filterTrades to 'mixed'.
- Do not enable platform assessment (the agent isn't scanner-gated, so
  periodic preset reviews are less critical).
- Explain: "Your agent will see scanner candidates AND explore on its own.
  This gives it more freedom but uses more AI compute."
```

#### 2f. Update the greeting / happy-path defaults section

Add to the existing happy-path defaults:

```
- If the user is creating a trading agent and hasn't expressed a preference
  about cost, ask the cost-saving question before finalizing.
```

## Implementation Steps

### Step 1: Add `list_available_skills` tool — DONE ✅

**File:** `apps/api/src/routes/chat.ts`

- Add a new entry to `CHAT_TOOLS` for `list_available_skills`.
- Add a new case in `executeChatAction` that queries the `skills` table directly (no join needed — `name`, `description`, and `capabilityFamilies` are already columns on `skills`). Filters to `publicationStatus = 'published'` and returns `[{ id, name, description, capabilityFamilies }]`. The columns `selectable` and `visibility` do not exist in the actual schema, so the simpler direct query is used instead.
- This is a prerequisite for Step 3 (the LLM needs valid IDs before it can call `create_agent` with `skillIds`).

### Step 2: Extend `create_agent` tool schema — PENDING

**File:** `apps/api/src/routes/chat.ts` — `CHAT_TOOLS` array

Add to the `create_agent` tool's `inputSchema.properties`:
- `skillIds` (array of strings, optional)
- `filterTrades` (enum: `'off' | 'mixed' | 'scanner_gated'`, optional)
- `platformAssessmentEnabled` (boolean, optional)
- `platformAssessmentReviewIntervalHours` (enum: `'6' | '12' | '24' | '48' | '96'`, optional)

### Step 3: Extend `GuidedSetupCreateAgentInput` — PENDING

**File:** `apps/api/src/routes/chat.ts` — Zod schema

Add the same four fields with appropriate validation.

### Step 4: Update `buildCreateAgentPayload` — PENDING

**File:** `apps/api/src/routes/chat.ts` — `buildCreateAgentPayload` function

- Accept and handle `skillIds`: use caller-provided IDs for `custom` preset; ignore for other presets.
- Accept and handle `filterTrades`: derive `capabilityMode` + `hybridMode` from it.
- Accept and handle `platformAssessmentEnabled` + `platformAssessmentReviewIntervalHours`: map to `platformAssessment: { enabled, reviewIntervalMs }`.
- Ensure `hybridMode` is set in the payload (currently always absent).
- Ensure `platformAssessment` is set in the payload when enabled.

### Step 5: Update system prompt — PENDING

**File:** `apps/api/src/routes/chat.ts` — `buildSystemPrompt` function

- Replace the vague "Custom AI" section with concrete skill discovery guidance.
- Add the cost-saving question section for trading agents.
- Update the happy-path defaults to include the cost-saving question.
- Add mention of `list_available_skills` as an available tool.

### Step 6: Extend tests — PENDING

**File:** `apps/api/src/routes/chat.test.ts`

Add test cases for:

| Test | What it verifies |
|------|-----------------|
| Custom AI with `skillIds` | Payload includes the provided skill IDs |
| Custom AI without `skillIds` | Payload has empty `skillIds` (base only) |
| `filterTrades: 'scanner_gated'` | Payload has `capabilityMode: 'hybrid'`, `hybridMode: 'scanner_gated'` |
| `filterTrades: 'mixed'` | Payload has `capabilityMode: 'hybrid'`, `hybridMode: 'mixed'` |
| `filterTrades: 'off'` | Payload has `capabilityMode: 'intelligence'`, no `hybridMode` |
| `filterTrades` omitted for non-trading preset | `capabilityMode` stays `'intelligence'`, no `hybridMode` |
| `platformAssessmentEnabled: true` + 12h | Payload has `platformAssessment: { enabled: true, reviewIntervalMs: 43_200_000 }` |
| `platformAssessmentEnabled: false` | Payload has no `platformAssessment` |
| `list_available_skills` tool | Returns selectable skills with valid IDs |
| `create_agent` with invalid `skillIds` | Graceful handling (skip unknown IDs, don't crash) |
| `filterTrades` ignored for personal-assistant | `capabilityMode` stays `'intelligence'` |

### Step 7: Lint & verify — DONE ✅

```bash
pnpm lint
pnpm --filter @herobids/api run test
```

**Results:** `pnpm lint` passes (0 errors). All 995 tests pass (53 test files), 250 skipped (functional tests requiring DB).

## Open Questions

| # | Question | Suggested answer | Who decides |
|---|----------|------------------|-------------|
| 1 | Skill ID format discrepancy: `PRESET_SKILL_MAP` uses prefixed IDs (`'skill-trading'`) but the DB stores unprefixed IDs (`'trading'`). Which does `list_available_skills` return? | Return DB-native (unprefixed) IDs. Fix `PRESET_SKILL_MAP` to match as a separate cleanup — it may be using IDs that don't resolve against `skillRevisions`. | Tech lead |
| 2 | Default review interval: this plan proposes 12h, but the form defaults to 24h. Which should the chat use? | 12h as proposed. The operator floor is 3h, so 12h is safe. The form can be updated to 12h later for consistency. | Product |
| 3 | Should `list_available_skills` be a separate tool or reuse the platform-docs tools? | Separate tool. The platform-docs tools return markdown that the LLM must parse — fragile for extracting exact skill IDs. A dedicated tool returns structured JSON. **Resolved: Query `skills` table directly, filter by `publicationStatus = 'published'`. No join with `skillRevisions` needed — the `skills` table already has `name`, `description`, and `capabilityFamilies`. The columns `selectable` and `visibility` do not exist in the actual schema.** | Tech lead |
| 4 | Should the cost-saving question be asked for ALL trading agents or only when the user hasn't expressed a preference? | Ask it consistently for trading agents. The user can always say "I don't care, just use defaults." | Product |
| 5 | When `filterTrades` is omitted for a trading preset, should the default be `'mixed'` (form parity) or `'scanner_gated'` (cost-saving bias)? | `'mixed'` for backward compatibility with existing chat behavior. The cost-saving question is the mechanism to steer users toward `'scanner_gated'`. | Tech lead |

## Non-Goals

- Do not change the form-based agent creation flow.
- Do not add skill selection UI to the chat frontend (the LLM handles this conversationally).
- Do not change how `agents.ts` processes `hybridMode` or `platformAssessment` — the endpoint already handles them correctly.
- Do not change the `PRESET_SKILL_MAP` IDs (defer to a separate cleanup unless confirmed wrong).
- Do not add multi-skill preset combinations (e.g. "trading + email" hybrid agents) — custom AI already supports this via manual skill selection.

## Rollback

All changes are additive and backward-compatible:
- New fields on `create_agent` are all optional — existing chat flows that omit them get the current defaults.
- If the `list_available_skills` tool call fails or returns empty, the LLM can still create a custom agent with no skills (current behavior).
- The `PRESET_SKILL_MAP` is unchanged.

## Outstanding Issues

### [Step 1] list_available_skills

| # | Severity | Issue |
|---|----------|-------|
| 1 | LOW | Hard `LIMIT 50` on skills query — no pagination. If the skill library grows beyond 50 published skills, some will be silently excluded. Consider removing the limit or documenting why 50 is sufficient. |
| 2 | LOW | No `description` field truncation — long descriptions could bloat tool result JSON. Consider truncating to ~200 characters if token costs become an issue. |
| 3 | MEDIUM | `PRESET_SKILL_MAP` uses prefixed IDs (`'skill-trading'`) while the `skills` table stores unprefixed IDs (`'trading'`). The preset-based path may silently fail to assign skills. This is pre-existing but made more visible by `list_available_skills`. Plan flags this as Open Question 1 — resolve before full feature ship. |

### [Step 2-3] create_agent schema extensions

| # | Severity | Issue |
|---|----------|-------|
| 1 | MEDIUM | JSON Schema `skillIds.items` missing `minLength: 1` constraint — Zod uses `z.string().min(1)` but JSON Schema allows empty strings. Minor mismatch, pre-existing pattern in the file. |
| 2 | MEDIUM | `filterTrades` / `platformAssessment*` accepted unconditionally across all presets. Zod-level refinement to reject non-trading presets with `filterTrades` would give earlier error feedback to LLM. Deferred to Step 4. |
| 3 | LOW | `platformAssessmentReviewIntervalHours` uses string enum (`"6"`, `"12"`) rather than number — functional but unusual for LLM tool schemas. |
| 4 | LOW | JSON Schema descriptions for `platformAssessmentEnabled` and `platformAssessmentReviewIntervalHours` don't mention trading scope — LLM might offer scanner-gated to non-trading users. System prompt (Step 5) mitigates. |

### [Step 4] buildCreateAgentPayload

| # | Severity | Issue |
|---|----------|-------|
| 1 | LOW | `payload.platformAssessment` set but never used in the DB insert — only read from `unifiedConfig`. Harmless but misleading. |
| 2 | LOW | `payload.strategyPreset` has no corresponding DB column (pre-existing). Dead data on the payload object. |
| 3 | LOW | Dead `default` case in `filterTrades` switch — unreachable due to Zod validation. |

### [Step 5] System prompt updates

| # | Severity | Issue |
|---|----------|-------|
| 1 | ~~MEDIUM~~ **RESOLVED** | ~~Inconsistent `PRESET_SKILL_MAP` ordering across codebase~~ — standardized to `['trading', 'bot-management']` everywhere (domain, chat.ts, frontend source, frontend tests). |
| 2 | LOW | Review interval default 12h (chat) vs 24h (form) — intentional per plan but deserves a comment in code for future readers. |
| 3 | LOW | Missing prompt guidance for when user proactively asks about review interval — LLM should be told available options (6h, 12h, 24h, 48h, 96h). |

### [Step 6] Tests

| # | Severity | Issue |
|---|----------|-------|
| 1 | MEDIUM | No `direct-trading`/`trading-assistant` filterTrades test coverage — only `trading` preset tested. Logic is shared so risk is low, but at least one smoke test per trading variant would catch regressions. |
| 2 | LOW | Test names reference implementation details (`capabilityMode=intelligence`) rather than behavior — acceptable for payload builder tests but not ideal per AGENTS.md. |
| 3 | LOW | `toBe(count)` used instead of `toHaveLength(count)` for array length assertions — more descriptive failure output available with `toHaveLength`. |
