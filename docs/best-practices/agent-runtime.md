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
