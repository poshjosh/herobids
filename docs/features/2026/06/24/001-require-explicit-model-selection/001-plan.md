# REQUIRE EXPLICIT MODEL SELECTION

## Scope

Remove all operator-level default model fallbacks for the agent runtime. Require that every agent session has explicit `provider`, `lightModel`, and `heavyModel` — sourced from either the agent's own config or the user's saved AI settings. If neither specifies models, the agent refuses to start.

This plan intentionally excludes:

1. Changes to the `/ai/generate-config`, `/ai/analyze-portfolio`, and `/ai/explain-signal` API routes — these are non-agent LLM calls that legitimately use `llm.provider` / `llm.model` as the operator's platform-default model.
2. Removing `llm.provider` / `llm.model` from operator config entirely — those fields remain for non-agent API-layer LLM calls and as the `LLM_PROVIDER` env var forwarded to containers (used for API key resolution).
3. UI changes — the Settings page and agent create/edit flows already support `provider`, `lightModel`, `heavyModel`. This plan only tightens enforcement.

## Current State

1. `resolveEffectiveLlmSelection()` in `apps/worker/src/llm-selection.ts` has a three-tier fallback: agent config → user defaults → operator defaults (`LLM_MODEL` env var + `resolveDefaultScoutModel()`).
2. `resolveDefaultScoutModel()` in `apps/worker/src/scout-dispatch.ts` is a switch on three providers (anthropic, openai, openrouter) with a `default: return judgeModel` branch that silently collapses scout and judge to the same model.
3. `DEFAULT_SCOUT_MODELS` constant in `scout-dispatch.ts` is dead code — unreachable in production because the caller always passes config-sourced defaults.
4. `LlmScoutConfigSchema` in `packages/domain/src/config/schema.ts` defines `defaultModels` with Zod defaults for three providers — duplicating values already in `config/default.yaml`.
5. `config/default.yaml` has `llm.scout.defaultModels` (per-provider map) and `llm.model` (flat string) — asymmetric shapes for the same concept.
6. `CreateAgentSchema` and `UpdateAgentSchema` in `apps/api/src/routes/agents.ts` treat `provider`, `lightModel`, and `heavyModel` as fully optional.
7. Agent container startup reads `LLM_MODEL` env var with a hardcoded fallback `?? 'claude-sonnet-4-5'` as the ultimate safety net.

## Target State

1. `resolveEffectiveLlmSelection()` resolves from agent config → user defaults. No operator fallback. Returns `null` fields when unresolved.
2. Agent container startup validates that `provider`, `lightModel`, and `heavyModel` are all resolved. Fails fast with a clear error if any is missing.
3. `resolveDefaultScoutModel()` and `DEFAULT_SCOUT_MODELS` are deleted.
4. `LlmScoutConfigSchema.defaultModels` is removed from the schema.
5. `llm.scout.defaultModels` is removed from `config/default.yaml`.
6. The API rejects agent creation/start when the effective model selection is incomplete (no agent override + no user defaults).
7. `LLM_MODEL` env var remains in agent containers (for `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS` forwarding and API key resolution via `LLM_PROVIDER`), but is no longer used as a model selection fallback.

## Implementation Plan

### T1: Remove `resolveDefaultScoutModel` and `DEFAULT_SCOUT_MODELS`

**Effort:** Small
**Depends on:** None

- Delete `DEFAULT_SCOUT_MODELS` constant from `apps/worker/src/scout-dispatch.ts`.
- Delete `resolveDefaultScoutModel()` function from `apps/worker/src/scout-dispatch.ts`.
- Remove the export from any barrel files if re-exported.
- Delete `apps/worker/src/scout-dispatch.test.ts` `resolveDefaultScoutModel` describe block (the `buildScoutSystemPrompt` and `parseScoutDecision` tests remain).
- Update imports in `apps/worker/src/llm-selection.ts` to remove `resolveDefaultScoutModel`.

**Files:** `apps/worker/src/scout-dispatch.ts`, `apps/worker/src/scout-dispatch.test.ts`, `apps/worker/src/llm-selection.ts`
**Acceptance:** No references to `resolveDefaultScoutModel` or `DEFAULT_SCOUT_MODELS` remain in the codebase. `pnpm lint` passes.

---

### T2: Remove `defaultModels` from schema and operator config

**Effort:** Small
**Depends on:** T1

- Remove `defaultModels` field from `LlmScoutConfigSchema` in `packages/domain/src/config/schema.ts`. The schema becomes:
  ```typescript
  export const LlmScoutConfigSchema = z.object({
    maxHoldDurationMs: z.number().int().min(0).optional(),
  });
  ```
- Remove `llm.scout.defaultModels` from `config/default.yaml`.
- Update `apps/worker/src/config.test.ts` — remove the test `'applies Zod defaults for llm.scout.defaultModels when omitted'` and any assertions on `config.llm.scout.defaultModels`.
- Remove `defaultScoutModels` from `AgentRuntimePolicySchema` if it references `LlmScoutConfigSchema.defaultModels`.

**Files:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/config.test.ts`
**Acceptance:** No references to `defaultModels` or `defaultScoutModels` remain in config schemas or YAML. `pnpm lint` passes.

---

### T3: Rewrite `resolveEffectiveLlmSelection` — no operator fallback

**Effort:** Medium
**Depends on:** T1, T2

Replace the function in `apps/worker/src/llm-selection.ts`:

- Remove `operatorProvider`, `operatorHeavyModel`, and `defaultScoutModels` parameters.
- The function resolves from agent config → user defaults only.
- Return type changes: all three fields become `string | null` to signal unresolved.
  ```typescript
  export interface ResolvedLlmSelection {
    provider: string | null;
    lightModel: string | null;
    heavyModel: string | null;
  }
  ```
- Rewrite `apps/worker/src/llm-selection.test.ts` to cover:
  - Agent override wins over user defaults.
  - User defaults used when agent has no override.
  - Returns `null` fields when neither agent nor user specifies them.
  - Empty strings treated as absent.

**Files:** `apps/worker/src/llm-selection.ts`, `apps/worker/src/llm-selection.test.ts`
**Acceptance:** `resolveEffectiveLlmSelection` has no operator/scout-default fallback. Tests prove null propagation. `pnpm lint` passes.

---

### T4: Fail fast in agent container startup

**Effort:** Medium
**Depends on:** T3

Update `apps/worker/src/agent.ts`:

- After calling `resolveEffectiveLlmSelection()`, validate all three fields are non-null.
- If any is null, log a fatal error and exit:
  ```typescript
  if (!resolvedProvider || !resolvedLightModel || !resolvedHeavyModel) {
    logger.fatal({
      provider: resolvedProvider,
      lightModel: resolvedLightModel,
      heavyModel: resolvedHeavyModel,
    }, 'Incomplete LLM model selection — set provider, lightModel, and heavyModel in agent config or user AI settings');
    process.exit(1);
  }
  ```
- Remove the `operatorHeavyModel: LLM_MODEL` and `defaultScoutModels: agentRuntimePolicy.llm.scout.defaultModels` arguments from the `resolveEffectiveLlmSelection` call.
- Keep `LLM_MODEL` env var read — it is still used by `docker-agent-manager.ts` for forwarding, and may be used by future non-agent paths. But it no longer participates in model selection.
- Remove the hardcoded `?? 'claude-sonnet-4-5'` fallback from the `LLM_MODEL` env var read. If `LLM_MODEL` is unset, it should be `undefined` — this variable is no longer a model selection input.

**Files:** `apps/worker/src/agent.ts`
**Acceptance:** Agent container refuses to start when model selection is incomplete. Existing model selection paths (agent config, user defaults) still work. `pnpm lint` passes.

---

### T5: API-level validation — reject incomplete model selection on agent start

**Effort:** Medium
**Depends on:** T3

When the worker's `agent-session-manager.ts` builds the `agentConfig` payload for a container, validate that the effective selection is complete before launching:

- In `apps/worker/src/agents/agent-session-manager.ts`, after extracting `provider`, `lightModel`, `heavyModel` from `modelPolicy` and `userModelDefaults`:
  - Compute the effective selection (same priority: agent → user).
  - If any field is missing, skip the agent start and log a warning.
  - Emit a session error event so the UI can surface "model selection required".
- This is the **first gate** — prevents launching a container that would immediately crash.

**Files:** `apps/worker/src/agents/agent-session-manager.ts`
**Acceptance:** Agents with incomplete model selection are not launched. A clear error is surfaced.

---

### T6: Update cost-profile to remove model defaulting

**Effort:** Small
**Depends on:** T3

In `apps/worker/src/cost-profile.ts`:

- `AgentCostProfileInput.heavyModel` and `lightModel` are already `string` (non-optional). No schema change needed.
- The `minimal` preset logic (`heavyModel: lightModel`) is a **cost behavior**, not a model default — it intentionally collapses both to the light model for cost savings. This stays.
- The `custom` preset logic (`(input.dailyBudgetUsd ?? 5) <= 3 ? lightModel : heavyModel`) similarly stays — it's budget-driven, not provider-driven.
- Update `apps/worker/src/cost-profile.test.ts` if any test relies on `resolveDefaultScoutModel` or operator defaults feeding into cost profile inputs.

**Files:** `apps/worker/src/cost-profile.ts`, `apps/worker/src/cost-profile.test.ts`
**Acceptance:** Cost profile tests pass with explicit model inputs. No implicit model derivation. `pnpm lint` passes.

---

### T7: Clean up `LLM_MODEL` env var semantics

**Effort:** Small
**Depends on:** T4

- In `apps/worker/src/agent.ts`, update the inline comment for `LLM_MODEL` to clarify it is an operator infrastructure field (API key resolution, non-agent LLM calls), not a model selection fallback.
- In `apps/worker/src/agents/docker-agent-manager.ts`, keep forwarding `LLM_MODEL` — it is used by `LLM_PROVIDER` to resolve API keys.
- In `apps/worker/src/index.ts`, `appConfig.llm.model` remains the worker-level default for non-agent LLM calls and container forwarding. No change needed.
- In `config/default.yaml` and `config/production.yaml`, rename inline comments to clarify `llm.model` is the operator platform model for non-agent API calls, not the agent judge model.

**Files:** `apps/worker/src/agent.ts`, `config/default.yaml`, `config/production.yaml`, `config/staging.yaml`
**Acceptance:** Comments are accurate. No behavioral change. `pnpm lint` passes.

---

### T8: Update production config — differentiate heavy/light models

**Effort:** Small
**Depends on:** T7

- In `config/production.yaml`, update `llm.model` comment to reflect its new role (non-agent platform model, not judge fallback).
- No `llm.scout.defaultModels` entry needed (removed in T2).

**Files:** `config/production.yaml`
**Acceptance:** Production config is self-documenting and consistent with the new architecture.

---

## Test Strategy

1. **Unit tests** (T1–T6)
   - `apps/worker/src/llm-selection.test.ts` — null propagation, no fallback
   - `apps/worker/src/scout-dispatch.test.ts` — scout model default tests removed
   - `apps/worker/src/cost-profile.test.ts` — explicit model inputs only
   - `apps/worker/src/config.test.ts` — no `defaultModels` assertions

2. **Validation command sequence**
   - `pnpm lint`
   - `pnpm test`

## Risks

1. **Users without AI settings configured.** If a user has never visited Settings to configure their AI models and creates an agent without specifying models, the agent will fail to start. This is the intended behavior — the failure message should direct them to configure models.

2. **Existing agents in the database.** Agents created before this change that have no `lightModel`/`heavyModel` in their `modelPolicy` will fail to start on next session. This is acceptable per the "no backward compatibility" constraint.

3. **`llm.model` / `llm.provider` still used for non-agent paths.** The API routes (`/ai/generate-config`, `/ai/analyze-portfolio`, `/ai/explain-signal`) still fall back to operator config when the user has no AI settings. This is correct — those are platform-level LLM calls, not agent decisions.
