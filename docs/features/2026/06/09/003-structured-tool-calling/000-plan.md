# Structured Tool Calling Runtime Wiring

**Status:** done
**Depends on:** ../001-tool-registry/000-note.md
**Blocks:** ../002-scout-tools/000-note.md

## Goal

Wire the registry-generated tool schemas into the model-facing runtime so scout and judge use structured tool calling instead of prompt-parsed JSON. Keep the existing runtime gates, parameter validation, and reasoning-text stripping, but stop relying on assistant text as the transport for tool calls.

## Why This Comes First

`001-tool-registry` already added schema generation in `apps/worker/src/tools/registry.ts`, but the active runtime path still only exposes tool names in prompt text and parses `{"tool": ..., "args": ...}` from assistant output in `apps/worker/src/agent.ts`. `002-scout-tools` should land after this wiring, otherwise scout tools will be built on the same partial mechanism.

## Plan

1. Define the structured tool-calling contract at the `@herobids/llm` boundary.
   Files: `packages/llm/src/llm-provider.ts`, `packages/llm/src/index.ts`, `packages/domain/src/tools.ts`, `apps/worker/src/tools/registry.ts`.
   Change: add provider-neutral request/response types for tool definitions, tool calls, and tool results. Keep `AgentTool` and runtime validation unchanged; only formalize how schemas and tool calls move between the worker and the LLM client.
   Dependency: none.
   Risk/open question: decide whether the registry should keep returning OpenAI-shaped definitions or switch to a provider-neutral `{ name, description, inputSchema }` shape and let `@herobids/llm` translate per provider.

2. Extend the shared LLM client to send and receive structured tools.
   Files: `packages/llm/src/llm-provider.ts`, `packages/llm/src/llm-provider.test.ts`.
   Change: extend `LlmRequest` with optional tool definitions and any needed tool-choice flag; extend `LlmResponse` with normalized tool-call data. Implement request/response mapping for the providers supported in the first slice. Preserve `stripReasoningContent()` so hidden thinking never leaks into stored history or tool parsing.
   Dependency: step 1.
   Risk/open question: first-slice provider support must be explicit. OpenAI-compatible providers are the cheapest path; Anthropic support is feasible but needs separate request/response mapping. Unsupported providers should not silently fall back to prompt-parsed JSON.

3. Move judge execution from text-parsed tool calls to a structured tool loop.
   Files: `apps/worker/src/agent.ts`, `apps/worker/src/runtime-errors.ts`, `apps/worker/src/runtime-errors.test.ts`, optionally a new helper such as `apps/worker/src/tool-call-loop.ts` if extraction is needed for testability.
   Change: replace the `parseToolCalls()`-driven judge path with a bounded loop that:
   - derives visible tool definitions from `toolRegistry` plus `allowedTools()`
   - sends those definitions in the LLM request
   - executes returned tool calls through the existing `executeTool()` gate
   - appends tool results back into the next LLM turn using the provider-normalized message format
   - exits when the model returns visible text without tool calls or hits the loop cap
   Dependency: step 2.
   Risk/open question: if `agent.ts` becomes too hard to validate in place, extract the loop into a small helper first rather than widening the existing file further.

4. Decouple prompt composition from the old JSON tool-call instruction.
   Files: `apps/worker/src/runtime-composition.ts`, `apps/worker/src/runtime-composition.test.ts`, `apps/worker/src/scout-dispatch.ts`, `apps/worker/src/scout-dispatch.test.ts`.
   Change: keep a human-readable tool availability summary in prompts, but remove instructions that tell the model to emit freeform JSON tool calls. The prompt should describe what tools are available, not define the transport protocol.
   Dependency: step 3.
   Risk/open question: `maxVisibleToolSchemas` currently limits visible tool names. Confirm whether it should remain a count of visible tools or be renamed for clarity once schemas are sent out-of-band.

5. Implement scout tools on top of the structured tool path.
   Files: `apps/worker/src/agent.ts`, `apps/worker/src/scout-dispatch.ts`, `apps/worker/src/tools/registry.ts`, `apps/worker/src/runtime-tool-visibility.ts`.
   Change: derive scout tool definitions from `toolRegistry.getReadOnlyToolNames()` filtered through `allowedTools()`, then run scout in a bounded read-only tool loop before the final hold/escalate decision. Keep the existing defense-in-depth check so scout cannot execute write or execute-category tools even if the model attempts it.
   Dependency: steps 2 through 4.
   Risk/open question: single-turn scout with one tool round is simpler, but a bounded multi-turn loop is more faithful to the feature note because scout may need more than one read before deciding.

6. Add regression coverage for the new transport and failure modes.
   Files: `packages/llm/src/llm-provider.test.ts`, `apps/worker/src/runtime-errors.test.ts`, `apps/worker/src/runtime-composition.test.ts`, `apps/worker/src/scout-dispatch.test.ts`, plus targeted worker tests around the judge/scout tool loop.
   Change: cover provider request shaping, normalized tool-call parsing, reasoning-text stripping, allowed-tool filtering, read-only scout enforcement, retry behavior with tool-enabled requests, and prompt cleanup.
   Dependency: steps 2 through 5.
   Risk/open question: `apps/worker/src/agent.ts` is large; if direct unit coverage is awkward, extract the tool loop into a helper and test that helper rather than relying on broad end-to-end worker tests.

## Test Strategy

- Unit tests:
  - `packages/llm/src/llm-provider.test.ts` for provider-specific request/response translation, reasoning stripping, and normalized tool-call extraction.
  - `apps/worker/src/runtime-composition.test.ts` and `apps/worker/src/scout-dispatch.test.ts` for prompt text changes and scout prompt behavior.
- Worker-slice integration tests:
  - `apps/worker/src/structured-tool-loop.test.ts` for tool-call execution, loop termination, and tool-result reinjection.
- Validation command:
  - `pnpm lint`

## Decisions

1. The registry and worker use a provider-neutral tool schema, and `@herobids/llm` translates it to provider wire formats.
2. The shared LLM boundary supports structured tools for OpenAI-compatible providers and Anthropic.
3. Scout uses a bounded multi-turn read-only loop, not prompt-parsed JSON tool calls.
4. The old JSON tool-call instruction has been removed from the main runtime prompt; tools are transported separately.

## Exit Criteria

- Judge tool execution no longer depends on parsing freeform JSON out of assistant text.
- Scout receives executable read-only tool definitions through the same structured path.
- System prompts no longer instruct the model to emit `{"tool": ..., "args": ...}` as the primary tool transport.
- Hidden thinking text remains excluded from visible content, stored history, and tool parsing.
- `pnpm lint` passes and focused `vitest` coverage exists for the new tool-calling path.

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-06-09 | Plan runtime structured tool wiring before scout tool enablement. | `002-scout-tools` depends on a model-facing tool transport; the current runtime still uses prompt-level tool names plus text-parsed JSON. |
| 2026-06-09 | Implemented provider-neutral tool schemas, structured tool transport, and bounded scout/judge tool loops. | This removed the prompt-parsed JSON transport and made scout/judge use the same structured path. |
