# 002 — Operator modelDefaults not used as fallback for agent creation or runtime launch

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-26
- **Discovered:** User attempted to create an agent via the web UI. The API returned `{ error: 'validation_error', details: [{ path: ['provider'], message: 'Provider is required ...' }] }`. The frontend displayed "Request validation failed." with no actionable detail.
- **Environment:** local (docker compose), development
- **Components:** `apps/api/src/routes/agents.ts`, `packages/domain/src/llm-selection.ts`, `apps/worker/src/agents/agent-session-manager.ts`

## Summary

Agent creation fails with "Request validation failed" when the user has not saved AI model settings, even though the operator has configured `agentRuntime.llm.modelDefaults` in `config/default.yaml`. The operator model defaults are only used as UI form hints — they are never consulted as a runtime fallback during agent creation or agent launch.

## Root Cause

The operator's `modelDefaults` config (`agentRuntime.llm.modelDefaults`) was designed as a UI-only hint. Two comments explicitly stated this:

- `config/default.yaml`: *"They are NOT used as runtime fallbacks — agents must have explicit models."*
- `packages/domain/src/config/schema.ts`: *"They are NOT used as runtime fallbacks — agents must have explicit model selection."*

This created a gap in the model resolution chain at two layers:

### 1. Agent creation (`POST /agents`)

The validation chain was: agent model policy -> user saved AI settings -> **reject**. The operator's `modelDefaults` were never consulted. When a user with no saved AI settings created an agent without explicitly selecting a provider, the API returned a 400 even though the operator had valid defaults configured.

The chat/guided-setup route (`chat.ts`) already had the correct fallback — it explicitly fell back to `operatorDefaults` when `userAiConfig` was null. The form-based `POST /agents` route was never given the same treatment.

### 2. Agent runtime launch (`resolveEffectiveLlmSelection`)

The runtime model resolution chain was: agent config -> user model defaults -> **done (null)**. Without an operator tier, agents created without explicit models (e.g. via the chat route which allows it) would fail the pre-launch validation in `AgentSessionManager` with `config.model_selection_incomplete`.

### 3. Agent message broker (bot LLM resolution)

The `AgentMessageBroker` resolves LLM models for bot decisions using the same `resolveEffectiveLlmSelection`. It also lacked the operator fallback tier.

## Impact

- New users who have not visited Settings cannot create agents at all — the form submits, the API rejects, and the frontend shows "Request validation failed." with no explanation of what's missing.
- Agents created via the chat route (which does fall back to operator defaults) could fail to launch if the user later clears their AI settings.
- The frontend auto-selects operator defaults in the model dropdown, but if the `availableModelsQuery` hasn't resolved before the user clicks Create, the provider field is empty and the payload omits it.

## Fix

Added operator `modelDefaults` as a third fallback tier across all three layers:

### 1. `POST /agents` route — creation-time validation

**File:** `apps/api/src/routes/agents.ts`

Added `operatorModelDefaults` parameter to `agentRoutes()`. The provider validation now checks: agent model policy -> user saved AI settings -> operator modelDefaults -> reject.

### 2. `resolveEffectiveLlmSelection` — runtime model resolution

**File:** `packages/domain/src/llm-selection.ts`

Added `OperatorModelDefaults` interface and `operatorModelDefaults` field to `AgentLlmSelectionInput`. The resolution chain is now: agent config -> user defaults -> operator defaults -> null.

### 3. Threading through the worker

**Files:** `apps/worker/src/agents/agent-session-manager.ts`, `apps/worker/src/agents/agent-message-broker.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/index.ts`

- `AgentSessionManagerConfig` — added `operatorModelDefaults` field.
- Pre-launch validation — passes operator defaults to `resolveEffectiveLlmSelection`.
- Agent container config JSON — forwards `operatorModelDefaults` so the container runtime can also fall back.
- `AgentMessageBroker` — added `operatorModelDefaults` constructor param, passes to `resolveEffectiveLlmSelection` for bot LLM resolution.
- Worker composition root — threads `appConfig.agentRuntime.llm.modelDefaults` to both the session manager and message broker.

### 4. Documentation

**Files:** `config/default.yaml`, `packages/domain/src/config/schema.ts`

Updated comments from "NOT used as runtime fallbacks" to accurately describe the new semantics: operator defaults are the final fallback tier when neither agent nor user has explicit selection.

## Files Changed

- `apps/api/src/routes/agents.ts` — added `operatorModelDefaults` param, updated provider validation fallback
- `apps/api/src/index.ts` — passes `appConfig.agentRuntime.llm.modelDefaults` to `agentRoutes()`
- `packages/domain/src/llm-selection.ts` — added `OperatorModelDefaults` interface and third fallback tier
- `packages/domain/src/config/schema.ts` — updated `ModelDefaultsSchema` JSDoc
- `apps/worker/src/agents/agent-session-manager.ts` — added config field, passes to `resolveEffectiveLlmSelection`
- `apps/worker/src/agents/agent-message-broker.ts` — added constructor param, passes to `resolveEffectiveLlmSelection`
- `apps/worker/src/agent.ts` — added `operatorModelDefaults` to agent config interface
- `apps/worker/src/llm-selection.ts` — re-exports `OperatorModelDefaults`
- `apps/worker/src/index.ts` — threads `modelDefaults` to session manager and message broker
- `config/default.yaml` — updated `modelDefaults` comment

## Verification

- `pnpm lint` passes (zero errors).
- `llm-selection.test.ts`: 6/6 passed.
- `agents.test.ts`: 118/119 passed (1 pre-existing failure unrelated to this change).
- `agent-session-manager.test.ts`: 64/64 passed.
- Manual reproduction: `POST /agents` with no provider and no saved user AI settings now succeeds when operator `modelDefaults.provider` is set.
