# Bug Report: `provider.invalid_tool_args` names no tool and gives no context, so the failing call cannot be diagnosed

- **Status:** OPEN. Draft for review. No code has been changed. The scope of this report is **error messages only** (see "Scope").
- **Severity:** Medium. The failure itself is High (it ended 7 of 18 ticks on staging), but this report only covers the missing diagnostics. The failure behaviour is deliberately not changed here.
- **Date:** 2026-11-17
- **Environment:** staging, agent `job-searcher` (`8365d836-7e09-470c-bbf0-06f69f3848b7`), model `anthropic/claude-haiku-5.5` through the OpenAI-compatible (OpenRouter) request path.
- **Related:** `docs/bug-reports/2026/11/17/001-staging-agents-run-stale-pinned-agent-image.md` (Outstanding Issues), `docs/features/2026/11/17/001-continuation-guard/plan.md`.

## Scope

**In scope:**
- Make the error produced for malformed tool-call arguments say which tool, which call, what is wrong and where. The message must not contain an excerpt of the arguments (owner decision, 2026-11-17).
- Read `finish_reason` on the OpenAI-compatible path so the message can say when the output was cut off (owner decision: allowed, "or whatever you need to do" within message scope).
- Log a warning when a tool call in a model reply is dropped because it has no usable name or is not an object (owner decision: yes). See "Silent drops".
- A verdict on whether hard-coded call signatures in other error messages can cause this problem.

**Out of scope (decided by the owner, not to be done in this change):**
- Any change to what happens after the error: no corrective retry, no feeding the error back to the model, no change to `callLlmWithRetry`, the retry count, or tick failure handling.
- Skill-side guidance (for example appending JSONL instead of rewriting JSON files).
- Switching the model.

Those are listed under "Deferred follow-ups" so they are not lost.

## Symptom

7 of 18 ticks for this agent ended with `agent.llm.completed` `finishReason: "error"` and this stored message (the only information available):

```
Expected ',' or '}' after property value in JSON at position 36 (line 1 column 37)
```

(Other occurrences: positions 43 and 47.) Six of the seven failed ticks had already made 13 to 26 tool calls (the seventh, a reply to a user message, had made 6). The message does not say which tool the model was calling, which of its tool calls was bad, how long the arguments were, what the character at the failing position was, or whether the output was cut off.

Because of that, it is not possible to tell whether the cause is (a) an unescaped quote inside a JSON-in-a-string argument (the agent stores state as JSON files through `write_file`; position 36 to 47 is just where the file content would start), (b) output cut off at the token limit, or (c) something else. The current theory for (a) is only a guess.

## Investigation (read-only)

**Where the error is made.**
- `packages/llm/src/llm-provider.ts`, `parseToolArgs(rawArguments)` (about line 795): `asToolArgs(JSON.parse(rawArguments))`. It is called from `normalizeOpenAiToolCalls` (about line 755 to 775) for each tool call in `choices[0].message.tool_calls`. The call has `function.name` and an `id` available at that point, and neither is passed on.
- `invalidToolArgsError(error)` (about line 810) wraps only `error.message` into `{ code: 'provider.invalid_tool_args', message, retryable: false }`.
- Two call sites turn a thrown error into that result: the OpenAI-compatible path (about line 367) and the Anthropic-native path (about line 526).
- On the Anthropic-native path the API already returns `block.input` as an object, so a JSON syntax error cannot happen there. Only `asToolArgs` can throw ("Tool arguments must be a JSON object"). The staging failures therefore come from the OpenAI-compatible path.
- The response `finish_reason` is not read anywhere in `llm-provider.ts` (no match for `finish_reason`).

**Where the message goes.**
- `apps/worker/src/runtime-errors.ts`: `classifyRuntimeError` maps the code to `{ mode: 'degraded', reasonCode: 'llm.invalid_tool_args', message, retryAfterMs: 2000 }`. `callLlmWithRetry` retries up to `maxRetries` (2) with a 2 s delay and the identical request.
- The structured tool loop returns `{ ok: false, error }` (`apps/worker/src/structured-tool-loop.ts`, after `callLlmWithRetry`). `apps/worker/src/agent.ts` stores `error.message` as `errorMessage` on `agent.llm.completed` and passes the error to `handleRuntimeFailure('llm', error)`.
- The model never sees this message: the tick ends. The message is read by operators (event payload, activity timeline, logs).

**Tests that pin the current text.** `packages/llm/src/llm-provider.test.ts` line 212 (code `provider.invalid_tool_args`) and line 396 to 397 (expects the exact message `'Tool arguments must be a JSON object'`). `apps/worker/src/runtime-errors.test.ts` uses a mock message (`'malformed JSON'`) and only tests classification and retry counts. A message change will require updating the line 396 test.

**What tool-level validation already does.** When a tool call has valid JSON but wrong fields, `apps/worker/src/agent.ts` (about line 2289) already returns `invalid parameters: <path>: <message>; ...` plus structured missing and invalid field lists to the model. So this gap is specific to the provider-level JSON parse failure.

## Root Cause

The provider throws away everything it knows about the failing call (tool name, call id, position of the call among several, the length and shape of the arguments, the finish reason) and keeps only the raw V8 `JSON.parse` message. The raw message is also tied to the Node/V8 format, which is not guaranteed.

## Proposed Fix (for review): improve the message only

### 1. Message content

The OpenAI-compatible parse failure produces one bounded, single-line message, for example:

```
Invalid tool arguments for "write_file" (call call_1, call 1 of 1): not valid JSON. Expected ',' or '}' after property value in JSON at position 36 (line 1 column 37). The arguments are 5812 characters long. The character at position 36 is 'u' and the character before it is '"'. The model finished with reason "stop".
```

Rules:
- **Tool name and call id** come from `function.name` and `id`. When the model sent several calls, say which one failed ("call 2 of 3"). If the name is missing, say so.
- **Position.** Read `position N` out of the engine message with a pattern. If no position is found (a different Node version or a different error), keep the raw message and omit the position-derived sentences. Never fail to produce a message because of the parse of the message.
- **The offending character and its neighbour** (JSON-escaped and quoted, for example `'u'` and `'"'`) are enough to confirm or reject the unescaped-quote theory: "a quote, then a letter, at the start of a string value".
- **Length** of the raw arguments in characters.
- **Truncation hint.** If the response `finish_reason` is `length` (output cut off by the token limit), say so and include the configured max tokens when available: "the output hit the token limit, so the arguments are probably cut off; the call was too large for one response". This needs the OpenAI-compatible path to read `choices[0].finish_reason` and pass it to the parse error. Also say it when the engine message indicates an unterminated string or unexpected end of input.
- **Non-object arguments** (`asToolArgs`): replace "Tool arguments must be a JSON object" with the same prefix plus what was received ("an array", "a string", "null"), still starting with the old sentence so existing readers keep working.
- **Length cap** on the whole message (a constant, for example 600 characters), so the stored `errorMessage` stays small.
- **No excerpt of the arguments, ever (owner decision).** The arguments can contain CV text, personal data, tokens or file contents (`write_file` content). The message uses only counts, the position, the finish reason, and the one character at the error position and the one before it. No configuration switch is added for an excerpt.

### 2. Where the code changes (message scope only)

- `packages/llm/src/llm-provider.ts`: `parseToolArgs`, `normalizeOpenAiToolCalls` (pass name, id, index and total into the failure), `asToolArgs`, `invalidToolArgsError`, and reading `finish_reason` on the OpenAI-compatible path.
- The error type returned stays `{ code, message, retryable: false }`. No new fields on the result, no change to the code string, so `classifyRuntimeError`, the retry loop and the tick failure path are untouched.
- Optional, to make the failure searchable without parsing prose: also include the tool name in a structured log line at the point where the worker logs `handleRuntimeFailure` for this reason code. That is a log field only. Decide in review whether to include it; the message alone covers the diagnostic need.

### 3. Tests (behaviour-named)

In `packages/llm/src/llm-provider.test.ts`, with the OpenAI-compatible wire format:
- "names the tool and call in the invalid arguments error"
- "reports the position, length and the characters around the failure for an unescaped quote in a string value"
- "says the output was cut off when the finish reason is length"
- "says which of several tool calls was invalid"
- "keeps the raw JSON error message when no position can be read from it"
- "does not include argument text in the message beyond the offending character"
- "keeps the message under the length cap for very long tool names and arguments"
- "names what it received when the arguments are not a JSON object" (update the existing line 396 expectation)

In `apps/worker/src/runtime-errors.test.ts`: no behaviour change; confirm the classification and retry tests still pass.

### 4. Documentation

- `docs/bug-reports/2026/11/17/001-...`, Outstanding Issues: link to this report.
- `CHANGELOG.md` Fixed or Changed: the new message format and where to read it (`agent.llm.completed.errorMessage`).
- A short entry in the agent-runtime docs describing the message format and what each part means, so operators know how to read it.

## Verdict: call signatures in error messages

The question was whether error messages that tell the agent how to call another tool, with a call signature, could drift and cause `provider.invalid_tool_args`. **Recommendation: do nothing about signatures for this problem.**

- **It is not a plausible cause of this error.** `provider.invalid_tool_args` is a JSON syntax failure inside one reply's `arguments` string (`Expected ',' or '}'... position 36`). A wrong parameter name taken from an out-of-date signature produces valid JSON with a wrong key, which fails later at schema validation as `invalid parameters: ...`, a different error that the model sees and can correct. The two do not overlap.
- **Signatures in tool error messages are already generated and guarded.** `apps/worker/src/tools/tool-signature.ts` holds `FILE_TOOL_PARAMS` (10 tools); `toolSignature`, `toolUse` and `toolCall` build the text from it and, in test mode, throw on an unknown tool or parameter. `tool-signature.test.ts` compares each entry with the tool's real Zod schema, and `findSignatureProblems` runs over the file-tool messages (`file-messages.test.ts`, `file-write-tools.test.ts`), the `file-management` and `long-running-task` skill instructions, and the docs. A rename that is not mirrored fails a test.
- **What is not covered.** Hand-written signatures in `apps/worker/src/tools/platform-docs-data.ts` (agent-readable docs such as `write_file(path, content)`) are checked only if the docs test scans them (`tool-signature.test.ts` reads files from a docs folder; whether it includes `platform-docs-data.ts` was not confirmed). These are documentation, not error messages. Signatures for tools outside `FILE_TOOL_PARAMS` do not appear in any message found by a search for `name(arg` patterns.
- **Worth a note for later, not now:** if more tools start putting signatures in messages, they must be added to `FILE_TOOL_PARAMS` (the test fails loudly in that case because `toolUse` throws in test mode).

## Silent drops: add a warning (in scope, owner decision)

In `normalizeOpenAiToolCalls` (`packages/llm/src/llm-provider.ts`), a tool call whose `function.name` is not a string is dropped silently (`return []`), and so is an entry that is not an object. If that happened to every call in a reply, the loop would see "no tool calls" and end the tick as if the model had finished. It is not known whether this ever happens; the warning will show whether it does.

- **What:** when a call is dropped, write one warning line per dropped call: `[llm-provider] dropped tool call <index+1> of <total>: <reason>` with a reason such as "no function name" or "entry is not an object". Include the call id when there is one. Include no argument content and no name text beyond the id.
- **How:** `packages/llm` has no logger. The package already uses `console.warn` with a bracketed prefix (`openrouter-pricing.ts`, lines 59 and 97), so follow that precedent. Behaviour of the function is unchanged: the same calls are returned as before.
- **Alternative (not proposed):** return a `droppedToolCalls` count in the result data and let the worker log it with its structured logger. It is cleaner but changes the result type, which goes beyond "improve messages".
- **Test:** "warns once per dropped tool call and still returns the valid ones", "does not warn when every call is valid", "includes no argument text in the warning".

## Deferred follow-ups (out of scope here)

1. **Corrective retry:** return the error to the model as a message and let it re-send, instead of replaying the identical request. This is the behavioural fix for the dropped tick. It is not done here by decision.
2. **Skill guidance:** prefer `append_file` with small JSONL records over rewriting large JSON files; avoid JSON-inside-JSON arguments.
3. **A more tool-call-robust model** for agents that write structured files.

## Decisions (owner, 2026-11-17)

1. No excerpt of the arguments in the message.
2. Reading `finish_reason` on the OpenAI-compatible path is allowed.
3. Log a warning for silently dropped tool calls.
4. Message length cap: a fixed named constant in the code (a diagnostic limit, not a user-facing default), proposed 600 characters. Not an operator setting.

No open questions.

## Acceptance Criteria

- For malformed JSON arguments on the OpenAI-compatible path, the error message contains the tool name, the call id, the position, the argument length, the offending character and the finish reason, and stays under the cap.
- For output cut off by `finish_reason: length`, the message says so.
- When the position cannot be parsed from the engine message, the message falls back to the raw text and still names the tool.
- No argument content other than the single offending character and its neighbour appears in the message, and there is no setting that turns an excerpt on.
- A tool call dropped for having no usable name, or for not being an object, produces one warning line naming its position and the reason, and the returned calls are the same as before.
- The error code, `retryable`, the retry loop and the tick failure behaviour are unchanged. Existing classification and retry tests pass.
- `pnpm lint`, `pnpm test`, `pnpm build` pass.
