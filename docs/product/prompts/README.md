# LLM Prompt Inventory

This directory documents the prompt shapes currently generated for LLM calls in the Herobids codebase.

These files are source-derived templates, not captured runtime dumps. Placeholders such as `{{agent_name}}` or `{{normalized_goal}}` mark values injected at runtime. Optional sections are called out where the source conditionally renders them.

## Prompts

- [agent-judge-system-prompt.md](./agent-judge-system-prompt.md) - The judge phase system prompt assembled in the worker each tick.
- [agent-scout-system-prompt.md](./agent-scout-system-prompt.md) - The scout phase system prompt used to decide hold versus escalate.
- [agent-scout-user-prompt.md](./agent-scout-user-prompt.md) - The scout phase user-role message, including full-context and context-diff modes.
- [agent-judge-user-prompt.md](./agent-judge-user-prompt.md) - The judge phase user-role message built from full runtime context plus escalation reason and recent history.
- [strategy-llm-prompt.md](./strategy-llm-prompt.md) - The strategy package prompts used by `LlmStrategy` for direct market-snapshot decisions.

## Notes

- Judge system prompt source: `apps/worker/src/runtime-composition.ts` via `buildSystemPrompt(...)`.
- Scout system prompt source: `apps/worker/src/scout-dispatch.ts` via `buildScoutSystemPrompt(...)`.
- Scout and judge user-role messages are assembled in `apps/worker/src/agent.ts` using `buildTickUserContext(...)` from `apps/worker/src/runtime-composition.ts` and `buildIncrementalContext(...)` from `apps/worker/src/context-diff.ts`.
- The strategy prompt source lives in `packages/strategy/src/llm.ts`.