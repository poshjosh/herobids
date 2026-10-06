# Part 1 (MVP): Repeating Reminders and Routine Visibility

**Status:** Draft
**Created:** 2026-10-06
**Program:** [Outline](./000-outline.md) · Next: [Part 2](./002-part2-agent-controlled-tick-interval-plan.md) · [Part 3](./003-part3-schedule-continuity-and-visibility-plan.md)
**Precedence:** this program takes precedence over overlapping plans (see the outline).

## Summary

Today a routine depends on the agent re-scheduling a one-shot reminder every cycle
(e.g. `docs/agents/skills/flight-deal-monitoring.md`). One missed re-schedule ends
the routine silently. The agent can't list or cancel reminders, so after a restart or
history trim it either loses its routine or creates a duplicate. Separately, the
active-hours gate can skip user messages and reminders, and the careful style's
trading hours (14–20 UTC) apply to non-trading agents.

After this part:

- An agent schedules a routine once with `schedule_reminder` + `repeatEveryMinutes` +
  `key`. The platform re-schedules each occurrence, including across restarts.
- The agent sees its reminders on every judge tick and can list and cancel them.
- User messages are never blocked by active hours. Reminders due outside active hours
  wait for the window and fire once.
- **Every agent gets task and reminder tools.** The task-management tools and
  instructions move into the auto-injected base skill, and the base skill explains how
  to run routine work. Agents are meant to help people, and scheduling ("remind me",
  "every morning…") is basic to that.

Design rule (see the [outline](./000-outline.md#design-rule-tick-interval-vs-routine-schedule)):
a routine runs when its reminder fires; ordinary ticks don't run it unless it is
overdue. The `context_hash` gate is not changed.

## Decisions

From the [outline](./000-outline.md#decisions-defaults-the-user-can-revisit): 1, 5a, 5b,
5c, 6, 7, 8, 10, 11.

## Verified vs assumed

Verified by reading code (2026-10-06):

- `apps/worker/src/tools/tasks.ts`: one-shot `schedule_reminder` writes
  `agent:reminders:{agentId}` (hash field = UUID); `scheduledBy = ctx.phase`;
  `ReminderRecord` is exported from here and imported by the coordinator.
- `apps/worker/src/reminder-coordinator.ts`: hard-coded `POLL_INTERVAL_MS = 10_000`;
  polls `agentRepo.listActiveAgents()`; `JSON.parse(...) as ReminderRecord` (no Zod);
  `emitAgentWake` then `HDEL`; publish failure leaves the record. No lease.
- Lease precedent: `SET key workerId EX ttl NX` in
  `apps/worker/src/alerting/alert-dispatcher.ts`,
  `apps/worker/src/agents/actor-event-relay.ts`, and
  `apps/worker/src/market-intelligence/leader-election.ts`.
- `ReminderWakeContextSchema` lives in `packages/domain/src/trading/trading-protocol.ts`
  (relocated 2026-09-07; a copy exists in traderton).
- Reminder ticks reach the judge: `isEarlyTickTriggerType` sets `hasWakeSignal`
  (`apps/worker/src/tick-gate-state.ts`), and `resolvePreScoutDecision` forces
  escalation for `scheduledBy: 'judge'` (`apps/worker/src/scout-gating.ts`). The scout
  only gets `read-*` tools, so it can't schedule reminders.
- `shouldSkipTick` (`apps/worker/src/tick-gates.ts`): the session gate runs first,
  ignores `hasWakeSignal`, and applies when `!hasOpenPositions`.
  `apps/worker/src/agent.ts` (~line 431) builds `tradingHours` from
  `resolvedRuntimePolicy` for every agent. `agent.ts` (~line 2747) folds
  `hasPendingUserMessage` into `hasBufferedWake`.
- `AgentRuntimeConfigSchema` (`packages/domain/src/config/schema.ts`) reaches the
  worker as `appConfig.agentRuntime` and the container via `agentRuntimeConfigJson`
  (`apps/worker/src/index.ts` ~line 180) → `AGENT_RUNTIME_CONFIG_JSON` →
  `AgentRuntimePolicySchema`.
- The context hash takes explicit inputs only (`computeDecisionContextHash`), so new
  prompt state does not change it.
- Tool names are registered in `KNOWN_AGENT_TOOL_NAMES` and the tool metadata map in
  `packages/domain/src/tools.ts`; skill text and ownership live in
  `packages/domain/src/skills.ts` (`TOOL_OWNER_OVERRIDES` is empty).
- `BASE_SKILL` is auto-injected for every agent and is not stored in the DB. Its tools
  are excluded from `buildToolOwnershipMap`/`inferDependsOn`.
- References to the `task-management` id or `system/task-management` slug:
  - `SKILL_PRESET_MAP['personal-assistant']`, `SYSTEM_SKILLS` and `SYSTEM_SKILL_SLUGS`
    (`packages/domain/src/skills.ts`).
  - The worker's built-in skill map (`apps/worker/src/agent.ts` ~line 478).
  - Platform docs data (`apps/worker/src/tools/platform-docs-data.ts`,
    `scripts/ts/build-docs-index.ts`).
  - Tests in domain, db, api, web and worker.
  - Existing agents' `agent_skills` rows (any agent created with the
    personal-assistant preset).
- Markdown skills `docs/agents/skills/flight-deal-monitoring.md` and
  `docs/agents/skills/personal-property-locator-tools.md` re-schedule manually with
  `schedule_reminder`.

Assumed (verify during implementation):

- More than one worker instance can run (implied by the existing leader election).
- The agent rows returned by `listActiveAgents()` carry `style` and
  `runtimePolicyOverrides`, so the coordinator can resolve active hours.
- External trading skills appear in `resolvedSkills` with `capabilityFamilies`
  containing `trading` (used by `deriveHasTradingCapability`).
- `apps/worker/src/agents/agent-session-manager.ts` is the single place that builds
  `resolvedRuntimePolicy` for the container.

## Detailed plan

### 1. Regression tests first (active hours)

File: `apps/worker/src/tick-gates.test.ts`

Add failing tests before any change:

- "does not skip a user-message tick outside active hours"
- "does not skip a reminder-wake tick outside active hours"
- "still skips a market-wake tick outside active hours for an agent with no open positions" (behaviour kept)

### 2. Operator config

Files: `packages/domain/src/config/schema.ts`, `config/default.yaml`,
`packages/domain/src/config/schema.test.ts`

Add `reminders` to `AgentRuntimeConfigSchema`:

```ts
reminders: z.object({
  pollIntervalMs: z.number().int().min(1_000).default(10_000),
  minRepeatIntervalMs: z.number().int().min(60_000).default(900_000),      // 15 min
  maxRepeatIntervalMs: z.number().int().min(60_000).default(2_678_400_000), // 31 days
  maxActivePerAgent: z.number().int().min(1).default(50),
  promptMaxEntries: z.number().int().min(1).default(10),
  coordinatorLeaseTtlSeconds: z.number().int().min(5).default(30),
}).refine((r) => r.minRepeatIntervalMs <= r.maxRepeatIntervalMs, { message: 'minRepeatIntervalMs must be <= maxRepeatIntervalMs' })
  .default({}),
```

Add the matching `agentRuntime.reminders` block to `config/default.yaml` with one
inline comment per key. `pollIntervalMs` replaces the coordinator's literal. No env
overrides: this is structured policy (configuration best practices). No `.env`
changes.

### 3. Reminder record and schedule math (new module)

New files: `apps/worker/src/reminders/reminder-record.ts`,
`apps/worker/src/reminders/reminder-schedule.ts` (+ tests)

- `ReminderRecordSchema` (Zod): `id`, `message`, `triggerAt` (next due, ISO),
  `scheduledBy`, plus optional `createdAt`, `key`, `repeatEveryMs`, `anchorAt`,
  `lastFiredAt`. New fields are optional, so existing records still parse.
- `parseReminderRecord(raw: string): Result<ReminderRecord, { code: 'reminder.malformed' }>`.
- `computeNextOccurrence({ anchorAt, repeatEveryMs, firedSlotAt, now })` returns
  `{ nextTriggerAt, missedOccurrences }`. Here `nextTriggerAt` = anchor + k × interval
  for the smallest k with a time after `now`, and `missedOccurrences` = slots between
  `firedSlotAt` and `now` that weren't fired. Pure, no I/O.
- Move the `ReminderRecord` type here; `tools/tasks.ts` and the coordinator import it.

### 4. Tools

Files: `apps/worker/src/tools/tasks.ts`, `apps/worker/src/tools/index.ts`,
`packages/domain/src/tools.ts` (+ tests)

- Convert `taskTools` to `createTaskTools({ reminders })`. The registry builder in
  `tools/index.ts` already passes deps to factories (e.g.
  `createBrowserTools(deps?.browserPool)`); pass `agentRuntimePolicy.reminders` the
  same way.
- `schedule_reminder`:
  - New optional params: `repeatEveryMinutes` (int, bounds from config) and `key`
    (`^[a-z0-9][a-z0-9_-]{0,63}$`). `triggerAt` stays required and becomes the anchor
    for repeats.
  - If a reminder with the same `key` exists, replace it. Return
    `{ reminderId, triggerAt, repeatEveryMinutes, key, replaced, previousReminderId }`.
  - Reject when the agent already has `maxActivePerAgent` reminders (and isn't
    replacing by key).
  - Error codes: `reminder.invalid_interval`, `reminder.limit_exceeded`.
  - Description: say it can repeat, and that the same `key` replaces.
- New `list_reminders` (category `read-memory`, so the scout can use it too). It
  returns reminders sorted by `triggerAt` with `reminderId`, `key`, `message`,
  `nextTriggerAt`, `repeatEveryMinutes`, `anchorAt`, `lastFiredAt`.
- New `cancel_reminder` (category `write-memory`): `{ reminderId? , key? }`, exactly
  one (Zod refine). Returns `{ found }`; error code `reminder.invalid_target`.
- `packages/domain/src/tools.ts`: add `list_reminders` and `cancel_reminder` to
  `KNOWN_AGENT_TOOL_NAMES` and the metadata map, and update the `schedule_reminder`
  metadata description.
- Concurrency note: key upsert is a read-modify-write on the agent's own hash. Tool
  calls for one agent run sequentially, so no lock is added.

### 5. ReminderCoordinator

File: `apps/worker/src/reminder-coordinator.ts` (+ test)

- **Lease:** only the lease holder polls, using
  `SET reminder-coordinator:lease <workerId> EX <coordinatorLeaseTtlSeconds> NX` with
  renewal, as in `alert-dispatcher.ts`. The constructor takes `workerId` and the
  `reminders` config (`apps/worker/src/index.ts` ~line 829).
- Poll every `reminders.pollIntervalMs`.
- Parse each record with `parseReminderRecord`; warn and skip malformed ones (as
  today).
- **Active hours (5b):** resolve the agent's active hours with the same rule as the
  runtime (section 6). If the agent is outside its window, don't fire; the reminder
  stays pending and fires once the window opens.
- **Fire:** `emitAgentWake` with the extended context (section 7).
- **After a successful publish:**
  - One-shot: `HDEL` (unchanged).
  - Repeating: `HSET` the updated record (`triggerAt = nextTriggerAt`,
    `lastFiredAt = now`).
  - Publish failure: no change; retried next poll (unchanged).
- Inactive agents are still not polled, so an overdue reminder fires once on return
  with `missedOccurrences` (decision 6).

### 6. Active-hours gate

Files: `apps/worker/src/tick-gates.ts`, `apps/worker/src/tick-gate-state.ts`,
`apps/worker/src/agent.ts`, `packages/domain/src/config/schema.ts`,
`apps/worker/src/agents/agent-session-manager.ts`

- `TickGateState` gains `hasUserMessage?: boolean` and `hasReminderWake?: boolean`.
  The session gate skips only when both are false. The reminder bypass covers
  boundary races; the coordinator already holds reminders outside the window. Market
  wakes keep today's behaviour.
- `buildTickGateState` derives the two flags:
  - `hasUserMessage` from `isUserMessageType` on incoming messages, or the new
    `hasPendingUserMessage` param.
  - `hasReminderWake` from an incoming `agent.wake` whose `payload.source` is
    `reminder`, or a buffered reminder.
- `agent.ts`: pass `hasPendingUserMessage` on its own instead of folding it into
  `hasBufferedWake`.
- **Decision 5c:** style-default active hours apply only to agents with trading
  capability.
  - `resolveAgentRuntimePolicy` gains an options argument
    `{ applyStyleActiveHours?: boolean }` (default `true`, so existing callers are
    unchanged). When it's `false`, `allowedHoursUtc`, `weekendPause` and
    `tradingSessions` come only from `runtimePolicyOverrides`.
  - The session manager passes `false` for agents without trading capability; the
    coordinator uses the same resolution.
  - The UI display of effective hours is a Part 3 follow-up.

### 7. Wake contract

File: `packages/domain/src/trading/trading-protocol.ts` (+ test)

Extend `ReminderWakeContextSchema` with optional `key`, `repeatEveryMs`,
`scheduledFor`, `missedOccurrences` and `nextTriggerAt`. Optional-only additions keep
old payloads valid and stay wire-compatible with the traderton copy. Moving the
schema out of the trading module is out of scope.

### 8. Prompt

Files: `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`,
`apps/worker/src/prompt-timing-context.ts` (+ tests)

- **Load reminders each tick.** In `agent.ts`, load `agent:reminders:{agentId}` once
  per tick, next to the memory enrichment load (~line 2611). Parse the records and
  store them in `runtimeState.metrics.scheduledRoutines`, sorted by next due and
  capped at `promptMaxEntries`. On failure, warn and continue.
- **New context provider `scheduled-routines`.** It is `free`, `dynamic` and
  `preserveWhenTrimmed`. Title: "Your scheduled reminders". Example line:
  `- [daily_report] Send the daily summary — repeats every 24h; last fired 2026-10-06T09:00Z; next 2026-10-07T09:00Z`
  When over the cap, it ends with "N more (use list_reminders)". It renders nothing
  when there are no reminders.
- **Extend the `reminder-context` block** (`RuntimeReminderContext` and its population
  at ~line 2014) with:
  - repeats every X, or one-shot
  - scheduled for vs delivered at
  - missed occurrences
  - next occurrence
- **Timing context.** `prompt-timing-context.ts` gains an optional
  `Next scheduled reminder (UTC): …` line.
- The context hash is unchanged; reminders are not hash inputs.

### 9. Fold task management into the base skill

Files: `packages/domain/src/skills.ts`, `apps/worker/src/agent.ts` (built-in skill map
~line 478), `apps/worker/src/tools/platform-docs-data.ts`,
`scripts/ts/build-docs-index.ts`, affected tests (domain, db, api, web, worker), and a
data migration in `packages/db` (see below).

**`BASE_SKILL`:**
- Description: "Core tools: memory, tasks, reminders, messaging, cost tracking, and
  schema fetching. Auto-injected into every agent."
- `requiredTools`: add `create_task`, `list_tasks`, `resolve_task`, `complete_task`,
  `schedule_reminder`, `list_reminders`, `cancel_reminder`.
- Instructions: move the current `TASK_MANAGEMENT_SKILL` tool lines in, updating the
  `schedule_reminder` line to mention repeats. Then append the "Routine work" text in
  section 10.

**Remove `TASK_MANAGEMENT_SKILL`** (preferred over keeping an empty alias, which
would show a no-op skill in the catalog and in `list_skills`):
- Delete it from `SYSTEM_SKILLS` (and so from `SYSTEM_SKILL_SLUGS`) and from the
  worker's built-in skill map.
- `SKILL_PRESET_MAP['personal-assistant']` becomes `['web-access', 'email']`.
- Existing data:
  - **Migration:** delete `agent_skills` rows with `skill_id = 'task-management'`, then
    the `skills` row and its revisions. Check foreign keys and revision history in the
    `packages/db` schema before writing the delete.
  - **Fail-soft fallback:** until the migration runs, descriptor resolution and the
    `add_skills` tool skip the id/slug `task-management` / `system/task-management`
    with a log line, so they never error. `add_skills` returns "already included in
    the base skill".
  - `syncSystemSkills` only upserts, so it won't recreate the row.
- Platform docs data and the docs-index script: remove the task-management entry and
  update the preset mapping text.

**Effects to accept:**
- Prompt size: every agent gets 7 more tool schemas. Check against
  `maxVisibleToolSchemas` (careful 32) so no agent loses a tool it relies on.
- `inferDependsOn`: skills listing `schedule_reminder` or `create_task` no longer
  depend on `task-management`. That's correct, since base tools are universal.
- Capability gating stays as today: these tools are Redis-only and ungated.

### 10. Routine guidance and docs

Files: `packages/domain/src/skills.ts`, `docs/agents/skills/flight-deal-monitoring.md`,
`docs/agents/skills/personal-property-locator-tools.md`,
`docs/agents/prompts/security-audit-prompt.md`,
`docs/tech/agents/wake-signal-and-technical-scan.md`,
`docs/tech/agents/skill-authoring.md`, `docs/tech/configuration.md` (if it indexes
`agentRuntime` keys)

- Append to the `BASE_SKILL` instructions (skill-authoring tone):

  ```text
  Routine work:
  - If you have work that repeats on a schedule, you can schedule it once with `schedule_reminder` using `repeatEveryMinutes` and a stable `key` (e.g. `daily_report`). The platform schedules each next occurrence for you, including across restarts.
  - Scheduling again with the same `key` replaces the existing reminder instead of adding a second one.
  - Your scheduled reminders are listed in your context. You can also use `list_reminders` to check them and `cancel_reminder` to stop one.
  - A routine is normally done when its reminder arrives. On other ticks, you can check your scheduled reminders before doing routine work early.
  - You can record each completed run with `set_memory` so you can tell whether an occurrence was handled.
  - When a reminder arrives late or reports missed occurrences, you can decide whether one catch-up run is enough.
  ```

- `flight-deal-monitoring.md`: replace "use `schedule_reminder` to trigger the next
  scan" with repeating reminders keyed `scan` and `report`.
- `personal-property-locator-tools.md`: replace "`schedule_reminder` for the next
  tick" with one repeating reminder keyed `sweep`.
- Markdown skills may keep listing these tools in `requiredTools`; they're base tools,
  so this is harmless.
- `security-audit-prompt.md`: change "Use task-management…" to "Use tasks
  (`create_task`)…".
- `skill-authoring.md`: note that task and reminder tools come with the base skill.
- `wake-signal-and-technical-scan.md`: add a reminders section covering repeats,
  key, lease, active-hours hold, and missed occurrences.

## Testing plan

Test names describe behaviour.

**Domain**
- Reminder config defaults load, and min > max is rejected.
- `ReminderWakeContextSchema` accepts both old and extended payloads.
- `resolveAgentRuntimePolicy` without style active hours keeps creator-set hours and
  drops style defaults.
- `BASE_SKILL` includes the task and reminder tools.
- `SYSTEM_SKILLS` no longer contains `task-management`.
- The personal-assistant preset maps to `web-access` and `email`.
- A markdown skill requiring `schedule_reminder` infers no dependency.
- An agent with a stale `task-management` assignment resolves without error and still
  has reminder tools.
- `add_skills('system/task-management')` reports that it's already included.

**Worker: schedule math**
- Next occurrence stays anchored after a late fire.
- Missed occurrences are counted after an outage.
- An exact-boundary `now` advances to the next slot.

**Worker: tools**
- A repeat below the minimum or above the maximum is rejected.
- The same key replaces the existing reminder and reports `replaced`.
- The per-agent limit is enforced.
- `list_reminders` sorts by next due.
- `cancel_reminder` works by id and by key, and an unknown target returns
  `found: false`.
- A one-shot reminder behaves as before.

**Worker: coordinator**
- A one-shot reminder fires and is removed.
- A repeating reminder fires and is re-scheduled.
- A publish failure keeps the reminder.
- No lease means no fire.
- A reminder due outside active hours waits, then fires once with a missed count.
- Malformed records are skipped.

**Worker: gate**
- The section 1 tests pass.
- Style-default hours don't apply to a non-trading agent.
- Creator-set hours do apply.

**Worker: prompt**
- The routines block renders, caps, and is absent when there are no reminders.
- The reminder block shows repeat, missed and next lines.
- The context hash is unchanged by reminder state.

**Suite:** `pnpm lint`, focused Vitest runs, then
`scripts/shell/tests/run-all-tests.sh`.

## Implementation order

1. Failing gate tests (section 1), then the gate fix and active-hours resolution (section 6).
2. Config (section 2).
3. Record and schedule module (section 3).
4. Tools and domain registry (section 4).
5. Coordinator (section 5).
6. Wake contract and prompt (sections 7 and 8).
7. Fold task management into base: fallback first, then remove the skill and add the
   migration (section 9).
8. Routine guidance and docs (section 10).
9. `pnpm lint`, focused tests, full suite.

## Risks

- **Cost:** every reminder tick is a judge run, so a 15-minute repeat is ~96 judge
  runs a day. Mitigation: operator minimum, spend budget, and the effective-cadence
  display in [Part 3](./003-part3-schedule-continuity-and-visibility-plan.md).
- **Duplicate fires across workers.** Mitigation: the coordinator lease.
- **Runaway reminder creation.** Mitigation: `maxActivePerAgent` and key upsert.
- **Removing the `task-management` skill touches existing data and many tests.**
  Mitigation: the fail-soft fallback ships before the migration; the migration only
  deletes rows for a skill whose tools every agent now has.
- **More tool schemas per agent.** Mitigation: check `maxVisibleToolSchemas` per style
  and raise the careful default if needed.
- **Behaviour changes, accepted by decisions 5a/5c:**
  - Trading agents now answer user messages outside active hours.
  - Careful non-trading agents are no longer limited to 14–20 UTC unless the creator
    set those hours.
- **Prompt growth.** Mitigation: `promptMaxEntries`.
- **Traderton copy of the wake contract.** Mitigation: optional fields only.

## Non-goals

- Time-of-day and timezone schedules, delivery acknowledgement, UI
  ([Part 3](./003-part3-schedule-continuity-and-visibility-plan.md)).
- Agent-chosen tick interval ([Part 2](./002-part2-agent-controlled-tick-interval-plan.md)).
- Any change to the `context_hash` gate or `maxHoldDurationMs`.
- Editing a reminder in place; use key replacement.

## Open decisions (minor)

1. Key replacement issues a new `reminderId` and returns the previous one.
   Recommendation: yes.
2. One-shot reminders can also take a `key`. Recommendation: yes.
