# Bug Report: The judge ignores the agent's `judgeMaxTokens`, and reasoning tokens are always logged as 0

- **Status:** FIXED in code (not committed); pending live verification on a rebuilt agent image
- **Severity:** Medium. A tick was lost after 225 seconds and 48 tool calls, and the failing call was replayed several times at 65,000 to 75,000 tokens each. A per-agent setting shown in the UI is silently ignored. A workaround exists (an operator can raise `llm.maxTokens` for every agent), so the severity is not High.
- **Date:** 2026-11-17
- **Environment:** local docker compose, agent `job-searcher` (`231a8488-205c-41db-9fbb-a7e9d6beecfe`), model `anthropic/claude-haiku-5.5` through OpenRouter (OpenAI-compatible path), cost preset `premium`, style `balanced`.
- **Related:** `docs/bug-reports/2026/11/17/003-invalid-tool-args-error-names-no-tool-and-gives-no-position-context.md` (the clearer error message that made this visible), `docs/tech/agents/runtime-policy-and-reasoning.md`, evaluation folder `.ignore/eval/2026/11/17/231a8488-205c-41db-9fbb-a7e9d6beecfe/01/`.

## Symptom

The first tick of a new job-search agent ended with `finishReason: "error"` after 225 s and 48 tool calls. The judge LLM call failed five times with `llm.invalid_tool_args`. Each failure was a `set_memory` call that was the third or fourth call in one response and was cut after 29 to 31 characters:

```
Invalid tool arguments for "set_memory" (call toolu_vrtx_01X5…, call 4 of 4): not valid JSON. Expected ',' or '}' after property value in JSON at position 29 (line 1 column 30). The arguments are 29 characters long. The character before it is "\"". The output was probably cut off (token limit); the call was too large for one response. The model finished with reason "length".
```

The retry policy replays the identical request, so the same step failed again (6 retry warnings in about 3 minutes; the successful calls around them used 64,000 to 75,000 tokens each). The next tick recovered from the state saved before the failure.

The log line `LLM response received` reported `thinkingTokens: 0` on every call, although the tick ran at thinking level `deep` (`cost_profile_premium`).

## Investigation (read-only)

**Which limit the judge uses.**
- `apps/worker/src/agent.ts:4319` (`providerConfig.maxTokens`) and `:4327` (`requestBase.maxTokens`), both in the judge's `runStructuredToolLoop`, use `LLM_MAX_TOKENS`.
- `LLM_MAX_TOKENS` is the operator setting `llm.maxTokens` (`config/default.yaml:311`, default 4096). It reaches the agent as an environment variable (`docker-agent-manager.ts:254`) and is read at `agent.ts:126`. The container had `LLM_MAX_TOKENS=4096`.
- The OpenAI-compatible request sends it as `max_tokens` (`packages/llm/src/llm-provider.ts:276`).

**What the agent's policy says.**
- The agent's resolved runtime policy had `judgeMaxTokens: 8192` (style `balanced`; `docs/tech/agents/runtime-policy-and-reasoning.md` lists 4,096, 8,192 and 16,384 for careful, balanced and bold). The UI shows it as "Judge max output tokens".
- Nothing reads it. Every non-test, non-generated hit for `judgeMaxTokens` is a schema, a type (`agent.ts:333`), a UI label or a docs string. The built `apps/worker/dist/agent.js` contains `judgeMaxTokens` 0 times and `maxTokens: LLM_MAX_TOKENS` 5 times.
- The scout does honour its policy: `agent.ts:565` copies `scoutMaxTokens` into `agentRuntimePolicy.llm.scout.maxTokens`, and the scout loop uses it (`scoutLoopConfig.maxTokens`). For the judge, the same block copies only `maxTurns`.

**Why 4096 was too small here.**
- `toReasoningLevel('deep')` returns `high`, and for a Claude model that is not in the effort-based list the request sends `reasoning: { effort: 'high' }` (`resolveReasoningParams`).
- OpenRouter documents that reasoning tokens count against `max_tokens` on Chat Completions, that `effort: high` allocates about 80% of the limit to reasoning, and that a response that spends the budget ends with `finish_reason: "length"`. At `max_tokens: 4096` that leaves roughly 800 tokens for text and tool calls; at 8192, roughly 1,600.
- The cut responses are not stored, so which share was reasoning and which was large writes cannot be measured from the data. Both limit the visible output, and both are helped by applying the agent's own limit.

**Why `thinkingTokens` is 0.**
- On the OpenAI-compatible path the code reads `usage.output_tokens_details.reasoning_tokens` (`llm-provider.ts:390`). OpenRouter's Chat Completions response reports `usage.completion_tokens_details.reasoning_tokens`, so the field is never found.
- `completion_tokens` already includes reasoning tokens. Billing records `llm.output_tokens` from `outputTokens` and `llm.reasoning_tokens` from `thinkingTokens`, and both meters are priced (`reasoningUsdPerM` defaults to the output price). Starting to report reasoning tokens without taking them out of the output count would bill them twice.

**What masked it.** The judge limit equals the previous default, 4096, so nothing looked wrong until a run with reasoning at `high` and several memory writes in one response. The earlier agent (`2cd762a7`) wrote smaller records and did not hit it. The cut was only recognisable as a token limit after bug 003 added the finish reason to the error message.

## Root Cause

1. The policy overlay in `agent.ts` patches the scout's `maxTokens` and the judge's `maxTurns`, but never the judge's output limit, so every judge call uses the operator default regardless of the agent's `judgeMaxTokens`.
2. The OpenAI-compatible path reads reasoning tokens from a field name that Chat Completions does not use, so reasoning is reported as 0.

## Fix

Scope decided with the owner: apply `judgeMaxTokens` to the judge call, and read the reasoning tokens correctly.

1. A pure helper `resolveJudgeMaxTokens(operatorMaxTokens, resolvedPolicy)` (`apps/worker/src/judge-max-tokens.ts`) returns the agent's `judgeMaxTokens` when it has a resolved policy, else the operator value. `agent.ts` computes the judge limit once, in the policy overlay beside the existing scout and `judgeMaxTurns` overlay, and uses it for the judge's `providerConfig.maxTokens`, `requestBase.maxTokens` and the failed-call billing estimate. The hybrid evaluator keeps `LLM_MAX_TOKENS`.
2. `callLlmProvider` (OpenAI-compatible path) reads `completion_tokens_details.reasoning_tokens` first and `output_tokens_details.reasoning_tokens` as a fallback. `outputTokens` becomes `completion_tokens - reasoning_tokens` (visible output), so that output plus reasoning still equals what the provider billed and nothing is billed twice.
3. `config/default.yaml` and `runtime-policy-and-reasoning.md` now say which limit applies to which call.

## Files Changed

- `apps/worker/src/judge-max-tokens.ts` (new) and `apps/worker/src/judge-max-tokens.test.ts` (new): the helper and 3 tests.
- `apps/worker/src/agent.ts`: `judgeMaxTokens`, set in the policy overlay and used in the judge loop (3 places).
- `packages/llm/src/llm-provider.ts`: reads `completion_tokens_details.reasoning_tokens` (fallback `output_tokens_details`); `outputTokens` is `completion_tokens` minus reasoning.
- `packages/llm/src/llm-provider.test.ts`: 6 tests for reasoning tokens on the OpenAI-compatible path.
- `config/default.yaml`: comment on `llm.maxTokens` says which calls it still governs.
- `docs/tech/agents/runtime-policy-and-reasoning.md`: new section "Output token limits".
- `CHANGELOG.md`: two entries under Unreleased, Fixed.

## Verification

- `tsc --build` passes for `@herobids/domain`, `@herobids/llm`, `@herobids/worker` and `@herobids/api` (the root `pnpm lint` checks nothing here: the root tsconfig has `files: []`).
- `npx vitest run apps packages`: 455 files and 8,803 tests pass, including the 9 new tests.
- **A billing side effect was considered and avoided.** Reporting reasoning tokens without taking them out of `outputTokens` would have charged them twice (`llm.output_tokens` and `llm.reasoning_tokens` are both priced; `reasoningUsdPerM` defaults to the output price). A test pins `outputTokens + thinkingTokens === completion_tokens`.
- **Not verified live.** The fix needs the agent image rebuilt and a new agent. To check: (a) a balanced agent's `LLM response received` log shows non-zero `thinkingTokens` for a `deep` tick; (b) no `llm.invalid_tool_args` error with `finish reason "length"` for the same job-search workload; (c) `agent_messages` / billing events show an `llm.reasoning_tokens` event next to `llm.output_tokens` for these calls. The limit actually sent is not logged; it can be read from the request through the provider's own dashboard, or by adding it to the `LLM response received` log if that is wanted.

## Follow-ups (not part of this fix)

- **Reasoning still takes most of the limit.** At `effort: high`, about 80% of the judge's limit is reasoning, so a balanced agent has roughly 1,600 tokens for text and tool calls and a bold agent roughly 3,300. A tool-heavy judge may still be cut. Options: cap reasoning with `reasoning.max_tokens`, lower the judge's effort when many tool calls are expected, or raise `judgeMaxTokens`.
- **Retry replays an identical request** for a failure that is deterministic (`finish_reason: length`). A retry cannot succeed unless something changes; a cheaper policy would stop after the first such failure or retry with a higher limit. Out of scope here (see bug 003's deferred follow-ups).
- **Skill side:** a job-search agent that writes large records in one response is more likely to hit the limit; one record per call keeps each response small. Not changed.
