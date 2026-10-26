# 001 — Agent start refused although operator modelDefaults are configured

- **Status:** FIXED (code and automated tests). Manual confirmation pending.
- **Severity:** High
- **Date:** 2026-10-26
- **Discovered:** Agent "noble-kettle" created a child agent "Task Assistant" with `create_child_agent`. The child was not started. Starting it from the web app returned `Agent cannot start — set provider, lightModel, and heavyModel in agent config or user AI settings`.
- **Environment:** local (docker compose), development
- **Components:** `apps/api/src/services/agent-lifecycle-service.ts`, `apps/api/src/routes/agents.ts`, `apps/api/src/routes/telegram-command-handlers.ts`, `apps/api/src/routes/agent-interactivity.ts`
- **Related:** [002 operator modelDefaults not used as fallback (2026-08-26)](../../08/26/002-operator-model-defaults-not-used-as-fallback.md). That fix covered create and runtime launch, but not the start check.

## Summary

Starting an agent is refused when the agent has no model policy and the user has no saved AI settings. The operator's `agentRuntime.llm.modelDefaults` are configured, so the launch would succeed, and create accepts such an agent. Start does not consult those defaults.

## Root Cause

Three layers resolve models differently:

| Layer | Fallback order | Operator defaults |
|---|---|---|
| Create (`POST /agents`) | agent policy → user AI settings → reject | Accepted since the 2026-08-26 fix |
| Worker launch (`resolveEffectiveLlmSelection`) | agent → user → operator | Used |
| Start (`startAgent`, `agent-lifecycle-service.ts`) | agent policy → user AI settings → refuse | **Not consulted** |

`startAgent` checked only the agent policy and the user's settings, so it refused agents that create had accepted. The child path made this common: `create_child_agent` creates children without a model policy and auto-starts them. The auto-start is refused, and the child stays stopped with `startError.code = agent.model_selection_incomplete`.

Before 2026-08-27, create rejected agents without a model, so this combination could not be stored. Agents created with explicit models, or with saved AI settings, were never affected.

## Fix

- `startAgent` takes an optional `operatorModelDefaults` argument and resolves the selection with `resolveEffectiveLlmSelection`, the same helper the worker uses. The check therefore accepts exactly what the worker can launch.
- The operator defaults are passed from `POST /agents/:id/start`, the child auto-start in `POST /agents`, and the Telegram `/start` and `/restart` commands.
- Telegram `handleStart` and `handleRestart` take an optional `operatorModelDefaults` as a fourth argument.

## Verification

- `apps/api` typecheck passes.
- `apps/api/src/routes/agents.test.ts` and `telegram-slash-commands` pass (201 tests). The new case "accepts start when only the operator modelDefaults supply the model selection" covers the fix. The existing 422 case still refuses when no defaults are set.
- Manual, pending: rebuild the API, then start "Task Assistant" (`08e809b6-430f-496b-ae92-653c5f6d6d09`) and confirm it starts.

## Not changed

- A refused start for this reason is not stored on the agent. `last_start_refusal` stays empty, so the reason appears only in the parent's `create_child_agent` result. Recording it is a separate change.
