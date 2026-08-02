# LLM Reasoning-Mode Controls — UI + Provider Modernisation

**Created:** 2026-07-10
**Status:** Done
**Depends on:** none (provider-layer changes are self-contained)

## Problem

Users cannot control how much reasoning (extended thinking) their agents consume. The only thinking-related knobs today are `lightThinkingTokens` and `deepThinkingTokens` in the Runtime Policy section — raw token budgets that are global across scout and judge, opaque to most users, and don't surface in the model-selection UX.

Meanwhile, the provider layer in `packages/llm/src/llm-provider.ts` sends Anthropic thinking controls using a wire format (`{ thinking: { type: "enabled", budget_tokens: N } }`) that is **deprecated** on Claude Opus 4.6+ and **rejected with a 400 error** on Claude Fable 5 / Mythos 5. Both Anthropic and OpenRouter have standardised on a unified `reasoning` request parameter.

Because reasoning tokens are billed as output tokens at the model's normal rate, the cost difference between "no thinking" and "deep thinking" can be 5× or more per judge turn. Users need a simple, model-aware control that:
- works across old and new Claude models
- is independently settable for scout and judge
- inherits from user-level AI settings
- is overridable per agent at create/edit time

### Scout thinking is hard-coded to `none`

The scout loop at `apps/worker/src/agent.ts:2871` sets `thinking: 'none'` unconditionally. While this is intentional (scout only does read-only triage), some modern models do not support disabling reasoning entirely. When a user selects a model that always reasons, `none` maps to the lowest available effort level — the model decides the floor, not us. Users should be aware that reasoning cost is ultimately model-dependent; we do not hardcode warnings or restrictions for specific models as the model landscape evolves rapidly.

## Goal

1. Replace the raw token-budget fields (`lightThinkingTokens` / `deepThinkingTokens`) in the user-facing UI with a **reasoning level** dropdown: `None | Low | Medium | High`.
2. Add reasoning-level controls independently for **scout** and **judge**.
3. Surface reasoning level in **User Settings** (AI Model section) as an inheritable default, and in the **Create/Edit Agent** form as a per-agent override.
4. Modernise `packages/llm/src/llm-provider.ts` to send the unified `reasoning` parameter shape that OpenRouter and Anthropic expect, with model-aware mapping between `effort` (Fable 5, Sonnet 5, Opus 4.7+) and `max_tokens` (older Claude models).
5. Keep the existing `lightThinkingTokens` / `deepThinkingTokens` fields as **operator-only safety caps** in `config/default.yaml` (not user-facing).

## Non-Goals

- Changing the `classifyTickThinking()` auto-escalation logic (regime flips, drawdown, etc.) — that remains as-is, but the user's chosen reasoning level acts as a **ceiling** (system may go lower, never higher).
- Adding thinking controls to the Bot blueprint UX — bots are out of scope.
- Exposing raw `budget_tokens` or `effort` values in the UI.
- Supporting the Anthropic-native API path for adaptive thinking directly (the OpenRouter path handles the translation).
- Per-tick reasoning-level overrides via the agent protocol.

## Design

### Reasoning Level Enum

```typescript
// packages/domain/src/config/schema.ts

export const ReasoningLevelSchema = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;
```

Four levels, deliberately coarse. The backend maps to the appropriate provider-specific wire format based on the resolved model:

| User selects | Older Claude (budget_tokens) | Fable 5 / Sonnet 5 / Opus 4.7+ (adaptive effort) | OpenAI reasoning models |
|---|---|---|---|
| `none` | `reasoning: { max_tokens: 0 }` | N/A — Fable 5 always thinks; send minimal effort | `reasoning: { effort: "none" }` |
| `low` | `reasoning: { max_tokens: lightBudgetTokens }` | `reasoning: { effort: "low" }` | `reasoning: { effort: "low" }` |
| `medium` | `reasoning: { max_tokens: (light+deep)/2 }` | `reasoning: { effort: "medium" }` | `reasoning: { effort: "medium" }` |
| `high` | `reasoning: { max_tokens: deepBudgetTokens }` | `reasoning: { effort: "high" }` | `reasoning: { effort: "high" }` |

### Provider-Layer Modernisation

The current wire format in `packages/llm/src/llm-provider.ts` must be updated to send the unified `reasoning` parameter that OpenRouter expects:

```typescript
// Current (deprecated) — will be replaced
if (config.provider === 'openai') {
  requestBody['reasoning_effort'] = reasoningEffort;  // top-level field
}
// Anthropic native path sends thinking.budget_tokens — also deprecated

// New — unified reasoning parameter
if (request.reasoning) {
  requestBody['reasoning'] = request.reasoning;
}
```

The `LlmRequest` interface gains a new field:

```typescript
export interface LlmRequest {
  // ... existing fields ...
  /** Unified reasoning controls (OpenRouter standard). Replaces the old `thinking` field. */
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    max_tokens?: number;
    enabled?: boolean;
  };
  /** @deprecated — use `reasoning` instead. Kept for backward compat during migration. */
  thinking?: 'none' | 'light' | 'deep';
}
```

The `LlmProviderConfig.thinking` (token budgets) stays — it provides the operator-configured caps that the mapping logic reads from.

A new helper function resolves the correct `reasoning` shape for a given model + level:

```typescript
// packages/llm/src/llm-provider.ts

function resolveReasoningParams(
  level: ReasoningLevel,
  model: string,
  thinkingConfig: LlmProviderConfig['thinking'],
): LlmRequest['reasoning'] {
  if (level === 'none') {
    // For Fable 5 / models that can't disable thinking, use minimal effort
    if (isAdaptiveThinkingOnlyModel(model)) {
      return { effort: 'minimal' };
    }
    return { max_tokens: 0 };
  }
  if (isEffortBasedModel(model)) {
    return { effort: level };
  }
  // Legacy token-budget models
  const tokens = level === 'low'
    ? thinkingConfig?.lightBudgetTokens ?? 2048
    : level === 'medium'
      ? Math.round(((thinkingConfig?.lightBudgetTokens ?? 2048) + (thinkingConfig?.deepBudgetTokens ?? 10240)) / 2)
      : thinkingConfig?.deepBudgetTokens ?? 10240;
  return { max_tokens: tokens };
}
```

Model detection is based on well-known model ID patterns. This is intentionally heuristic — the alternative (live model-capability queries) adds latency and a network dependency in the hot path. When a model is not recognised, the provider layer falls back to `effort`-based reasoning (the safer default for modern models).

#### Computing `medium` for legacy token-budget models

The `medium` reasoning level maps to `Math.round((lightBudgetTokens + deepBudgetTokens) / 2)` for models that use the legacy `max_tokens` parameter. This is computed dynamically from the operator-configured `lightBudgetTokens` and `deepBudgetTokens` caps in `config/default.yaml`. No separate `mediumBudgetTokens` config key is introduced in Phase 1. If finer-grained control is needed, a dedicated `mediumBudgetTokens` field can be added as a follow-up.

### Data Flow

```text
┌──────────────────────────────────────────────────────────┐
│  User Settings (/settings/ai-model)                      │
│  scoutReasoning: "none"    judgeReasoning: "medium"     │
│  → persisted to user_ai_settings.reasoning JSONB        │
└──────────────────────┬───────────────────────────────────┘
                       │ inherits (unless agent overrides)
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Create/Edit Agent form                                  │
│  Reasoning: [inherit ▼] or [none|low|medium|high ▼]     │
│  → saved to agents.runtime_policy_overrides JSONB       │
└──────────────────────┬───────────────────────────────────┘
                       │ worker resolves at session start
                       ▼
┌──────────────────────────────────────────────────────────┐
│  AgentConfig.resolvedRuntimePolicy                       │
│  { scoutReasoning: "none", judgeReasoning: "medium" }    │
│  → injected into AgentRuntimePolicy                     │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Agent tick loop (apps/worker/src/agent.ts)              │
│  scout: reasoning = resolveReasoning("none", lightModel) │
│  judge: ceiling(min(classifyTickThinking(), userLevel))  │
│  → passed as LlmRequest.reasoning                       │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  callLlmProvider() → POST /chat/completions              │
│  { reasoning: { effort: "medium" } }                     │
└──────────────────────────────────────────────────────────┘
```

### Reasoning Level as Ceiling

The `classifyTickThinking()` function in `apps/worker/src/tick-thinking.ts` returns `none | light | deep`. The user's chosen level is a **maximum** — the system can select a lower level but never a higher one:

```typescript
function applyReasoningCeiling(
  systemLevel: TickThinkingLevel,  // from classifyTickThinking
  userLevel: ReasoningLevel,       // from agent config
): TickThinkingLevel {
  const order: Record<TickThinkingLevel | ReasoningLevel, number> = {
    none: 0, low: 1, medium: 2, high: 3, deep: 3, light: 1,
  };
  if (order[systemLevel] <= order[userLevel]) return systemLevel;
  return userLevel === 'none' ? 'none' : userLevel === 'low' ? 'light' : 'deep';
  // 'medium' and 'high' both cap at 'deep' since 'deep' is our max TickThinkingLevel
}
```

For scout: the resolved level is used directly (no auto-escalation for scout). For Fable 5 scout, `none` maps to `effort: "minimal"` — the lowest possible cost, but never zero.

### Schema Changes

#### Domain (`packages/domain/src/config/schema.ts`)

```typescript
// NEW
export const ReasoningLevelSchema = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

// Add to AgentRuntimePolicyOverridesSchema
scoutReasoning: ReasoningLevelSchema.nullable().optional(),
judgeReasoning: ReasoningLevelSchema.nullable().optional(),

// Add to ResolvedAgentRuntimePolicy
scoutReasoning: ReasoningLevel;
judgeReasoning: ReasoningLevel;

// Add to AGENT_STYLE_RUNTIME_DEFAULTS (per style)
// careful:   scoutReasoning: 'none',  judgeReasoning: 'low'
// balanced:  scoutReasoning: 'none',  judgeReasoning: 'medium'
// bold:      scoutReasoning: 'low',   judgeReasoning: 'high'

// KEEP lightThinkingTokens / deepThinkingTokens as operator caps
// (they remain in LlmThinkingConfigSchema, not user-facing)
```

#### API (`apps/api/src/routes/settings.ts`)

Add to `AiModelSettings` response and update payloads:
```typescript
scoutReasoning: ReasoningLevel | null;
judgeReasoning: ReasoningLevel | null;
```

#### API (`apps/api/src/routes/agents.ts`)

Add to agent create/update payloads:
```typescript
scoutReasoning?: ReasoningLevel | null;
judgeReasoning?: ReasoningLevel | null;
```

#### Worker (`apps/worker/src/agent.ts`)

Add to `AgentConfig.resolvedRuntimePolicy`:
```typescript
scoutReasoning?: ReasoningLevel;
judgeReasoning?: ReasoningLevel;
```

#### LLM Provider (`packages/llm/src/llm-provider.ts`)

Add to `LlmRequest`:
```typescript
reasoning?: { effort?: string; max_tokens?: number; enabled?: boolean };
```

Add helper: `resolveReasoningParams(level, model, config)`.

### UI Changes

#### User Settings Page (`apps/web/src/features/settings/SettingsPage.tsx`)

Add two dropdowns below the model selection fields:

```
AI Model
  Provider:    [OpenRouter ▼]
  Economy:     [anthropic/claude-haiku-4-5 ▼]
  Premium:     [anthropic/claude-sonnet-4-6 ▼]
  Scout reasoning:  [None ▼]    ← NEW
  Judge reasoning:  [Medium ▼]  ← NEW
```

#### Create/Edit Agent Form

Add reasoning dropdowns in the model section, with an "Inherit from settings" option:

```
Model Selection
  ○ Use my saved AI model settings (recommended)
  ○ Custom model selection
    Provider:    [OpenRouter ▼]
    Economy:     [anthropic/claude-haiku-4-5 ▼]
    Premium:     [anthropic/claude-sonnet-4-6 ▼]
    Scout reasoning:  [Inherit (None) ▼]    ← NEW
    Judge reasoning:  [Inherit (Medium) ▼]  ← NEW
```

#### Runtime Policy Section

Remove `lightThinkingTokens` and `deepThinkingTokens` from the user-facing numeric fields in `RuntimePolicySection.tsx`. Add `scoutReasoning` and `judgeReasoning` dropdowns instead.

Where: `apps/web/src/features/agents/RuntimePolicySection.tsx`
Change: Remove from `NUMERIC_FIELDS`, add new dropdown fields.

Where: `apps/web/src/features/agents/style-mapping.ts`
Change: Add `scoutReasoning` and `judgeReasoning` to `RuntimePolicyOverrides`, `STYLE_CONFIG`, `AGENT_RUNTIME_DEFAULTS`.

### Configuration (`config/default.yaml`)

The `lightBudgetTokens` and `deepBudgetTokens` stay but gain a comment clarifying they are operator caps, not user-facing:

```yaml
llm:
  thinking:
    # Operator safety caps — NOT user-facing. Users set reasoning level in the UI.
    # These caps apply when the provider layer maps user reasoning levels to
    # budget_tokens for legacy Anthropic models.
    lightBudgetTokens: 2048
    deepBudgetTokens: 10240
```

## Implementation Phases

### Phase 1: Provider-Layer Modernisation

**Files:** `packages/llm/src/llm-provider.ts`, `packages/llm/src/llm-provider.test.ts`

1. Add `reasoning` field to `LlmRequest` interface.
2. Implement `resolveReasoningParams()` with model detection.
3. Update `callOpenAiCompatibleProvider()` to send unified `reasoning` parameter.
4. Remove the deprecated `reasoning_effort` top-level field.
5. Keep backward compat: if `request.thinking` is set but `request.reasoning` is not, map `thinking` to `reasoning` internally.
6. Update unit tests for new parameter shape and model detection.

### Phase 2: Domain Schema

**Files:** `packages/domain/src/config/schema.ts`, `packages/domain/src/config/schema.test.ts`

1. Add `ReasoningLevelSchema` and `ReasoningLevel` type.
2. Add `scoutReasoning` / `judgeReasoning` to `AgentRuntimePolicyOverridesSchema`.
3. Add to `ResolvedAgentRuntimePolicy` interface.
4. Add defaults to `AGENT_STYLE_RUNTIME_DEFAULTS` for all three styles.
5. Add ceilings to `RUNTIME_POLICY_CEILINGS` (e.g. `scoutReasoningMax: 'medium'`, `judgeReasoningMax: 'high'`).
6. Update `resolveAgentRuntimePolicy()`.
7. Add unit tests for schema validation and resolution.

### Phase 3: Worker Runtime

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/tick-thinking.ts`

1. Add `scoutReasoning` / `judgeReasoning` to `AgentConfig.resolvedRuntimePolicy`.
2. Patch into `agentRuntimePolicy` alongside existing runtime policy overlay.
3. Replace hardcoded `thinking: 'none'` on the scout loop with `resolveReasoningParams(scoutReasoning, lightModel, ...)`.
4. Add `applyReasoningCeiling()` to cap `classifyTickThinking()` output with user's judge level.
5. Plumb resolved `reasoning` into the judge's `requestBase`.
6. Update the old `thinking` field on `requestBase` to use the new `reasoning` field.

### Phase 4: API Endpoints

**Files:** `apps/api/src/routes/settings.ts`, `apps/api/src/routes/agents.ts`

1. Add `scoutReasoning` / `judgeReasoning` to AiModelSettings GET/PUT.
2. Add to agent create/update payload validation.
3. Add to agent response serialisation.
4. Persist to `user_ai_settings` and `agents.runtime_policy_overrides` JSONB columns (no migration needed — JSONB is schema-flexible).

### Phase 5: Frontend — User Settings

**Files:** `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/settings/ModelSelectionFields.tsx`, `apps/web/src/features/settings/ai-model-settings.ts`, `apps/web/src/lib/api-client.ts`

1. Add `scoutReasoning` / `judgeReasoning` to `AiModelSettings` and `AiModelSettingsUpdate` types.
2. Add two dropdowns to the AI Model section of Settings page.
3. Wire save/load through existing `aiApi.settings()` query/mutation.
4. Add i18n keys for labels and options.

### Phase 6: Frontend — Agent Create/Edit

**Files:** `apps/web/src/features/agents/EditAgentModal.tsx`, `apps/web/src/features/agents/create-agent-models.ts`, `apps/web/src/features/agents/agent-payloads.ts`, `apps/web/src/features/agents/agent-form-state.ts`

1. Add reasoning fields to agent form state and payload builders.
2. Add dropdowns in the model section with "Inherit from settings" default.
3. Add to `buildCreateAgentPayload()` / `buildUpdateAgentPayload()`.
4. Add i18n keys for labels.

### Phase 7: Frontend — Runtime Policy Section

**Files:** `apps/web/src/features/agents/RuntimePolicySection.tsx`, `apps/web/src/features/agents/style-mapping.ts`

1. Remove `lightThinkingTokens` / `deepThinkingTokens` from `NUMERIC_FIELDS`.
2. Add `scoutReasoning` / `judgeReasoning` as dropdown fields.
3. Update style defaults in `STYLE_CONFIG` and `AGENT_RUNTIME_DEFAULTS`.
4. Add i18n keys.

### Phase 8: Agent Runtime Policy Overrides Page

**Files:** The per-agent runtime policy override page (if separate from the create/edit form).

1. Ensure reasoning dropdowns appear and save correctly.
2. Add to the "reset to style default" logic.

### Phase 9: Integration Testing & Cleanup

1. Run `pnpm lint` and `pnpm test` across all packages.
2. End-to-end test: create agent with custom reasoning → verify the worker receives correct `reasoning` params.
3. Verify Fable 5 model ID is recognised by the model-detection helper.
4. Update `estimateLlmCostUsd()` if needed to account for reasoning tokens more accurately.
5. File bug reports for any edge cases discovered.

## Risks

| Risk | Mitigation |
|---|---|
| Always-on reasoning models (e.g. Fable 5) inflate scout costs when user selects `none` | Scout `none` maps to the lowest available effort for the resolved model (e.g. `effort: "minimal"`). We do not hardcode model-specific warnings — models change, and the mapping is the canonical answer. Users can see their selected reasoning level in the UI; cost is ultimately model-dependent. |
| Model-detection heuristic fails for new/unknown models | Fall back to `effort`-based API (the safer default for modern models). Log a warning and flag for review. |
| Removing `lightThinkingTokens`/`deepThinkingTokens` from UI breaks existing agent configs | Keep the fields in the schema and resolution logic — just stop rendering them in the UI. Existing overrides continue to work; new agents use the reasoning dropdown. |
| Race condition: agent created with old API shape before worker update | The reasoning fields are optional + nullable in all schemas. Missing values fall back to style defaults. |

## Resolved Decisions

1. **No model-specific warnings or restrictions.** Models change — we do not hardcode processes or behaviour to Fable 5 or any other model. The provider-layer mapping from reasoning level to wire format is the single source of truth. If a model always reasons, `none` maps to the lowest available effort and that is the expected behaviour.

2. **`medium` reasoning is computed dynamically.** For legacy token-budget models, `medium` = `Math.round((lightBudgetTokens + deepBudgetTokens) / 2)`. This is documented in the Provider-Layer Modernisation section above. No new operator config key is introduced in Phase 1; a dedicated `mediumBudgetTokens` field can be added as a follow-up if finer control is needed.

3. **Style presets set defaults; user can always override.** When the user selects a style (careful/balanced/bold), we set default reasoning levels per the recommendations below. The user can change these independently at any time — both in User Settings (as an inheritable default) and per-agent (as an override). The style preset is a starting point, not a lock-in.

   | Style | Scout reasoning | Judge reasoning |
   |---|---|---|
   | careful | `none` | `low` |
   | balanced | `none` | `medium` |
   | bold | `low` | `high` |

4. **Per-reasoning-level `max_tokens` caps are a follow-up.** A future operator config key like `reasoningMaxTokens: { low: 4096, medium: 16384, high: 32768 }` would provide a platform-wide safety net for legacy token-budget models. Not needed in Phase 1 — the existing `lightBudgetTokens`/`deepBudgetTokens` caps already serve this purpose, and adaptive-thinking models (Fable 5, Sonnet 5, Opus 4.7+) do not use token budgets at all.
