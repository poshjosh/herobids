# Continuation guard: `finish_run` tool, a stop hook, and a stop-without-finishing nudge

Status: DRAFT for review. Nothing is implemented. This plan describes the work; it does not do it.
Date: 2026-11-17
Follows: `docs/features/2026/11/14/003-agent-run-status-hint/plan.md`, section "If this is not enough: continuation guard (separate plan)".

## Decisions (owner, 2026-11-17)

| # | Decision |
|---|---|
| D1 | `finish_run` is delivered through the existing `system/long-running-task` skill (added to its `requiredTools`, with a short instruction section). Not the base skill, not a new skill. |
| D2 | The stop hook is accepted: when `finish_run` succeeds, the run ends right after that turn's tool calls, with no further model call. Specified in section 3a. |
| D3 | `maxNudges` default is 2. |
| D4 | The stored `finish_run` reason is limited to 300 characters. |
| D5 | The nudge text is the one in "Behaviour" below. |
| D6 | The job-search skill and the long-running-task skill will be reconciled later by the owner. This plan does not touch the job-search skill or give `job-searcher` the tool (see "Consequences of D1"). |
| D7 | There is no `continuationGuard.enabled` flag, and none is to be implemented. Whether an agent has the tool, and so whether it is nudged, is decided only by its skills. The only operator setting is `maxNudges`. Staged rollout uses the existing agent image pin (staging first, then production). |
| D8 | `finish_run` with status `waiting` is only recorded (on `agent.llm.completed` and the activity timeline). It does not wake the agent, schedule anything or connect to reminders. Any future link to reminders is separate work. |
| D9 | The activity timeline summary for the LLM-completed event shows the `finish_run` status and reason (and the nudge count when above zero). It is in scope, not optional. See section 8. |

## Problem

Agents whose skill needs a long run stop early. The run ends when the model replies with no tool call, and the platform treats that as "done". Nothing asks the agent whether it is really done, and the agent has no way to say why it stopped.

Evidence (staging, agent `job-searcher`, 2026-11-16 to 2026-11-17, model `anthropic/claude-haiku-5.5`):
- 12 scheduled discovery ticks, one every 2 hours as configured. Each ran about 1 to 3 minutes against a skill run budget of up to 30 minutes (half the 2-hour interval, capped at 30).
- Every successful tick ended with `finishReason: "stop"`: the model chose to stop. The agent's own state still listed pending leads, and the same few leads were re-checked on later ticks.
- The run-status line (current time and elapsed time) only helps the agent judge time. The earlier plan says plainly that it does not stop early exits: "treat this as a cheap, low-risk experiment that fixes the clock, not as the fix for early stops". It also sketched the remedy this plan builds.

## Goal

When a model stops without having declared it is finished, the platform asks it once or twice to check, and the agent either carries on or ends the run explicitly with a status and a reason. Every end of run for an agent that has the tool then has a recorded, explicit reason.

## Non-goals

- The platform does not decide whether the agent is done, and does not know the time budget. The skill defines "done"; the agent judges it. (Rejected design: a nudge that says "you have time left". The platform cannot know that. Decided with the owner.)
- No wall-clock cap, no forced continuation beyond the nudge cap.
- No new wake source and no scheduling. `finish_run` with `waiting` records a status only; it does not wake or schedule anything. Existing `schedule_reminder` remains the way to come back.
- No change to the scout loop.
- No change to the failure path for `provider.invalid_tool_args` (separate reports: `docs/bug-reports/2026/11/17/003-*`).
- No new capability grant, no skill content for any particular domain (job search, trading).
- No change to the job-search skill, and no automatic reconciliation of it with long-running-task (D6).

## Behaviour (what the agent and the operator will see)

1. An agent that can see the `finish_run` tool runs its normal judge loop. The tool is visible to an agent only through its skills: today, an agent that has the `long-running-task` skill (see 6). There is no operator switch for visibility (D7).
2. When the model answers with no tool call, and `finish_run` has not been called in this run, and the nudge cap is not reached, and it is not the last allowed turn, the platform does not end the run. It appends the model's reply as an assistant message and then this user message, and calls the model again:

   > You stopped without calling `finish_run`, which is required to end a run. Check whether you are done. If you are, call `finish_run` with a status (`complete`, `waiting` or `blocked`) and a short reason. If you are not, continue working.

3. If the model calls `finish_run` and the call succeeds, the run ends after that turn's tool calls are executed. No further model call is made (the stop hook, section 3a).
4. If the model keeps stopping without calling `finish_run`, the run ends after the cap, as it does today.
5. `agent.llm.completed` (judge) gains optional fields: the number of nudges, and the `finish_run` status and reason when present.
6. Agents that do not have the tool (every agent without `long-running-task`, including all trading agents) behave exactly as today: requests and loop behaviour are identical. For agents that have it, the behaviour above applies as soon as the new agent image runs; there is no flag that delays it (D7). The `long-running-task` instruction paragraph (section 5) is worded to stay harmless if the tool is ever absent, for example when a circuit breaker hides it.

## Design

### 1. The tool

- `finish_run`, new file `apps/worker/src/tools/finish-run.ts`, modelled on the small tools in `apps/worker/src/tools/messaging.ts` (Zod parameters, `convertZodToJsonSchema`, `execute` returns a `ToolResult`).
- Parameters: `status` (enum `complete`, `waiting`, `blocked`) and `reason` (string, 1 to 300 characters; the maximum is a named constant next to the schema, D4).
- The tool itself only validates and returns a short acknowledgement. The agent process records the call (see 4). It is not capability-gated (no `checkAccess`), so it needs no grant row. The drift-guard test from `docs/bug-reports/2026/11/17/002-*` must not flag it.
- Category: a non-read-only category, so the read-only scout tool list does not include it (`isReadOnlyCategory` in `packages/domain/src/trading/tool-contract.ts` decides). `write-messaging` or `write-memory` are the existing candidates; confirm which in review. The scout executor also rejects any tool outside its read-only list, so `finish_run` would be refused there in any case.
- Description (so the rule is stated up front): "Call this to end a run. Status `complete` when the goal for this run is done, `waiting` when you need something that has not arrived (a user answer, a later time), `blocked` when you cannot continue. The reason is a short sentence." The same rule is in the `long-running-task` instructions (section 5), so the nudge is a reminder and not the first time the agent hears of it.
- Result messages are tiny and transient: do not add the tool to `DURABLE_TOOL_NAMES`.

### 2. Registration checklist (so nothing drifts)

All must change together; the registry fails at start-up and in tests if one is missed:
1. `apps/worker/src/tools/index.ts`: import the tool and add it to `allTools` in `createToolRegistry`.
2. `packages/domain/src/tools.ts`: add `'finish_run'` to `KNOWN_AGENT_TOOL_NAMES` and an entry in `TOOL_CATALOG` (category and description).
3. `packages/domain/src/skills.ts`: add `'finish_run'` to `LONG_RUNNING_TASK_SKILL.requiredTools` (D1).
4. `assertToolCatalogMatchesRegistry` and `assertBuiltInSkillToolsAreKnown` (in `tools/index.ts`) run at construction; they pass only if 1, 2 and 3 agree.
5. Tool ownership: `buildToolOwnershipMap` gives each non-base tool to the first system skill that lists it. After step 3, `finish_run` is owned by `long-running-task`. `inferDependsOn` therefore adds `long-running-task` as a dependency of any other skill that lists `finish_run`. `skills.test.ts` line 334 (`inferDependsOn(LONG_RUNNING_TASK_SKILL.requiredTools, ...)` equals `['file-management']`) stays true, because a skill's own tools are excluded. This coupling is what the owner will reconcile later (D6); it is recorded here so it is not a surprise.
6. Tests: `tool-registry.test.ts` ("matches the shared agent tool catalog exactly", "only exposes known tools from built-in skills", and the smallest-`maxVisibleToolSchemas` test, which asserts the combined built-in tool set stays within 64; re-run it, it may not include `long-running-task`), `packages/domain/src/tools.test.ts`, `apps/api/src/routes/agent-tools.test.ts` (reads `TOOL_CATALOG`), `packages/domain/src/skills.test.ts` (new cases in section 5).
7. `scripts/ts/build-docs-index.ts` mirrors skill and tool text and runs as the first step of `pnpm build`; check whether it needs a manual update.
8. Web UI tool-name lists: not searched; check `apps/web` before implementing.

### 3. Loop changes (`apps/worker/src/structured-tool-loop.ts`)

Today the loop ends in three ways: a turn with no tool calls, an LLM failure, or `maxTurns` exhausted. Nothing reacts to a tool name. Changes, kept generic (the loop must not learn about `finish_run`):

- New option `onNoToolCalls?: (info) => { nudge: string } | undefined`, called in the `toolCalls.length === 0` branch. If it returns a nudge, the loop pushes `{ role: 'assistant', content: assistantResponse }` and then `{ role: 'user', content: nudge }` to its local message list and continues to the next turn. The assistant message must be pushed first: providers can reject two user messages in a row, and the model needs to see its own reply. The nudge is a permanent message for the rest of the loop (not a per-request ephemeral line like `getTurnContext`, which would be sent only once). It is never written to cross-tick history (the loop's messages are discarded at the end of the tick).
- New option `shouldStopAfterToolResults?: () => boolean`: the stop hook, specified in 3a.
- The nudge never fires on the last allowed turn (`turnIndex === maxTurns - 1`). Otherwise the loop would end as `terminatedByLimit: true`, which today means "runaway loop" and sends a `degraded` heartbeat (`llm.tool_loop_limit`).
- A nudge consumes one turn of `maxTurns`, and counts in `turnsUsed`.
- `onAssistantTurn` info gains `continues: boolean` (true when a nudge follows), so the agent can skip the final-turn side effects (see 4).
- `StructuredToolLoopSuccess` gains `nudgesUsed: number` and `endedBy: 'no_tool_calls' | 'terminal_tool' | 'turn_limit'` (optional, defaulted, to limit churn in test fixtures).
- `assistantResponse` in the result is the last non-empty assistant text, so a nudged turn's reply is not lost when the final turn is empty (matters for the reply fallback in 4).
- When neither option is given the loop is byte-for-byte as today. There is a test pattern for this ("behaves exactly as before when not provided", as used for `getTurnContext`).

### 3a. The stop hook (decided, D2)

**What it is.** After a turn's tool calls have all been executed and their results pushed, the loop asks `shouldStopAfterToolResults()`. If it returns true, the loop returns success immediately, with no further model call.

**Why.** Without it, after `finish_run` the loop would send the tool result back to the model for another round. The model would answer with something like "Done", which is a full extra paid model call (the whole conversation is resent). Staging runs make 6 to 20 model calls, so that is about 5 to 15% more calls for every run of an agent that ends with `finish_run`. The extra answer could also replace the agent's real final text as the "last assistant response" used by the reply fallback.

**Exact semantics.**
1. The check runs once per turn, after the `for (const toolCall of toolCalls)` loop that executes tools and pushes `role: 'tool'` messages, and before the next iteration (before the next `turnIndex`). It never runs on a turn with no tool calls (that branch has its own logic, see the nudge).
2. All tool calls in the reply are executed first, in order, as today. `finish_run` does not skip the other calls of the same reply. Example: `send_message` followed by `finish_run` in one reply sends the message and then ends. This avoids half-done actions.
3. The hook is generic: the loop does not know why it returns true. The agent's judge wiring (section 4) returns true when a successful `finish_run` has been recorded in this run. A `finish_run` call that fails validation (for example an invalid status) records nothing, the hook returns false, and the loop continues, so the model sees the error and can retry.
4. The result is `{ ok: true, assistantResponse: <last non-empty assistant text>, toolCalls: <this turn's calls>, turnsUsed, terminatedByLimit: false, nudgesUsed, endedBy: 'terminal_tool' }`. `terminatedByLimit` is false, so the tick takes the normal-completion path (`handleTickSuccess`, context hash and escalation timestamp updates), not the `degraded` path.
5. If `finish_run` is called on the last allowed turn, the hook still ends the run normally (the loop would have ended anyway, but as `terminatedByLimit: true`; the hook turns that into a clean stop, which is better). The hook is evaluated before the loop checks the turn limit for the next iteration.
6. `turnsUsed` counts the turn that called `finish_run` and no later turn. `toolCallsUsed` counts `finish_run` as a tool call.
7. The stale tool-result truncation does not matter here (the loop ends right away).
8. The text next to the `finish_run` call in the same reply is the final `assistantResponse`. If a user message is pending and no `send_message` was called, the existing reply fallback delivers that text (see 4). The agent should therefore send its message with `send_message`, or put its reply in the same reply as `finish_run`; both work.
9. Nothing in the hook depends on the nudge. With `maxNudges: 0` the tool and the hook are active and nobody is nudged.

**What the hook does not do.** It does not apply to any other tool. It is not a new way to end a run for agents without the tool. It does not schedule or wake anything.

**Tests** (loop, behaviour-named): "returns right after the tool results of a turn when the stop check says so, without another model call"; "still runs every tool call of the reply before stopping"; "does not stop when the check says no and the reply had tool calls"; "reports `endedBy` terminal_tool and counts the turn that called the tool"; "ends cleanly when the stopping tool is called on the last allowed turn"; "does nothing when the option is not given".

### 4. Judge wiring (`apps/worker/src/agent.ts`, judge `runStructuredToolLoop` call, about line 4280)

- **No visibility gate and no enable flag (D7).** Nothing is added to `permanentlyExcludedTools`. The tool is visible exactly when a resolved skill lists it.
- **Opt-in for the nudge** is "the agent can see the tool": `allowedTools().has('finish_run')`, evaluated at the moment the model stops (so an agent that gains or loses the tool mid-run is handled).
- `onNoToolCalls` returns the fixed nudge when opted in, `finish_run` has not been called, nudges used is below `maxNudges`, and it is not the last turn.
- `onToolResult`: when the tool is `finish_run` and the result succeeded, record `{ status, reason }` in a closure variable, following the existing `judgeToolCallsUsed` and `judgeSentReply` pattern. `shouldStopAfterToolResults` returns true when it is set. `finish_run` also counts in `toolCallsUsed`.
- **Side effects of a nudged turn must not run.** Today `onAssistantTurn` does these only for a no-tool-call turn: `addToHistory('assistant', ...)` (cross-tick history), `judgeResponseHistory` for enriched prompts, and the activity-timeline `DECISION` event. They must run only when `continues` is false, otherwise a premature "I'm done" would be written to history and the timeline. Session cost recording and usage billing stay unconditional (every turn is paid for).
- **Reply fallback** (about line 4411): uses the loop's last assistant response when a user message is pending and no `send_message` was made. With nudges it uses the last non-empty text (see 3). With the stop hook, the text sent next to `finish_run` is used.
- **`agent.tick.completed` outcome** (`replied` / `no_reply`) is unchanged: it depends only on whether a message was sent (`activeTick.replied`). `finish_run` status is a different thing and must not be confused with it. State this in the code comment and the docs.
- `finishReason` values on `agent.llm.completed` are unchanged (`stop`, `turn_limit`, `error`, `stop_without_reply`), because the activity mapper, dashboards and queries read them (`agent-activity-mapper.ts` marks `error` and judge `turn_limit` as warnings). New information goes into new fields.

### 5. The long-running-task skill (D1)

`LONG_RUNNING_TASK_SKILL` in `packages/domain/src/skills.ts` (about lines 449 to 530).

- `requiredTools` gains `'finish_run'` (it currently lists the nine file tools, kept so that dependency inference pulls in `file-management`).
- The instructions gain one section, placed after "FINISH A CYCLE" and before "RULES". Proposed text (for review; the wording is conditional ("If you have the tool") so it stays harmless if the tool is absent):

  ```
  ENDING A RUN
  - If you have the `finish_run` tool, end every run by calling it. Use `complete` when the cycle is finished (the report is sent) or there was nothing to do. Use `waiting` when pending units remain and the continuation reminder is scheduled, or when you are waiting for the user. Use `blocked` when you cannot continue. Give one short sentence as the reason.
  - Before you call it, check your own state: the index phase, the pending tasks (`list_tasks`) and the continuation reminder. Do not use `complete` while units are pending.
  ```
- One existing sentence changes. In "START OF EVERY TICK" step 4: "...there is nothing to do. Do not message the user and end the tick." becomes "...there is nothing to do. Do not message the user; end the run (see ENDING A RUN)."
- Existing `skills.test.ts` assertions must keep passing: the exact continuation key string, the memory key convention, "Workspace files are NOT durable", no `cancel_reminder`, domain-agnostic (no farm, hofnachfolge, probe, sourdough), and the base-tool `it.each` list (do not add `finish_run` to it; it is not a base tool). `tool-signature.test.ts` scans the instructions for wrong file-tool signatures; `finish_run` is not in `FILE_TOOL_PARAMS`, so the new text is unaffected.
- New `skills.test.ts` cases: "lists `finish_run` as a required tool", "tells the agent to end every run with `finish_run`", "keeps depending only on file-management", "owns `finish_run` in the tool ownership map".
- What "done" means for a particular job stays in that job's skill. The platform text only asks the agent to check.

### 6. Consequences of D1

Facts from staging (read-only query of `agent_skills`, 2026-11-17, 17 agents): 8 agents have `traderton/skills/crypto-trading`; 5 have `system/long-running-task`; 4 have `system/web-access`; 7 have `system/file-management`. The only agent with `openaidom/skills/job-search` is `job-searcher`, whose skills are `job-search`, `system/browser`, `system/file-management` and `system/web-access`. It does NOT have `system/long-running-task`.

- The 5 agents that have `long-running-task` get the tool and the new instruction section. They are the agents for which the guard will be tested.
- Trading agents (8 of 17) do not have the skill: they never see the tool and are never nudged. Their normal tick, which ends with no tool call, is unchanged and costs nothing extra.
- `job-searcher` does not get the tool under this plan (D6). The early-stop problem that motivated the plan is therefore not fixed for that agent until the owner reconciles the two skills or adds `long-running-task` to it. The two skills conflict in how they keep state: `long-running-task` keeps progress in tasks and memory and says "Workspace files are NOT durable", while `job-search` keeps state in files in a data directory and runs its own schedule. How they interact on one agent has not been tested.
- Any skill added later that lists `finish_run` gets `long-running-task` as an inferred dependency (section 2, step 5).
- Visibility is capped by `maxVisibleToolSchemas` (64 / 128 / 256 by style); one more tool in this skill is negligible but the smallest-cap test must be re-run.

### 7. Config (operator, validated by Zod, not hard-coded)

Following the `runStatusHint` pattern exactly:
- `packages/domain/src/config/schema.ts`, `AgentRuntimeConfigSchema`:
  ```ts
  continuationGuard: z.object({
    maxNudges: z.number().int().min(0).default(2),
  }).default({}),
  ```
  `AgentRuntimePolicySchema` extends it, so the agent container gets it through `AGENT_RUNTIME_CONFIG_JSON` (`apps/worker/src/index.ts` spreads `appConfig.agentRuntime`).
- `config/default.yaml`: `maxNudges: 2`, with a one-line comment. Staging and production inherit it; no per-environment override is needed. There is no `enabled` key (D7).
- The schema default (2) applies when the key is missing, so a worker and an agent image of different ages still agree. `maxNudges: 0` means tool and stop hook only, no nudging. It is the only config-level way to turn the nudge off; turning the whole feature off means releasing the previous agent image (section "Rollout").
- No new env var, so no `.env*.example` change. The nudge text is a named constant in a small pure module (`apps/worker/src/continuation-guard.ts`), alongside the decision function, so it can be unit-tested without importing `agent.ts` (which reads env and exits at import).
- Tests like `schema.test.ts` for `runStatusHint`: defaults, accepts a valid value, rejects a negative `maxNudges`.

### 8. Event payload (`packages/domain/src/agent-protocol.ts`)

`LlmCompletedPayloadSchema` is not strict, so unknown keys are stripped when a message is parsed. New optional fields must be declared or they will not reach `agent_messages` (this is why `elapsedMs` and `toolCallsUsed` were declared when they were added):
- `nudgeCount: z.number().int().min(0).optional()`
- `finishRunStatus: z.enum(['complete','waiting','blocked']).optional()`
- `finishRunReason: z.string().max(300).optional()` (the same constant as the tool)
All optional, judge phase only, so older agent images stay valid. Add a test next to the existing "keeps the elapsed time and tool-call count" test. `agent-message-broker.ts` treats the event as audit only and is unaffected.

**Activity timeline summary (D9).** `apps/api/src/routes/agent-activity-mapper.ts`, the `LLM_COMPLETED` entry (`summaryFn`, about lines 302 to 316), builds `<phase> LLM completed — model: <model>, turns: <n>, finish: <reason>.` It reads only `phase`, `model`, `turnsUsed` and `finishReason`. Change:
- When `finishRunStatus` is present, append ` Ended: <status> — <reason>.` For example: `judge LLM completed — model: anthropic/claude-haiku-5.5, turns: 14, finish: stop. Ended: waiting — waiting for the user's answer.`
- When `nudgeCount` is above zero, append ` Nudged ${n}x.`
- When neither field is present (older agent images, agents without the tool, scout events), the text is exactly as today.
- Severity and category are unchanged. `isRuntimeActivityWarn` keeps keying on `finishReason` only: `blocked` is information for the operator, not a platform error, and is not escalated to a warning.
- The reason is model-written text and appears in a user-visible timeline. It is already bounded to 300 characters by the payload schema. It must be treated as data: rendered as plain text, never as markup or as an instruction. Check how the web timeline renders summary text (`AgentActivityTimeline.tsx`, which was seen to render payload values generically and was not read in full); if summaries are rendered as text no web change is needed.
- Tests in `apps/api/src/routes/agent-activity-mapper.test.ts`: "shows the finish_run status and reason in the LLM-completed summary", "shows the nudge count when above zero", "leaves the summary unchanged when the finish_run fields are absent", "does not raise the severity for a blocked run". Check whether an existing test pins the exact old summary string and keep it passing.

The reason is model-written text that lands in the database. It is bounded by the schema, and it must not be treated as an instruction anywhere (it is data).

## Rule fit

- **Agent Mode Purity** (`docs/tech/agents/runtime-boundary-and-message-contract.md#agent-mode-purity`): constraints must not be injected unless configured; data is always provided; operational mechanics are always applied. This feature is operational mechanics for ending a run (like retries and schema validation). It adds no limit on what the agent may do, no risk or trading rule, and nothing about time or budget. The nudge is an instruction (unlike the run-status line, which the earlier plan kept to data only on purpose). It is acceptable because it is opt-in (the agent must have the `long-running-task` skill), capped by operator config, and asks the agent to apply its own definition of done. The tool description and skill text state the rule openly. The reviewer must confirm this classification.
- **Risk gate rules / trading in traderton:** untouched. The tool is generic runtime mechanics with no trading content.
- **Agent runtime best practices** (`docs/best-practices/agent-runtime.md`): no new wake source (wake taxonomy), no `instance.context.snapshot`, no new repeating failure mode (the cap bounds it, so no session circuit breaker wiring is needed). The "Cost Review Checklist" must be run and a short "Continuation guard" section added to that doc, like the "Run Status Line" section, covering the tool, the hook and the nudge.
- **Configuration:** operator config under `agentRuntime`, no literals except the schema default, per `docs/best-practices/configuration.md`.
- **Lessons #9** (context growth): the nudge is local to the loop and not stored across ticks; its size is one short message per nudge.

## Cost and interactions

- Each nudge is a full extra judge model call: the whole conversation is resent, not the roughly 30 tokens of the run-status line. With cap 2, the worst case is 2 extra calls per run. The stop hook removes the call that would otherwise follow `finish_run`. Billing and session cost recording apply to nudge turns like any other turn (`onAssistantTurn` is unchanged for cost).
- The tool circuit breaker (`recordToolFailure` in `onToolResult`) would count a failed `finish_run` call (for example an invalid `status`). Repeated failures could hide the tool (`getBlockedTools`) and the agent would no longer be nudged, which is a safe fall-through. Keep the tool's validation simple.
- Stale tool-result truncation touches only `role: 'tool'` messages; the nudge is a user message and is never cut.
- Reminders and wake logic: not changed. The way a tick ends (normal return) is the same, so `handleTickSuccess`, context hash and escalation timestamp updates run as today. A tick that ends because `maxTurns` was hit still takes the existing `terminatedByLimit` path, and the nudge is not allowed to cause that (see 3). Not read in this review: `agent-wake-scheduler.ts` and the reminders coordinator; confirm nothing there depends on the final assistant text or on the number of turns.
- Pause, session circuit breaker and billing gates run before the judge loop, not between turns. A nudge does not add a gate check; this is the same as every other turn today.
- Scout loop: untouched, and a no-tool-call scout reply is its normal protocol.

## Edge cases (each needs a test or an explicit decision)

1. `finish_run` and other tools in the same reply: execute them all in order, then stop (3a, point 2).
2. The model calls `finish_run` twice in one reply: the first successful call is recorded; the run ends after the turn.
3. The model stops, is nudged, and calls `finish_run`: ends; `nudgeCount` is 1.
4. The model stops three times with cap 2: ends after the second nudge; `nudgeCount` is 2; `finishRunStatus` absent (visible in data).
5. A user message is pending and the agent forgot `send_message`: a nudge happens before the fallback reply. Final reply uses the last non-empty text.
6. The model errors on a nudge turn: same failure path as any turn.
7. Tool removed mid-run (via `remove_skills`): no further nudges.
8. `judgeMaxTurns` very small (1 or 2): the last-turn rule means no nudge can fire.
9. An agent without the tool: identical loop behaviour and requests. `maxNudges: 0`: tool and stop hook only, no nudging.
10. `finish_run` with `waiting` while the user's question is unanswered: recorded only; it does not wake the agent.
11. `finish_run` fails validation (bad status or empty reason): not recorded, the loop continues, the model sees the error.
12. `finish_run` called on the last allowed turn: ends cleanly (3a, point 5).

## Test plan (behaviour-named, per `AGENTS.md`)

Loop (`apps/worker/src/structured-tool-loop.test.ts`, pattern of the `getTurnContext` and 'executes tool turns until the model returns a final response' tests; check the module mock at the top of that file before writing):
- "asks the model to continue once when it stops without finishing, then returns its next answer"
- "puts the model's reply before the nudge in the messages it sends next"
- "stops asking after the nudge cap and returns as it did before"
- "never nudges on the last allowed turn"
- "counts a nudge as a turn against the turn limit"
- the stop-hook tests in 3a
- "keeps the last non-empty assistant text when the final turn is empty"
- "behaves exactly as before when no continuation option is given"
- "reports how many nudges were used"

Pure module (`continuation-guard.test.ts`): nudges only when the tool is visible, not finished, under the cap, not last turn; the text is exactly the agreed text and does not mention time or budget; wording guard in the style of the run-status test (no claim about time left).

Activity mapper: the four tests listed in section 8.

Schema/protocol: defaults and validation of `continuationGuard`; `LlmCompletedPayloadSchema` accepts and keeps the new fields, accepts an older payload, rejects a bad status and an over-long reason.

Tool, registry and skill: `finish_run` validates status and reason, returns an acknowledgement, is in the catalog and registry, is listed by `long-running-task` and owned by it, is not visible to an agent without that skill, and is refused in scout. The new `skills.test.ts` cases in section 5.

Judge wiring: not directly unit-testable today (`agent.ts` runs at import). Keep the logic in the pure module and the callbacks thin, and add a real-stack check (see Verification).

Standard: `pnpm lint`, `pnpm test`, `pnpm build`.

## Verification (live, after implementation)

Because of D1 and D6, the agents that can test the guard are those with `system/long-running-task` (5 on staging at the time of writing), not `job-searcher`.
- **Baseline, taken before the new image is released to staging:** for each of those agents, 24 hours of `agent.llm.completed` (judge): `turnsUsed`, `elapsedMs`, `toolCallsUsed`, `finishReason`, from `agent_messages`. This baseline does not exist yet and must be captured; the earlier `job-searcher` numbers do not apply to these agents.
- **Stage B (guard on, same model per agent):** compare the same fields plus `nudgeCount`, `finishRunStatus` and the stated reasons, and compare each stated reason with the agent's own index and pending tasks. Questions to answer: do runs end with an explicit status? Is `complete` ever declared while its own task list shows pending units (a rubber stamp)? How many model calls does the nudge add, and how many does the stop hook save?
- Proposed success bar (adjust after the baseline): every run of an agent with the tool ends with a recorded status and reason; no run ends with `complete` while it has pending tasks; the average number of model calls per run does not rise by more than the nudge cap allows. These are proposals, not measured targets.
- Compare each agent with itself; do not compare across models.
- A trading-agent canary on the new image: confirm the tool is not visible, no behaviour change, no extra model calls.
- `job-searcher` can be added to the test once the owner reconciles the skills (D6), using the same method.

## Rollout

There is no flag (D7), so the staged rollout is the agent image pin, which is per environment.
1. Merge. Nothing changes in any environment until the agent image is released there, because agents run the pinned image.
2. Capture the baseline on staging (before the release). Release the new image to staging (`infra/hetzner/scripts/release-agent-image.sh --env staging`) and relaunch the `long-running-task` agents. From then on those agents have the tool and are nudged. Soak.
3. Decide on production from the stage B data, then release the image there the same way.
4. **Rollback:** release the previous image (`release-agent-image.sh --env <env> --sha <previous commit>`) and relaunch the agents. For a partial switch-off, set `agentRuntime.continuationGuard.maxNudges: 0` (the tool and the stop hook remain, nudging stops); this needs the worker restarted and the agents relaunched, since the policy is read at container start.

## Work packages (for the implementer)

1. WP1: pure module `continuation-guard.ts` (constant text, decision function) and its tests.
2. WP2: loop options (`onNoToolCalls`, `shouldStopAfterToolResults`, `continues`, result fields) and tests, including the stop-hook tests in 3a.
3. WP3: `finish_run` tool, registration checklist (section 2, steps 1 to 4) and tests.
4. WP4: config schema (`maxNudges` only, no `enabled`), `config/default.yaml`, schema tests.
5. WP5: judge wiring in `agent.ts` (opt-in by tool visibility, callbacks, side-effect gating, closure state).
6. WP6: `agent.llm.completed` fields and schema tests, and the activity timeline summary in `agent-activity-mapper.ts` with its tests (D9).
7. WP7: `long-running-task` skill: `requiredTools`, the new instruction section, the one changed sentence, and the `skills.test.ts` cases.
8. WP8: docs (`agent-runtime.md` section and cost review, CHANGELOG, this plan's status), baseline capture, then live verification.

WP1 to WP4 and WP6 are independent. WP5 depends on WP1 to WP4 and WP6. WP7 depends on WP3. WP8 last.

## Files expected to change

`apps/worker/src/structured-tool-loop.ts` (+ test), `apps/worker/src/continuation-guard.ts` (new, + test), `apps/worker/src/tools/finish-run.ts` (new, + test), `apps/worker/src/tools/index.ts`, `apps/worker/src/agent.ts`, `packages/domain/src/tools.ts`, `packages/domain/src/skills.ts` (edit `LONG_RUNNING_TASK_SKILL`) and `packages/domain/src/skills.test.ts`, `packages/domain/src/config/schema.ts` (+ test), `packages/domain/src/agent-protocol.ts` (+ test), `config/default.yaml`, `docs/best-practices/agent-runtime.md`, `CHANGELOG.md`, `apps/api/src/routes/agent-activity-mapper.ts` (+ `agent-activity-mapper.test.ts`), and `apps/web` only if the timeline does not already render summary text as plain text.

## Risks

- **Rubber-stamping.** A weak model may call `finish_run(complete)` without checking. The required reason and the recorded status make it visible; a stronger model or a sharper "done" definition in the skill are the remedies, not more platform logic.
- **Extra cost** from nudges (bounded by the cap), partly offset by the stop hook.
- **Side effects of the premature turn** if the `continues` gating is missed: premature text in history, `judgeResponseHistory` and the timeline. This is the highest-risk code change and must have a test.
- **Ending on `terminatedByLimit`** if the last-turn rule is missed.
- **Hook returns true too early** if `finish_run` is recorded before it succeeded. It must be recorded only from a successful tool result, and a test must cover a failed call.
- **`job-searcher` is not covered** by this plan (D6), so the original motivating agent keeps stopping early until the skills are reconciled.
- **Skill coupling:** `finish_run` is owned by `long-running-task`, so future skills that list it inherit that dependency (section 2, step 5).
- **No kill switch (D7).** With no flag, the behaviour starts when the image is released and stops only by releasing the previous image (or `maxNudges: 0` for the nudge alone). Mitigation: staging first, a baseline before the release, and the image pin, which already makes the rollout per environment and reversible.
- **Image/worker skew:** `maxNudges` is read by the agent image. A worker newer than the image sends a key the old image ignores, and the reverse gets the schema default (2). Both are safe; verify that an older image does not reject the new key (Zod object stripping unknown keys by default; confirm for `AgentRuntimePolicySchema`).
- **Classification as operational mechanics** is a judgement call that needs reviewer agreement (Agent Mode Purity).

## Open questions

None. Every question is decided (see "Decisions", D1 to D9).

Reviewer note (not a question): the instruction wording in section 5 is a draft for the owner to edit, since the owner will reconcile the `long-running-task` and job-search skills later.

## Acceptance criteria

- An agent without the `long-running-task` skill does not see `finish_run`, is never nudged, and its requests and loop behaviour are identical to today.
- There is no `continuationGuard.enabled` setting anywhere (schema, YAML, agent code).
- An agent that has `long-running-task` can call `finish_run`; the run ends right after that turn's tool calls with no further model call; `agent.llm.completed` carries `finishRunStatus`, `finishRunReason` and `nudgeCount`.
- A model that stops without `finish_run` is asked once per stop, up to `maxNudges`, with the agreed text, never on the last allowed turn; its premature reply is not written to history, response history or the timeline.
- A failed `finish_run` call does not end the run.
- `finishReason` values and `agent.tick.completed` outcomes are unchanged.
- The activity timeline summary of an LLM-completed event shows the `finish_run` status and reason, and the nudge count when above zero; it is unchanged when those fields are absent; severity is unchanged.
- `waiting` only records a status; it wakes nothing and schedules nothing.
- `maxNudges` comes from validated operator config with a schema default of 2 (`config/default.yaml`, inherited by staging and production).
- The registration checklist is complete (registry, catalog, skill, docs index) and its drift tests pass; existing `long-running-task` skill tests still pass.
- `pnpm lint`, `pnpm test` and `pnpm build` pass, and the stage B comparison is recorded in a `results.md` in this folder before production.

## Implementation Task List

Live verification, baseline capture, image release and `results.md` (Verification and Rollout sections) are operational and not part of this implementation.

- Task 1 (WP1): pure module `apps/worker/src/continuation-guard.ts` (nudge text constant, decision function) and tests - DONE
- Task 2 (WP2): loop options `onNoToolCalls`, `shouldStopAfterToolResults`, `continues`, `nudgesUsed`, `endedBy`, last non-empty assistant text, and tests incl. stop-hook tests - PENDING
- Task 3 (WP3): `finish_run` tool, registration checklist (section 2 steps 1-4, 6-8) and tests - PENDING
- Task 4 (WP4): config schema `continuationGuard.maxNudges` (no `enabled`), `config/default.yaml`, schema tests - PENDING
- Task 5 (WP6): `agent.llm.completed` fields (`nudgeCount`, `finishRunStatus`, `finishRunReason`) and activity timeline summary with tests - PENDING
- Task 6 (WP7): `long-running-task` skill `requiredTools`, ENDING A RUN section, changed sentence, `skills.test.ts` cases - PENDING
- Task 7 (WP5): judge wiring in `apps/worker/src/agent.ts` (opt-in by tool visibility, callbacks, side-effect gating on `continues`, closure state, payload fields) - PENDING
- Task 8 (WP8, docs only): `docs/best-practices/agent-runtime.md` section and cost review, CHANGELOG, plan status - PENDING

## Outstanding Issues
- Task 1 (: (low) test regex for time/budget wording includes 'left'/'limit'; WP2 must pass zero-based turnIndex.
