# Agent Runtime

Rules for the agent tick loop, wake system, and session resilience.

## Wake Taxonomy

Agent wakes are expensive — each wake triggers at minimum one LLM invocation. There are five valid wake sources:

| Source | Producer | Agent can act on it? |
|--------|----------|----------------------|
| `watch_threshold` | Market intelligence monitor | Yes — price crossed a user-defined level |
| `discovery_delta` | Market intelligence monitor | Yes — new token entered discovery set |
| `regime_change` | Market intelligence monitor | Yes — market regime flipped |
| `scanner` | Technical scanner (agent trading actor) | Yes — scanner found entry signals or exit advisories |
| `reminder` | Agent's own `set_reminder` tool | Yes — agent scheduled this itself |

**Nothing else is a valid wake source.** Do not add new `AgentWakeSource` enum values without a clear answer to "what can the agent do about this that it could not do on the next regular tick?"

## Non-Wakeable Events Rule

An event that the agent cannot remediate must not:
1. Produce an `agent.wake` signal, and
2. Emit an `instance.context.snapshot` to the outbound stream when there is no genuine position change

Violation of (2) is subtle but equally harmful: a spurious context snapshot invalidates the context-hash tick gate, causing the timer-based tick to invoke the LLM even though nothing actionable changed.

### Events that are non-wakeable by definition

| Event | Why non-wakeable |
|-------|-----------------|
| `reconciliation.drift_detected` | The agent cannot fix drift by reasoning about it. Drift is an infrastructure discrepancy between internal state and venue state. The reconciler resolves it autonomously. |
| `reconciliation.drift_within_threshold` | Same as above; already within acceptable bounds. |
| `stream.disconnect` | The reconnect handler manages reconnection without LLM involvement. |
| `strategy.error` (bot) | The bot's own circuit breaker handles this. The agent is notified via `strategy.fatal` only, which is a terminal event. |

### Adding a new event type

Before wiring a new event into the outbound stream or market monitor, answer:

1. **Can the agent change the outcome?** If no — it is non-wakeable.
2. **Does it represent a genuine state change the agent's context-hash gate would not detect?** If no — it does not need a snapshot.
3. **Does it happen repeatedly until resolved by infrastructure?** If yes — it must go through the session circuit breaker, not wake the agent.

## Session Circuit Breaker Rule

Every repeating error or degraded-state pattern that the agent cannot resolve by calling tools must be plumbed to the `SessionCircuitBreaker`, not just logged to the journal.

The breaker tracks sliding-window counts for:
- `strategy.error` — bot strategy crashing in a loop
- `reconciliation.drift_detected` — persistent state mismatch
- `stream.disconnect` — repeated connection failures

When a threshold is breached, LLM invocations are suppressed for a configurable cooldown and the session attempts a single probe tick. After `maxTrips` in one session, the agent terminates cleanly.

**Thresholds live in `config/default.yaml` under `agentRuntime.sessionCircuitBreaker`.** They must never be hardcoded.

If you add a new category of repeating failure, add a counter to the breaker config and wire the journal event to `sessionCircuitBreaker.record()` in `agent.ts`.

## Context Snapshot Discipline

`instance.context.snapshot` is a high-value message — it carries price, position, and PnL data that updates the agent's world model and, when changed, forces a full tick evaluation.

Rules:
- Emit a snapshot only when the underlying position state has genuinely changed (side, size, or price moved beyond noise).
- Do not emit a snapshot on a drift-only reconciliation pass where no position was added, removed, or resized.
- Do not emit a snapshot during a reconnect if the reconnect snapshot is identical to the last emitted one.

Emitting spurious snapshots wastes tokens even without a wake signal because the context-hash gate relies on snapshots to detect change.

## Run Status Line

The system prompt's `Current time (UTC)` is written once, when the tick starts, so it is stale after the
first turn of a long judge loop. With `agentRuntime.runStatusHint.enabled`, the judge loop sends one extra
final `user` message on each model call from `minTurnsBeforeShown`:

```
Current time is (UTC) 2026-11-14T20:31:02Z; this run has been in progress for 46s
```

Rules:
- Data only. The line states the time and elapsed run time. It carries no limit and no instruction; the
  skill or the creator sets any run budget (Agent Mode Purity: data is always provided, constraints are not
  injected).
- Ephemeral. It is built per request in `runStructuredToolLoop` (`getTurnContext`) and never added to the
  message list, so it does not grow the history that later turns resend (lessons #9). Do not move it to
  `onBeforeTurn`, which stores its message permanently.
- Off by default in the schema and in `staging.yaml` / `production.yaml`; on in `default.yaml` for local dev.
  Rollout and the per-model A/B are in `docs/features/2026/11/14/003-agent-run-status-hint/plan.md`.
- `agent.llm.completed` (judge) records `elapsedMs` and `toolCallsUsed` so run length can be compared from
  `agent_messages` without reading logs.
- Each time the line is sent, the agent container logs `Run status line sent to model` at `info` with
  `tickId`, `turnIndex` and `runStatusLine` (`docker logs herobids-agent-<id>`). It is `info`, not `debug`,
  because the agent logger has no level setting and `debug` would never print. The line holds no user or
  conversation content.

Caching: the line is sent as a `volatile` message. For Claude models `packages/llm` ends the prompt cache on
the message before it and omits the top-level `cache_control`, because a cache entry that includes a
per-turn changing block is never read again. Keep any future per-turn content after that breakpoint.

Cost: about 30 input tokens per judge turn from the second turn on. Run the checklist below before enabling it
in production.

## Output Budget And Length Recovery

Thinking shares a call's output-token limit. A limit that thinking can fill leaves no room for the answer, and
the call ends with finish reason `length` (Anthropic: `max_tokens`): an empty reply, or a tool call cut off mid-JSON
(`provider.invalid_tool_args`). Plan: `docs/features/2026/11/25/001-user-request-follow-through/plan.md`
(A1, A2, D13).

Output reserve rule (runtime policy):
- `judgeMaxTokens >= deepThinkingTokens + judgeOutputReserveTokens` and
  `scoutMaxTokens >= lightThinkingTokens + scoutOutputReserveTokens`. The reserves are per-style policy fields
  (defaults 16,384 judge and 4,096 scout) that a user can override within the ceilings. Style defaults and
  ceilings are in [Runtime Policy and Reasoning](../tech/agents/runtime-policy-and-reasoning.md).
- `resolveAgentRuntimePolicy` raises a resolved limit that breaks the rule (for example an older, lower
  override) to the sum, capped at the ceiling. The worker logs `Raised output-token limit so it leaves the
  output reserve after thinking` once per raised limit. The API returns the effective value.
- Per-model maximum. Each request is clamped to the model's maximum output, because the provider rejects a
  larger limit. The table is the built-in `DEFAULT_MAX_OUTPUT_TOKENS_BY_MODEL` merged with
  `llm.maxOutputTokensByModel` (an operator key adds a model or replaces the same key); a model not in it
  gets `llm.defaultMaxOutputTokens` (32,000). Add new models to the table when they ship.
- Reasoning step-down. For a model with a token thinking budget (the `llm.thinking` budgets), the reasoning
  level steps down (`high` → `medium` → `low` → `none`) while that budget plus the reserve exceeds the clamped limit.
  Effort-based models size their own thinking and keep the level. The agent logs each distinct adjustment
  once per process.
- Scaled timeout. Calls are not streamed, so each call's timeout is
  `max(base, min(limit × llm.timeoutMsPerOutputToken, llm.maxCallTimeoutMs))` (defaults 6 ms per token,
  600,000 ms cap). The base is `LLM_BASE_TIMEOUT_MS`, which the worker sets to the unscaled `llm.timeoutMs`.
  `LLM_TIMEOUT_MS` in the container is raised to fit the agent's largest limit, so an older agent image that
  uses it unscaled for every call still covers the raised limits.

Length recovery:
- A judge or scout call that ends with finish reason `length` (Anthropic: `max_tokens`), as cut-off tool
  arguments or an empty reply, is retried at most `llm.lengthRecovery.maxRetries` times per turn (default 1,
  max 3). Each retry steps the reasoning level one lower, never below `low`, and adds this line to the turn
  context only:

  > Your last response was cut off at the output limit. Think briefly and make smaller tool calls (split long file content across `append_file` calls).

- For cut-off tool arguments it replaces the identical retry, also once the recoveries are used up, because
  resending a cut-off request repeats the cut-off. An empty cut-off reply used to end the run with no retry;
  it now gets the recoveries. Other failures keep the normal retry. `0` turns recovery off and restores
  today's behaviour for both.
- An empty `length` reply followed by a recovery is not the end of the run; the empty-reply warning logs
  `continues: true`. Each recovery logs `Retrying LLM call cut off at the output limit with a lower reasoning
  level` with the old and new level. `agent.llm.completed` (judge) carries `lengthRecoveries` (absent when
  none).

Prompt size (Phase 1 text, measured 2026-11-26): the Instructions block gains about 400 characters on every
judge prompt (about 420 for a child agent) (report back on user requests); `BASE_SKILL.instructions` 8,493 → 8,702 characters (+209);
`LONG_RUNNING_TASK_SKILL` 6,465 → 7,186 (+721, only for agents with that skill).

Cost: billing is per token produced, so a higher limit costs nothing on calls that do not use it. Calls that
would have been cut off now complete, which costs more for that call but saves the retries and the wasted
run. For cut-off tool arguments, length recovery uses at most `llm.lengthRecovery.maxRetries` calls in place
of the retry policy's identical retries (default 1 instead of 2). An empty cut-off reply adds up to
`maxRetries` calls per turn, where the run used to end silently.

Rollback: release the previous worker and agent image together. Before that, clear any per-agent
`judgeMaxTokens` override above 16,384 or `scoutMaxTokens` above 4,096 (the previous schema rejects them).
Reverted token values in overrides take effect only once the previous worker runs, because this worker raises
an override below thinking + reserve.

Cost Review Checklist outcome (2026-11-26, Phase 1):
- New `requestWakeDrivenTick()` path: no.
- Conditional `instance.context.snapshot` emission: none added.
- New repeating failure mode: no. Recoveries are capped per turn by `llm.lengthRecovery.maxRetries`.
- `SessionCircuitBreaker` tests: `apps/worker/src/runtime-resilience.test.ts` passes (42 tests), and the full
  `pnpm test` passes, run on 2026-11-26 with Phase 1.

## Continuation Guard

Agents whose skill needs a long run can stop early, because a reply with no tool call ends the run. The
continuation guard gives the agent an explicit way to end a run and asks it to check before it stops.

- Tool. `finish_run` (`status`: `complete` (default), `waiting` or `blocked`; `reason`: optional, up to 300 characters, default `Done`; a blank reason also becomes `Done`). Called with no arguments it records `complete` / `Done`. It is
  delivered by the `system/long-running-task` skill and is not capability-gated.
- Stop hook. After a turn's tool calls have all run, `shouldStopAfterToolResults` ends the run if a
  `finish_run` call succeeded in that turn. There is no further model call. A call that fails validation
  records nothing and the loop continues.
- Nudge. When the model answers with no tool call, `finish_run` has not succeeded, and the nudge cap is not
  reached, `onNoToolCalls` appends the reply and a fixed user message asking the agent to check whether it is
  done, then calls the model again. It never fires on the last allowed turn, so it cannot cause a
  `turn_limit` stop. The decision is in `apps/worker/src/continuation-guard.ts`.
- Opt-in by skill. There is no enable flag. The nudge applies only when `finish_run` is visible to the agent
  (`allowedTools().has('finish_run')`) when the model stops. Agents without the tool, such as trading agents,
  behave exactly as before.
- `agentRuntime.continuationGuard.maxNudges` (default 2, schema default; `0` means tool and stop hook only).
  It is the only operator setting. To turn the feature off, release the previous agent image.
- Side-effect gating. A nudged turn is not the end of the run, so its reply is not written to cross-tick
  history, the judge response history or the activity timeline. Cost recording and billing still run for it.
- Waiting records only. `finish_run` with `waiting` is recorded, not acted on: it does not wake the agent or
  schedule anything. `schedule_reminder` stays the way to come back.
- Data. `agent.llm.completed` (judge) records `nudgeCount`, `finishRunStatus` and `finishRunReason`
  (optional). The `finish_run` status says why the agent stopped; it is not the `replied` / `no_reply`
  outcome of the tick, and `finishReason` values are unchanged. The timeline summary shows the status,
  reason and nudge count. The reason is model-written data, never an instruction.
- Agent Mode Purity. This is operational mechanics for ending a run. It adds no limit on what the agent may
  do and says nothing about time or budget; the skill defines "done" and the agent judges it.

Cost: each nudge is a full extra judge model call (the conversation is resent). With the default cap the
worst case is 2 extra calls per run. The stop hook saves the call that would otherwise follow `finish_run`.

Cost Review Checklist outcome (2026-11-17):
- New `requestWakeDrivenTick()` path: no. No wake source added; `waiting` does not wake anything.
- Conditional `instance.context.snapshot` emission: none added.
- New repeating failure mode: no. Nudges are capped per run by `maxNudges`, so no session circuit breaker
  wiring is needed. A failed `finish_run` counts in the tool circuit breaker like any tool, and hiding the
  tool only ends nudging.
- `SessionCircuitBreaker` tests: `apps/worker/src/runtime-resilience.test.ts` passes (42 tests) with this
  change, run on 2026-11-17 together with `continuation-guard.test.ts`. Re-run the full suite before release.

Rollout and verification (baseline, staging stage B, results) are in
`docs/features/2026/11/17/001-continuation-guard/plan.md`.

## Cost Review Checklist

Before merging any change that touches the tick loop, wake system, reconciler, or trading actor event emission:

- Does this change introduce a new code path that calls `requestWakeDrivenTick()`? If so, which `AgentWakeSource` does it use and is that source in the valid taxonomy above?
- Does this change emit `instance.context.snapshot` conditionally? Is the condition tight enough to prevent spurious emission on repeated error states?
- Does this change introduce a new repeating failure mode (a loop that can run thousands of times)? Is that failure mode plumbed to the session circuit breaker?
- Does the change pass `pnpm test` including the `SessionCircuitBreaker` unit tests?

## File Tools And Read Limits

The file tools (`read_file`, `read_file_lines`, `search_files`, `append_file`, `edit_file`, `list_files`, `delete_file`, `browse_url`) are bounded by operator config, not by literals in the tool code. See [File Tools](../tech/agents/tools/file-tools.md).

- Every limit lives in `agentRuntime.tools.files` or `tools.webAccess` and is validated by Zod. Defaults live in the schema only. A value over its maximum returns an error that names the maximum; nothing is clamped silently.
- A read returns at most one page (default 50,000 characters, max 500,000). The agent changes the size with `limit` or `maxChars`. A maximum page is about 125k tokens and can overflow a small-context model, so descriptions say so.
- The workspace quota is soft, per tier, and enforced inside the container by the file tools. It is not a disk limit.
- No tool deletes files automatically. A full web cache or workspace is reported to the agent, which frees space with `delete_file`.
- Cost note: the four added file tool schemas and instruction lines are sent on every model call for agents with `file-management`. Measured sizes are in the feature [results](../features/2026/11/15/001-agent-file-tools/results.md). A change that adds a tool or lengthens a description must re-measure.
- Tool results older than `toolResultFullRetentionTurns` are cut, and the marker states how much was kept. `maxToolResultChars` only limits the copy stored in history, not what the model sees in the current run.
