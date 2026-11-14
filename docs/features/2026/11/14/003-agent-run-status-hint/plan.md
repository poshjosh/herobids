# Per-turn run-status hint for long-running agent ticks

Status: DRAFT (not started). Owner decision needed on the gate in "Decision gate".

## Problem

Agents whose skill needs a long run (for example `openaidom/skills@job-search`) end each
tick after a handful of tool calls, even though the skill allows far more.

Evidence, from agent `job-searcher` (`9e53f14b-2045-4854-b0e4-22d725ab8c99`, local compose,
paused 2026-11-14 16:36 UTC, read from `agent_messages`):

- 17 ticks. Every one ended with `agent.llm.completed.finishReason = "stop"` after 2 to 19
  model turns (5 s to 106 s). The judge cap is `maxTurns: 9999`, so the cap never applied.
- `runStructuredToolLoop` (`apps/worker/src/structured-tool-loop.ts`) exits only when the
  model replies with no tool calls. There is no wall-clock limit and no per-tick tool cap.
- A typical 5-minute "discovery run" was: restore state (about 5 calls), 2 `search_web`
  calls, save state, `send_message`, stop. About 25 s of a 300 s interval.
- The agent wrote its own reminder text "Run one bounded discovery batch (Step 5), save
  results, then Step 8", so it scoped each run down itself.
- After a user answer the tick wrote "Next I'll look for... and check it is still live" and
  then stopped without doing it.

Skill-side causes (ambiguous "bounded runs", no finish condition) are handled by the
`job-search` skill change in `openaidom-skills` (CHANGELOG "Changed" entry, 2026-11-14).
This plan covers the platform-side data the model lacks when deciding whether to continue.

### What the model cannot currently see

- The system prompt is built once per tick (`buildSystemPrompt`, `runtime-composition.ts`),
  so "Current time (UTC)" is frozen at tick start and goes stale within a long loop.
- Nothing tells the model how long the tick has run, how many tool calls it has made, or how
  long until the next scheduled wake. A skill that sets a run time budget (the
  `job-search` skill uses half the search interval, 1 to 30 minutes) cannot be followed
  without that data. The agent in the evidence above also
  wrote timestamps such as `16:40:00Z` while the real time was about 16:35.

## Goals

- Give the judge a small, factual, per-turn "run status" block: fresh time, tick elapsed,
  turns used, tool calls used, time until the next scheduled reminder.
- Keep it data only. No instruction, no limit. The skill or the creator supplies policy.
- Add the same numbers to `agent.llm.completed` so before/after runs are measurable from
  the database without log scraping.
- Zero context growth: the hint is never persisted into the message list.

## Non-goals

- No continuation guard, no `finish_run` tool, no nudge when the model stops (option 3 in
  the investigation). Separate plan if this one is not enough.
- No skill-declared budgets in frontmatter or `SkillDefinition`.
- No change to `maxTurns`, the scout loop, reminder coordinator, or tool result truncation.
- No change to the model, reasoning level, cost preset, or style defaults.
- No new env var, so no `.example` change.

## Rule fit

- Agent Mode Purity (`docs/tech/agents/runtime-boundary-and-message-contract.md`): the
  hint is the "Data" category (always provide; restricts nothing). It must not contain
  imperative wording such as "continue" or "you should stop".
- Configuration (`docs/best-practices/configuration.md`): operator-level, so it lives in
  `config/default.yaml` and `AgentRuntimeConfigSchema`, validated by Zod at startup. No
  literals in code.
- Lessons #9 (context grows without bound): the hint is ephemeral (see Design 2).
- `docs/best-practices/agent-runtime.md` "Cost Review Checklist" applies, because this
  touches the tick loop. See Rollout.

## Current state (verified by reading code)

| Area | File | Fact |
|---|---|---|
| Loop | `apps/worker/src/structured-tool-loop.ts` | `onBeforeTurn` returns a string or `{message, toolChoice}`; the string is `messages.push`ed, so it is permanent. Only the scout loop passes it (`agent.ts` ~4095). The judge loop (`agent.ts` ~4263) passes none. |
| Loop | same | `messages` is passed to `callLlmWithRetry` each turn; tool results are appended with `addedAtTurn`. No tool-call counter exists. |
| Timing | `apps/worker/src/prompt-timing-context.ts` | `PromptTimingContext` has `currentTimeIso`, `nextReminderIso` (soonest reminder at tick start). Built once at `agent.ts` ~3793. |
| Reminders | `agent.ts` ~2951, `reminders/reminder-schedule.ts` | `runtimeState.metrics.scheduledReminders` is loaded from Redis once per tick, sorted by `triggerAt`, capped by `promptMaxEntries`. `advanceRepeatingReminder` computes the next slot on the grid. |
| Events | `agent.ts` ~4444 | `LLM_COMPLETED` carries `turnsUsed`, `finishReason`. No elapsed time, no tool-call count. |
| Config | `packages/domain/src/config/schema.ts` `AgentRuntimeConfigSchema` (~1349); `AgentRuntimePolicySchema` (~1589) | Reaches the agent container as `AGENT_RUNTIME_CONFIG_JSON`, parsed by `parseAgentRuntimePolicy` (`agent.ts` ~387). |
| Config | `config/default.yaml` `agentRuntime.reminders` (~692) | Has an uncommitted local change `minRepeatIntervalMs: 300000`. Not part of this work; do not stage it. |

## Design

### 1. Pure formatter: `apps/worker/src/run-status-hint.ts` (new)

```ts
export interface RunStatusInput {
  nowMs: number;
  tickStartedAtMs: number;
  turnsUsed: number;          // completed model turns in this loop
  maxTurns: number;
  toolCallsUsed: number;
  nextReminder: { key?: string; atMs: number } | null;
}
export function formatRunStatusHint(input: RunStatusInput): string
export function pickNextReminder(reminders: readonly ReminderRecord[], nowMs: number): { key?: string; atMs: number } | null
```

Output is one line, facts only:

```
Run status: time (UTC) 2026-11-14T16:37:12Z; tick elapsed 2m17s; model turns 12 of 9999; tool calls 11; next scheduled reminder "js-discovery" at 16:40:21Z (in 3m09s)
```

- Omit the reminder clause when `nextReminder` is null.
- Reuse `formatInterval` from `prompt-timing-context.ts` if its output suits; otherwise add a
  small `formatElapsed` (m/s) in the new module. Do not widen `formatInterval`'s contract.
- `pickNextReminder`: for each reminder, if `triggerAt > now` use it; if it is in the past and
  repeating, use `advanceRepeatingReminder({ triggerAtMs, repeatEveryMs, nowMs }).nextTriggerAtMs`;
  if it is in the past and one-shot, skip it. Return the earliest. This keeps the value correct
  when a tick outlasts the reminder interval, without re-reading Redis.

### 2. Ephemeral per-turn injection in the loop

Add to `StructuredToolLoopOptions`:

```ts
getTurnContext?: (info: {
  turnIndex: number;
  turnsRemaining: number;
  toolCallsUsed: number;
}) => string | undefined;
```

In the loop, count `toolCallsUsed` (sum of `toolCalls.length` after each turn). Before the
LLM call, build the request messages as `[...messages, { role: 'user', content: ctx }]` when
`getTurnContext` returns a string. Do not push it into `messages`.

Why not reuse `onBeforeTurn`: its string is appended permanently. At about 60 tokens per turn
over a 50-turn tick that is 3k tokens of noise resent every turn (lessons #9), and old copies
of "time" would contradict the new one.

Cache note: the block is the last message and never persisted, so the cached prefix is
unchanged. Confirm with `cachedInputTokens` before and after (see Verification).

`onBeforeTurn` behaviour and the scout loop stay unchanged. The two options compose: an
`onBeforeTurn` hint is still appended permanently, then the ephemeral block goes last.

### 3. Judge wiring in `agent.ts`

- Record `tickStartedAtMs` at tick start (next to `const tickId`, ~2786).
- Pass `getTurnContext` to the judge `runStructuredToolLoop` only when
  `agentRuntimePolicy.runStatusHint.enabled` and `turnIndex >= minTurnsBeforeShown`. Turn
  index 0 already has the tick-start system prompt, so the default skips it.
- Inputs: `Date.now()`, `tickStartedAtMs`, `turnIndex`, `judgeLoopConfig.maxTurns`,
  `toolCallsUsed` from the loop, `pickNextReminder(runtimeState.metrics.scheduledReminders, now)`.
- Staleness fix: `scheduledReminders` is read once at tick start, so a reminder the agent
  creates or cancels mid-tick is missing. In `onToolResult`, when `toolCall.name` is
  `schedule_reminder` or `cancel_reminder` (confirm the exact cancel tool name in
  `tools/tasks.ts`) and the result succeeded, re-run the existing reminder load routine (the
  code at ~2951, extracted into a function if it is inline) before the next turn. If that
  extraction is larger than expected, ship without it and label the clause "at tick start".

### 4. Observability

Extend the `LLM_COMPLETED` payload for the judge phase with `elapsedMs` and `toolCallsUsed`.
The payload is validated by `LlmCompletedPayloadSchema` (`packages/domain/src/agent-protocol.ts`,
registered ~720). Add both fields there as optional so older agent images still validate. Check
whether the schema is `.strict()` (it would reject unknown keys), and check the other readers:
`agent-message-broker.ts` (audit-only, ~394) and `apps/api/src/routes/agent-activity-mapper.ts`
(~26, reads `finishReason` and `phase`). Add a schema test for the new optional fields.

### 5. Config

`AgentRuntimeConfigSchema`:

```ts
runStatusHint: z.object({
  enabled: z.boolean().default(false),
  minTurnsBeforeShown: z.number().int().min(0).default(1),
}).default({}),
```

`config/default.yaml` under `agentRuntime`:

```yaml
runStatusHint:
  enabled: true                # per-turn run-status block (time, elapsed, turns, tool calls, next reminder) for the judge loop
  minTurnsBeforeShown: 1       # first judge turn that gets the block; 0 = from the very first turn
```

Schema default is `false` so a missing key never changes prompts; `default.yaml` turns it on
for local dev. Staging and production stay off until the soak in Rollout.

## Work packages

1. WP1, formatter: `run-status-hint.ts` + `run-status-hint.test.ts`.
2. WP2, loop: `getTurnContext`, `toolCallsUsed` counter, tests in `structured-tool-loop.test.ts`.
3. WP3, config: schema field, `default.yaml`, `schema.test.ts` defaults and refusal of bad types.
4. WP4, wiring: `tickStartedAtMs`, judge `getTurnContext`, reminder refresh on reminder tools.
5. WP5, observability: `elapsedMs`, `toolCallsUsed` on `LLM_COMPLETED`, plus type/schema updates.
6. WP6, docs: short "Run status hint" section in `docs/best-practices/agent-runtime.md`
   (what it is, that it is data not policy, cost note); `CHANGELOG.md` one line under Added.

WP1 to WP3 are independent. WP4 depends on WP1 to WP3. WP5 can go in parallel with WP4.

## Test plan

Unit (behaviour-named, per repo convention):

- `formatRunStatusHint`: "includes elapsed time and tool-call count", "omits the reminder
  clause when none is scheduled", "shows minutes and seconds for sub-hour elapsed".
- `pickNextReminder`: "returns the earliest future reminder", "advances a past repeating
  reminder to its next grid slot", "ignores a past one-shot reminder", "returns null for an
  empty list".
- Loop: "sends the turn context to the model on the turns that return one", "does not add the
  turn context to the persisted message list" (assert call N's messages do not contain call
  N-1's hint), "counts tool calls across turns", "behaves exactly as before when
  getTurnContext is not provided".
- Schema: defaults (`enabled: false`, `minTurnsBeforeShown: 1`), rejects negative
  `minTurnsBeforeShown`.
- Wording guard: a test asserting the formatted hint contains none of "should", "must",
  "continue", "stop" so it cannot drift into policy (Agent Mode Purity).

Verification commands: focused `vitest run` on the touched test files, then `pnpm lint`, then
`pnpm test` and `pnpm build`, per `AGENTS.md`.

## Live verification (needs the local compose stack)

Baseline, already captured from `job-searcher` before any change (skill unchanged):
discovery ticks used 5 to 10 model turns, 25 to 65 s, 2 `search_web` calls; median about 9 turns.

Run in three stages on the same agent prompt and CV, resetting the agent between stages:

- A: new `job-search` skill, hint disabled. Measures option 1 alone.
- B: new skill plus hint enabled. Measures option 2's added effect.

Query (from `agent_messages`, per `agent.tick.started` / `agent.tick.completed` /
`agent.llm.completed` joined on `payload->>'tickId'`; after WP5 also read `elapsedMs` and
`toolCallsUsed`). Compare: turns per discovery tick, tick duration, `search_web` +
`browse_url` calls per discovery tick, whether unverified leads are opened in the same run,
and `cachedInputTokens` per turn.

Proposed success bar for B over A (adjust after seeing A): discovery ticks reach the skill's
run time budget or exhaust due work (no "I'll do it next run" hand-offs), and cache-hit ratio
drops by no more than a few percent. These thresholds are proposals, not measured targets.

## Decision gate

Build this only if stage A (skill change alone) still leaves discovery ticks ending far below
the skill's run budget. If A is enough, close this plan. Stage A needs no code.

## Risks and open items

- Models may read a status line as pressure to stop or to continue. Wording is neutral and
  guarded by a test; if stage B shows early stops increase, drop the turn/tool-count clause
  and keep only time data.
- Trailing user message after tool results: the scout loop already does this, but the judge
  runs on other providers (OpenRouter/Anthropic, Ollama/qwen local). Verify each provider
  adapter in `packages/llm` accepts it; add a provider test if any path differs.
- Prompt-cache impact is expected to be nil (tail-only, ephemeral) but is unmeasured.
- Cost: about 60 tokens per turn from turn 1 on every judge loop, including trading agents.
  Negligible next to resent history, but run the agent-runtime "Cost Review Checklist".
- Overlapping ticks (a reminder firing while a long tick runs) are not addressed here; the
  reminder coordinator's behaviour in that case has not been checked and should be before
  runs routinely approach the interval length.
- Long runs hit stale tool-result truncation sooner (balanced style: 3 turns, 500 chars; only
  6 tools are pinned). Posting text from `browse_url` may be cut mid-run. Out of scope here;
  track as a follow-up if stage B shows validation quality dropping.
- Open question: should a skill be able to declare its run budget so the platform can show
  "budget remaining"? Deferred; this plan keeps the budget in skill text.

## Rollout

1. Merge with `enabled: false` in schema default; `default.yaml` true for local dev.
2. Soak on staging with an override, compare tokens per tick and cache hits against the
   Cost Review Checklist.
3. Enable in production via operator config. Roll back by setting `enabled: false` (config
   only, restart agents to pick it up, since the policy is passed at container start).

## Acceptance criteria

- With the flag on, every judge turn from `minTurnsBeforeShown` carries one run-status line
  and the persisted history contains none.
- With the flag off, requests are byte-identical to today.
- `agent.llm.completed` (judge) includes `elapsedMs` and `toolCallsUsed`.
- `pnpm lint`, `pnpm test`, `pnpm build` pass; the new tests above exist and pass.
- The live A/B comparison is recorded in this folder (`results.md`) before enabling in production.
