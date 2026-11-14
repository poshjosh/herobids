# Run-status hint for long-running agent runs (current time + run elapsed)

Status: IMPLEMENTED 2026-11-14 (WP1 to WP6), not committed, live A/B not yet run. Slimmed
the same day after reviewing live agents. Read "Will this solve the problem?" before
relying on it. The message text is the owner-approved one: `Current time is (UTC) ...; this
run has been in progress for ...`.

## Problem

Agents whose skill needs a long run (for example `openaidom/skills@job-search`) do not
work for as long as the skill allows. Two opposite failures were observed:

1. Under-running. `job-searcher` (old, `9e53f14b`, Haiku) ended each 5-minute discovery
   tick after 5 to 10 model turns and 2 `search_web` calls, about 25 s of a 300 s interval.
   `swift-hatch` (`0380f813`, Haiku, new skill text) did 5 to 6 web calls in its first two
   scheduled runs (47 s, 44 s), then drifted back to 2 web calls and about 27 s by 20:35
   and 20:40, while its own message said the coverage review was still due.
2. Over-running. `job-searcher` (new, `a148c598`, local Ollama qwen3.6:35b) stayed in one
   tick from 20:27:23 to past 20:48 (21+ minutes, about 28 model calls at 60 to 70 s each,
   45 tool calls, no message to the user), against a skill run budget of 2.5 minutes. It
   also wrote future timestamps (`completedAt 20:48:00Z` at 20:40:36).

Facts that frame the fix (read from `agent_messages` and code):

- Every finished tick ended with `finishReason: "stop"`: the model chose to stop.
  `runStructuredToolLoop` exits only when the model returns no tool calls.
- No platform limit is hit. Turn caps were 499 / 9,999 and are now 50 / 500 (changed
  2026-11-14, `DEFAULT_SCOUT_MAX_TURNS` / `DEFAULT_JUDGE_MAX_TURNS`). They count turns, not
  time, so they cap runaway loops and do not set run length.
- The skill (`openaidom-skills`, "Run budget" guide) now defines a run time budget (half
  the search interval, 1 to 30 minutes) and finish conditions. The agents read it: their
  reminder text quotes the budget.
- The model has no live clock. `Current time (UTC)` is written once into the system prompt
  at tick start (`buildSystemPrompt`, `runtime-composition.ts`), so it is stale after the
  first turn, and nothing reports how long the run has lasted. Agents fall back to
  estimating the time, and the estimates are wrong (checkpoints dated 1 to 8 minutes ahead).

## Will this solve the problem?

Partly. State this plainly to avoid over-selling.

- Over-running and wrong timestamps: likely helped. An agent that sees "this run has been
  in progress for 6m10s" next to a 2.5-minute budget has what it needs to stop, and it stops
  inventing times. Evidence: the qwen agent had no way to know it was at 20 minutes.
- Under-running: uncertain, probably not enough on its own. swift-hatch stopped at about
  20% of its budget with due work remaining. The cause looks like the model's tendency to
  wrap up after a report-sized chunk of work, not missing information, because it knew its
  start time (prompt) and the budget (skill). A "27s elapsed" line may nudge it to continue,
  but nothing forces it to.

So treat this as a cheap, low-risk experiment that fixes the clock, not as the fix for early
stops. If stage B (below) shows early stops persist, the reliable remedy is a continuation
guard (see "If this is not enough").

## Goals

- Give the judge a fresh, factual status line before each model call: current UTC time and
  how long this run has been working. Nothing else in the line.
- Keep it data only. No instruction and no limit: the skill supplies the budget.
- Record elapsed time and tool-call count on `agent.llm.completed` so before/after runs can
  be compared from the database.
- No context growth: the line is never stored in the message history.

## Non-goals

- No wall-clock cap on a run (decided: do not cap by minutes). `judgeMaxTurns` (500) and
  `scoutMaxTurns` (50) stay the only run limits. `sandboxDefaults.maxWallClockMs` is a
  whole-session limit that shuts the agent down; it stays 0 and is not used here.
- No countdown to the next reminder and no reminder-list refresh. The prompt already shows
  `Next scheduled reminder (UTC)`, and the skill budget is expressed as half the search
  interval, which the agent knows. This removes `pickNextReminder` and the mid-tick Redis
  re-read from the earlier draft.
- No turn or tool-call count in the line (they are recorded for measurement only).
- No continuation guard, no `finish_run` tool, no nudge when the model stops (separate plan).
- No skill-declared budgets in frontmatter or `SkillDefinition`.
- No change to the scout loop, reminder coordinator, tool-result truncation, model, or
  reasoning level. No new env var, so no `.example` change.

## Rule fit

- Agent Mode Purity (`docs/tech/agents/runtime-boundary-and-message-contract.md`): the line
  is the "Data" category (always provide; restricts nothing). No imperative wording.
- Configuration (`docs/best-practices/configuration.md`): operator config in
  `config/default.yaml` and `AgentRuntimeConfigSchema`, validated by Zod. No literals in code.
- Lessons #9 (context grows without bound): the line is ephemeral, see Design 2.
- `docs/best-practices/agent-runtime.md` "Cost Review Checklist" applies (touches the tick loop).

## Current state (verified by reading code)

| Area | File | Fact |
|---|---|---|
| Loop | `apps/worker/src/structured-tool-loop.ts` | `onBeforeTurn` returns a string or `{message, toolChoice}`; the string is `messages.push`ed, so it is permanent. Only the scout loop uses it (`agent.ts` ~4095). The judge loop (`agent.ts` ~4263) passes none. `messages` goes to `callLlmWithRetry` every turn. |
| Timing | `apps/worker/src/prompt-timing-context.ts` | `currentTimeIso` is built once per tick (`agent.ts` ~3793). |
| Tick start | `agent.ts` ~2786 | `const tickId = crypto.randomUUID()` marks tick start; no start timestamp is kept. |
| Events | `agent.ts` ~4444; `packages/domain/src/agent-protocol.ts` | `LLM_COMPLETED` carries `turnsUsed`, `finishReason`; validated by `LlmCompletedPayloadSchema` (~720). No elapsed time, no tool-call count. |
| Config | `schema.ts` `AgentRuntimeConfigSchema` (~1349), `AgentRuntimePolicySchema` | Reaches the agent container as `AGENT_RUNTIME_CONFIG_JSON`, parsed by `parseAgentRuntimePolicy` (`agent.ts` ~387). |
| Config | `config/default.yaml` `agentRuntime.reminders` | Has an uncommitted local change `minRepeatIntervalMs: 300000`. Not part of this work; do not stage it. |

## Design

### 1. Pure formatter: `apps/worker/src/run-status-hint.ts` (new)

```ts
export interface RunStatusInput {
  nowMs: number;
  runStartedAtMs: number;
}
export function formatRunStatusHint(input: RunStatusInput): string
```

Output is one line, facts only, sent as a `user` message. "Run" matches the skill's wording
("run time budget", "invocation"); the word "tick" is internal and is not defined in the
prompt. No label such as "platform status" is added: the owner chose the plain form.

```
Current time is (UTC) 2026-11-14T20:31:02Z; this run has been in progress for 46s
```

Elapsed is `46s` under a minute, `2m17s` under an hour, `1h5m` above (module-local
`formatElapsed`; `formatInterval`'s contract is unchanged). Milliseconds are dropped from the
time. "Run start" is the tick start, so it includes any scout phase before the judge loop.

### 2. Ephemeral per-turn injection in the loop

Add to `StructuredToolLoopOptions`:

```ts
getTurnContext?: (info: { turnIndex: number }) => string | undefined;
```

Before the LLM call the loop builds the request messages as
`[...messages, { role: 'user', content: ctx }]` when `getTurnContext` returns a string, and
does not push it into `messages`. With no turn context the request uses `messages` unchanged.
The loop does not count tool calls: `agent.ts` counts them in the judge `onToolResult`
(`judgeToolCallsUsed`), which keeps the loop's result shape unchanged.

Why not `onBeforeTurn`: its string is appended permanently. Over a long run that is one
copy of the line per turn, resent every turn, and the old copies show outdated times.

The line is the last message, but being last is not enough to keep the cached prefix. Anthropic's
automatic caching (the top-level `cache_control` that `llm-provider.ts` sends) puts its breakpoint on
the last block, which would be this line. Its hash changes every turn, so the entry is never read and
the whole history would be billed at the full input rate. The loop therefore marks the message
`volatile: true`, and `llm-provider.ts` puts an explicit `cache_control` on the message before it and
drops the top-level one (OpenRouter Claude models and Anthropic native). Other models are unchanged:
their caching is implicit and matches on leading tokens. If the previous message has no text to
carry the marker (an assistant turn with only tool calls), the request falls back to the old
top-level marker. Confirm with `cachedInputTokens` (Verification). `onBeforeTurn` and the scout loop
are unchanged.

### 3. Judge wiring in `agent.ts`

- Record `tickStartedAtMs = Date.now()` next to `const tickId` (~2786).
- Pass `getTurnContext` to the judge `runStructuredToolLoop` only when
  `agentRuntimePolicy.runStatusHint.enabled` and `turnIndex >= minTurnsBeforeShown`. Turn
  index 0 already has the tick-start time in the system prompt, so the default skips it.
- The thunk calls `formatRunStatusHint({ nowMs: Date.now(), runStartedAtMs: tickStartedAtMs })`.

### 4. Observability

Add optional `elapsedMs` and `toolCallsUsed` to the judge `LLM_COMPLETED` payload and to
`LlmCompletedPayloadSchema`. The schema is not `.strict()`, so a parse would have stripped
unknown keys; declaring the fields is what lets them reach `agent_messages`. The other
readers (`agent-message-broker.ts`, audit-only; `agent-activity-mapper.ts`, reads
`finishReason` and `phase`) are unaffected. Optional fields keep older agent images valid.

### 5. Config

```ts
runStatusHint: z.object({
  enabled: z.boolean().default(false),
  minTurnsBeforeShown: z.number().int().min(0).default(1),
}).default({}),
```

`config/default.yaml` under `agentRuntime`:

```yaml
runStatusHint:
  enabled: true              # per-turn run-status line (current UTC time, run elapsed) for the judge loop
  minTurnsBeforeShown: 1     # first judge turn that gets the line; 0 = from the very first turn
```

Schema default is `false`, so a missing key never changes prompts. `default.yaml` turns it on
for local dev. Config resolves `default.yaml` then `config/{NODE_ENV}.yaml`, so
`config/staging.yaml` and `config/production.yaml` each set `agentRuntime.runStatusHint.enabled:
false` explicitly; without that they would inherit `true`. Flip staging to `true` to start the
soak. The key reaches the agent container because `index.ts` spreads `appConfig.agentRuntime`
into `AGENT_RUNTIME_CONFIG_JSON`.

## Work packages

1. WP1: formatter and tests (`run-status-hint.ts`).
2. WP2: loop `getTurnContext`, `toolCallsUsed` counter, tests in `structured-tool-loop.test.ts`.
3. WP3: config schema field, `default.yaml`, `schema.test.ts`.
4. WP4: wiring (`tickStartedAtMs`, judge `getTurnContext`).
5. WP5: `elapsedMs` / `toolCallsUsed` on `LLM_COMPLETED`, schema and tests.
6. WP6: docs: short "Run status line" section in `docs/best-practices/agent-runtime.md`
   (data not policy, cost note); one `CHANGELOG.md` line under Added.

WP1 to WP3 are independent. WP4 depends on WP1 to WP3. WP5 can run in parallel with WP4.

## Test plan

Unit (behaviour-named):

- Formatter: "includes the current UTC time and the elapsed run time", "shows minutes and
  seconds under an hour", "shows hours and minutes above an hour".
- Loop: "sends the turn context to the model on the turns that return one", "does not add the
  turn context to the persisted message list" (call N's messages do not contain call N-1's
  line), "counts tool calls across turns", "behaves exactly as before when getTurnContext is
  not provided".
- Schema: defaults (`enabled: false`, `minTurnsBeforeShown: 1`); rejects a negative
  `minTurnsBeforeShown`; `LlmCompletedPayloadSchema` accepts the new optional fields.
- Wording guard: the formatted line contains none of "should", "must", "continue", "stop"
  so it cannot drift into policy.

Then focused `vitest run`, `pnpm lint`, `pnpm test`, `pnpm build` per `AGENTS.md`.

## Live verification (needs the local compose stack)

Baselines already captured (2026-11-14), same prompt and CV, skill text unchanged except
as noted:

| Agent | Model | Discovery runs |
|---|---|---|
| `job-searcher` (old) | Haiku, old skill | 5 to 10 turns, 25 to 65 s, 2 web calls |
| `swift-hatch` | Haiku, new skill | 47 s / 6 web, 44 s / 5 web, then 27 s / 2 web, 28 s / 2 web |
| `job-searcher` (new) | qwen3.6:35b local, new skill | one tick of 21+ min, about 28 model calls |

Stage A = new skill, line off (already running above). Stage B = new skill, line on, same
model as A. Compare model per model: Haiku with Haiku, qwen with qwen. Do not compare across
models. Use the `agent_messages` join on `payload->>'tickId'` for turns, duration, web calls
per discovery tick, and, after WP5, `elapsedMs` and `toolCallsUsed`. Also compare:

- Do runs end near the skill budget instead of at 20% or 700% of it?
- Are `completedAt` and checkpoint timestamps now within a few seconds of real time?
- Are listed pending listings opened in the same run?
- `cachedInputTokens` per turn (cache impact).

Proposed success bar for B over A (adjust after seeing A): Haiku runs reach the budget or
exhaust due work; qwen runs stop within a small multiple of the budget; timestamps are
accurate; cache-hit ratio drops by no more than a few percent. These are proposals, not
measured targets.

## Decision gate

Stage A is partly in: the skill change lengthened Haiku's first runs but did not hold, and
the qwen run overshoots. The clock gap is real in both. Build WP1 to WP5 if you want the
clock fixed; do not expect it to fully fix early stops (see above).

## If this is not enough: continuation guard (separate plan)

If Haiku still stops at a fraction of the budget with due work in its own run-state, the
reliable remedy is a guard in the loop, not more information:

- A `finish_run` tool (`complete` / `waiting` / `blocked`, with a reason) and, in the
  `toolCalls.length === 0` branch, a bounded number of "pending work remains, continue or
  call finish_run" nudges when the agent has not called it.
- It needs the budget to be known to the platform (skill metadata or creator config), a way
  to enable it per skill, and the same Agent Mode Purity review, because it pushes back on
  the agent's own decision. Not specified here.

## Risks and open items

- The line may be read as pressure to stop or to continue. Wording is neutral and guarded by
  a test. If stage B shows more early stops, remove the elapsed clause and keep only time.
- Trailing user message after tool results: the scout loop already does it, but the judge
  runs on other providers (OpenRouter/Anthropic, Ollama/qwen local). Verify each adapter in
  `packages/llm` accepts it; add a provider test if any path differs.
- Prompt-cache impact is expected to be nil (tail-only, ephemeral) but is unmeasured.
- Cost: about 30 tokens per turn from turn 1 on every judge loop, including trading agents.
  Run the "Cost Review Checklist".
- Overlapping runs: the qwen agent's 5-minute reminders fired while its tick was running. What
  the reminder coordinator does then is unchecked (no queued wake record was found). Check it
  before runs routinely approach the interval.
- Long runs hit stale tool-result truncation sooner (balanced style: 3 turns, 500 chars; only
  6 tools are pinned). Posting text from `browse_url` may be cut mid-run. Out of scope here;
  follow up if stage B shows validation quality dropping.
- The qwen agent produced no user message in 21 minutes. A run that overshoots is silent to
  the user; the skill's reporting rules do not cover that case.
- Duplicate skill: `swift-hatch` had two `job-search` skills attached (`ext_5ed356...` and
  `ext_54a85b...`). Cause unknown; check it does not affect the A/B.

## Rollout

1. Merge with `enabled: false` in the schema default; `default.yaml` true for local dev.
2. Soak on staging with an override; compare tokens per tick and cache hits against the
   Cost Review Checklist.
3. Enable in production through operator config. Roll back with `enabled: false` (config
   only; restart agents, because the policy is passed at container start).

## Acceptance criteria

- With the flag on, every judge turn from `minTurnsBeforeShown` carries one run-status line
  and the persisted history contains none.
- With the flag off, requests are byte-identical to today.
- `agent.llm.completed` (judge) includes `elapsedMs` and `toolCallsUsed`.
- `pnpm lint`, `pnpm test` and `pnpm build` pass; the tests above exist and pass.
- The per-model A/B comparison is recorded in this folder (`results.md`) before production.
