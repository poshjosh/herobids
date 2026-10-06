# Agent Routine Tasks Program — Outline

**Status:** Draft
**Created:** 2026-10-06
**Area:** Agent runtime (ticks, wakes, reminders), system skills, agent UI

## Goal

Non-trading agents that have routine work to do at intervals are supported by the
system, so they succeed. Agents are still woken by user messages and other wake
signals, and an agent can change its own check-in (tick) interval within 15 min to
24 h based on its goal or skills.

**Precedence:** the plans in this folder take precedence over every existing plan
they overlap with (see [Precedence over existing plans](#precedence-over-existing-plans)).

## Parts

| Part | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 (MVP) | [Repeating reminders and routine visibility](./001-part1-repeating-reminders-mvp-plan.md) | `schedule_reminder` repeats (`repeatEveryMinutes`, `key`), `list_reminders`, `cancel_reminder`, a routines block in every judge prompt, a fix so active hours never block user messages, routine guidance in the task-management skill | none |
| 2 | [Agent-controlled tick interval](./002-part2-agent-controlled-tick-interval-plan.md) | `set_tick_interval` (15 min–24 h, persisted, resettable), open-position ceiling, cadence guidance in the base skill | Part 1 |
| 3 | [Schedule continuity and visibility](./003-part3-schedule-continuity-and-visibility-plan.md) | Time-of-day/timezone schedules, delivery acknowledgement and missed-run detection, schedules panel and clearer timeline, scout awareness | Parts 1 and 2 |

Each part ships on its own. Part 1 alone is enough for a non-trading agent to run a
routine reliably.

## Design rule: tick interval vs routine schedule

- **Tick interval** = how often the agent checks in unprompted. It is a cost knob
  and those ticks are gated (`context_hash`, scout).
- **Repeating reminder** = an obligation schedule. A reminder wake bypasses the
  `context_hash` gate and always reaches the judge.
- **Rule:** a routine runs when its reminder fires. Ordinary ticks don't run it
  unless it is overdue.

Mechanically the two compose: there is one tick timer, and a reminder can only pull
the next tick earlier (`apps/worker/src/agent.ts` `scheduleNextTick`,
`apps/worker/src/agent-wake-scheduler.ts`). The two clash cases are handled as
follows:

| Case | Effect | Handling |
|---|---|---|
| Reminder repeats more often than the tick interval | Reminder ticks become the effective cadence; every one is a judge run | Allowed (decision 7); operator minimum + spend budget cap it; Part 3 shows the effective cadence |
| Reminder repeats less often than the tick interval | Judge runs from `maxHoldDurationMs` or every 10th tick may redo the routine early or start a duplicate chain | Always-visible routines block, `key` upsert, skill rule (Part 1) |

Rejected alternative: using the tick interval as the routine clock. One interval
can't serve several routines; the timer restarts after every tick (so a user message
shifts the routine); restarts reset the phase; and the `context_hash` gate would have
to be disabled, making every tick a paid LLM run. The `context_hash` gate itself is
not changed by this program.

## Background (verified in code, 2026-10-06)

- For a non-trading agent the context-hash inputs never change, so nearly every
  scheduled tick is skipped as `context_unchanged`. A skip is bypassed by a wake or
  user message, every 10th tick (`FORCE_FULL_EVALUATION_EVERY_TICK`), or when
  `maxHoldDurationMs` has passed since the last judge run (careful 450 min,
  balanced 90 min, bold 10 min). The agent's self-driven judge cadence is therefore
  about max(tick interval, `maxHoldDurationMs`).
- `schedule_reminder` is one-shot; there is no list or cancel tool;
  `ReminderCoordinator` fires and deletes, with no lease across worker instances.
- The active-hours ("session") gate in `shouldSkipTick` runs first, ignores
  `hasWakeSignal`, and applies to every agent without open positions. Careful style
  ships `allowedHoursUtc: [14..20]`. From code reading, a careful non-trading agent's
  user message or reminder outside 14–20 UTC is skipped (not yet reproduced at
  runtime; Part 1 starts with a failing test).

## Decisions (defaults; the user can revisit)

| # | Decision | Part |
|---|---|---|
| 1 | Repeat interval bounds: min 15 min, max 31 days, from operator config | 1 |
| 2 | The agent may change its tick interval even when the creator set one; the creator value is the default it can reset to | 2 |
| 3 | The agent-chosen interval persists across restarts in an agent-owned Redis key, separate from creator config | 2 |
| 4 | Trading agents with open positions: operator ceiling on the effective tick interval (default 1 h), enforced by the runtime | 2 |
| 5a | User messages always bypass the active-hours gate | 1 |
| 5b | Reminders due outside the agent's active hours are held by the coordinator and fire once when the window opens (not dropped) | 1 |
| 5c | Style-default active hours apply only to agents with trading capability; active hours the creator set explicitly apply to every agent | 1 |
| 6 | Occurrences missed while the agent was stopped: fire once on return, continue on the original anchored schedule, report `missedOccurrences` | 1 |
| 7 | A reminder may repeat more often than the agent's tick interval (bounded by the operator minimum and spend budget) | 1 |
| 8 | One tool: `schedule_reminder` gains optional `repeatEveryMinutes` and `key`; the same `key` replaces the existing reminder | 1 |
| 9 | A creator edit of `tickIntervalMs` clears the agent's override | 2 |
| 10 | `ReminderCoordinator` runs on one worker at a time via a Redis lease (existing `SET NX EX` pattern) | 1 |

Decision 5 was revised during planning. The earlier proposal was "don't apply trading
hours to non-trading agents". The UI already exposes active hours as a generic
creator setting (`agents.runtimePolicy.allowedHoursUtc`: "Allowed active hours
(UTC)"), so ignoring hours the creator set explicitly would override user intent.
Only the style default is dropped for non-trading agents.

## Precedence over existing plans

| Existing plan | Relationship | What changes | Note added |
|---|---|---|---|
| [070 agent min tick interval extension](../../../../pending/070-agent-min-tick-interval-extension/001-plan.md) | Superseded | Replaced by Part 2 (persistent, bounded, raise or lower; not opt-in, not one-shot, not delay-only) | Yes |
| [071 skill-driven tick interval defaults](../../../../pending/071-skill-driven-tick-interval-defaults/001-plan.md) | Partially superseded | Still owns the creator default (Part 2's reset target); Part 2 owns agent-chosen values and their bounds | Yes |
| [000-capability-foundations/009 tool ownership manifest](../../../../pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md) | Compatible | Add `list_reminders`, `cancel_reminder` (task-management) and `set_tick_interval` (base) | Yes |
| [001 capability gating enforcement](../../../../pending/001-capability-gating-enforcement/001-plan.md) | Compatible | The new Redis-only tools join the ungated list next to `schedule_reminder` | Yes |
| [007 LLM cost attribution metrics](../../../../pending/007-llm-cost-attribution-metrics/001-plan.md) | Compatible | The `reminder` trigger source covers repeating reminders; no change | No |
| [trading-wording-cleanup](../../../../pending/trading-wording-cleanup/001-plan.md) | Compatible | Its "active hours" wording matches decision 5c | No |
