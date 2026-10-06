# Part 1 (MVP): Repeating Reminders, Base Task Tools, Ungated Check-ins

**Status:** Ready for implementation (reviewed 2026-10-06)
**Created:** 2026-10-06
**Program:** [Outline](./000-outline.md) · Later: [Part 2 (optional)](./002-part2-agent-controlled-tick-interval-plan.md) · [Part 3](./003-part3-schedule-continuity-and-visibility-plan.md)
**Precedence:** this program takes precedence over any existing plan it overlaps with (see the outline's precedence table).

## How to use this plan

This document is self-contained: an implementer needs only this file plus the repo's
`AGENTS.md`. Line numbers are approximate (`~`); find code by the symbol names given.
Work through the work packages (WP) in order. Each WP ends with its own tests, and
`pnpm lint` must pass after each one. Don't implement Part 2 or Part 3.

Repo rules that matter here (from `AGENTS.md`):
- No magic numbers: limits and intervals go in operator config
  (`config/default.yaml` + Zod in `packages/domain/src/config/schema.ts`).
- Zod at boundaries (Redis reads, tool params).
- `Result`/`ok()`/`err()` with dot-namespaced error codes.
- Tool names are `verb_noun`, and tests are named after behaviour.
- Don't swallow errors: log and continue for non-fatal reads.

## Goal

Non-trading agents that do routine work at intervals run reliably. They're still woken
by user messages and other wake signals. After this part:

1. **Repeating reminders.** An agent schedules a routine once
   (`schedule_reminder` + `repeatEveryMinutes` + `key`), and the platform re-schedules
   every occurrence, including across restarts. The agent can list and cancel
   reminders, and sees them in every judge prompt.
2. **Every agent has task and reminder tools.** They move into the auto-injected base
   skill, and the `task-management` system skill is removed.
3. **Non-trading agents check in once a day, without skipping.** A new per-agent
   setting, "skip unchanged check-ins", is on for trading agents and off for others.
   Non-trading agents default to a 24 h check-in.
4. **Active hours never block user messages or reminders,** and the careful style's
   default hours (14–20 UTC) apply only to trading agents.

## Background (why; verified in code 2026-10-06)

- **Every scheduled tick is checked by the gates in `shouldSkipTick`
  (`apps/worker/src/tick-gates.ts`):**
  - The session (active-hours) gate runs first. It ignores wake signals and applies
    whenever the agent has no open positions.
  - The `context_hash` gate then skips the tick (`reason: 'context_unchanged'`)
    unless a wake or user message arrived (`hasWakeSignal`), it's every 10th tick, or
    `maxHoldDurationMs` has passed (checked in `apps/worker/src/agent.ts` ~line 2888).
  - A non-trading agent's hash inputs never change, so nearly all its scheduled ticks
    are skipped.
- **Ticks that aren't skipped go to the scout, which can hold.** The pre-scout logic in
  `resolvePreScoutDecision` (`apps/worker/src/scout-gating.ts`) forces the judge for
  the first tick, user messages, and reminders scheduled by the judge.
- **Reminders today:**
  - `schedule_reminder` (`apps/worker/src/tools/tasks.ts`) is one-shot. It writes a
    JSON record to Redis hash `agent:reminders:{agentId}` (field = reminder UUID).
  - `ReminderCoordinator` (`apps/worker/src/reminder-coordinator.ts`) polls every
    10 s, only for agents with status `active`, and calls
    `eventPublisher.emitAgentWake(...)` with `source: 'reminder'`. It deletes the
    record after a successful publish; a failed publish leaves it for retry.
  - The coordinator has no lease, so with more than one worker a reminder could fire
    twice.
  - A reminder wake sets `hasWakeSignal` (`apps/worker/src/tick-gate-state.ts`
    `isEarlyTickTriggerType`). It bypasses the `context_hash` gate, but not the
    session gate.
- **Tick timing:** there's one tick timer (`scheduleNextTick` in `agent.ts`
  ~line 2273). After any tick, the next is `now + effectiveTickIntervalMs`. Wakes only
  pull it earlier.

## Decisions (final)

| # | Decision |
|---|---|
| D1 | Repeat interval bounds: 15 min to 31 days, from operator config. |
| D2 | `schedule_reminder` gains optional `repeatEveryMinutes` and `key`. Scheduling with an existing `key` replaces that reminder: it gets a new `reminderId`, and the result returns the previous one. One-shot reminders may also have a `key`. `triggerAt` stays required (it's the first occurrence). |
| D3 | A reminder may repeat more often than the agent's tick interval, bounded only by the operator minimum and the spend budget. |
| D4 | Occurrences missed while the agent was stopped fire once on return. The schedule continues on its original slots, and the wake reports `missedOccurrences`. |
| D5 | User messages and reminder wakes always bypass the active-hours gate. Market wakes and plain scheduled ticks still respect it. |
| D6 | Style-default active hours (`allowedHoursUtc`, `weekendPause`, `tradingSessions` from the style) apply only to agents with trading capability. Hours the creator set explicitly in `runtimePolicyOverrides` apply to every agent. |
| D7 | `ReminderCoordinator` runs on one worker at a time via a Redis lease. |
| D8 | Task and reminder tools move into `BASE_SKILL`. `TASK_MANAGEMENT_SKILL` is removed, old references fail soft, and a data migration removes its rows. |
| D9 | New per-agent setting `skipUnchangedTicks`: `null` = default (`true` for trading agents, `false` otherwise). When `false`, scheduled ticks skip neither the `context_hash` gate nor the scout; they go straight to the judge. |
| D10 | Non-trading agents created without an explicit tick interval get 24 h, from operator config. Trading agents keep the style intervals. |
| D11 | No migration of existing agents' intervals. Nothing is live, and the one non-trading staging agent is set to 24 h manually by the operator. |

"Trading capability" everywhere means: at least one resolved skill has
`capabilityFamilies` containing `'trading'`. The worker already has
`deriveHasTradingCapability(resolvedSkills)` (`apps/worker/src/agent-capabilities.ts`);
reuse it or move it to `@herobids/domain` if the API needs it too.

## Work packages

### WP1. Active-hours gate (D5, D6) — DONE

**1a. Failing tests first** (`apps/worker/src/tick-gates.test.ts`):
- "does not skip a user-message tick outside active hours"
- "does not skip a reminder-wake tick outside active hours"
- "still skips a market-wake tick outside active hours when the agent has no open positions"
- "still skips a plain scheduled tick outside active hours"

**1b. Gate change:**
- `TickGateState` gains `hasUserMessage?: boolean` and `hasReminderWake?: boolean`.
- In `shouldSkipTick`, the session gate skips only if both are false (in addition to
  its current conditions).
- `buildTickGateState` (`tick-gate-state.ts`) sets:
  - `hasUserMessage` from `isUserMessageType` on any incoming message, or a new param
    `hasPendingUserMessage`.
  - `hasReminderWake` from any incoming message with `type === 'agent.wake'` and
    `payload.source === 'reminder'`, or a new param `hasBufferedReminderWake`.
- In `agent.ts` (~line 2747), `hasPendingUserMessage` is folded into
  `hasBufferedWake`. Also pass it separately as `hasPendingUserMessage`, and pass
  `hasBufferedReminderWake: runtimeState.metrics.currentReminder !== null` (set when
  the buffered wake drained is a reminder).

**1c. Style-default hours only for trading agents (D6):**
- `resolveAgentRuntimePolicy(style, overrides)` (`packages/domain/src/config/schema.ts`
  ~line 381) gains a third argument, `options?: { hasTradingCapability?: boolean }`.
  - When `hasTradingCapability === false`, `allowedHoursUtc`, `weekendPause` and
    `tradingSessions` come only from `overrides`. If unset, the fallbacks are `[]`,
    `false` and `null`.
  - When the argument is omitted, behaviour is unchanged.
- It has three callers. Pass the option in all of them:
  - `apps/worker/src/agents/agent-session-manager.ts` (~line 526): compute
    `hasTradingCapability` from `runtimeDescriptor.resolvedSkills`, which is already in
    scope.
  - `apps/api/src/routes/agent-config-helpers.ts` `decorateAgentResponse` (~line 494)
    and `validateMaxHoldDurationInvariant` (~line 533): compute it from the agent's
    skill ids. Reuse the logic behind `hasSkillCapabilityFamily(skillIds, 'trading')`
    used in `apps/api/src/routes/agents.ts` (~line 226), and check that it recognises
    external trading skills (e.g. `traderton/skills/crypto-trading`).

**Tests:**
- `resolveAgentRuntimePolicy` drops style hours for non-trading agents and keeps
  creator-set hours.
- Session-manager config includes the resolved hours.

### WP2. Reminder config (D1, D7) — DONE

Add to `AgentRuntimeConfigSchema` (`packages/domain/src/config/schema.ts` ~line 1142):

```ts
reminders: z.object({
  pollIntervalMs: z.number().int().min(1_000).default(10_000),
  minRepeatIntervalMs: z.number().int().min(60_000).default(900_000),        // 15 min
  maxRepeatIntervalMs: z.number().int().min(60_000).default(2_678_400_000),  // 31 days
  maxActivePerAgent: z.number().int().min(1).default(50),
  promptMaxEntries: z.number().int().min(1).default(10),
  coordinatorLeaseTtlSeconds: z.number().int().min(5).default(30),
}).refine((r) => r.minRepeatIntervalMs <= r.maxRepeatIntervalMs, {
  message: 'minRepeatIntervalMs must be <= maxRepeatIntervalMs',
}).default({}),
nonTradingDefaults: z.object({
  tickIntervalMs: z.number().int().min(60_000).default(86_400_000),          // 24 h
}).default({}),
```

Add the matching blocks under `agentRuntime:` in `config/default.yaml`, with one inline
comment per key.
- Nothing extra is needed to reach the container. `AgentRuntimePolicySchema` extends
  `AgentRuntimeConfigSchema`, and `apps/worker/src/index.ts` (~line 180) already
  forwards `appConfig.agentRuntime`, so `agentRuntimePolicy.reminders` is available in
  `agent.ts`.
- No env vars and no `.env` changes.

**Tests:** defaults load; min > max is rejected.

### WP3. Reminder record and schedule math — DONE

New module `apps/worker/src/reminders/`:

**`reminder-record.ts`:** the Zod `ReminderRecordSchema` replaces the interface in
`tools/tasks.ts`. Update the imports in `tools/tasks.ts` and the coordinator.

```ts
{ id: string; message: string; triggerAt: string /* ISO, next due slot */;
  scheduledBy?: 'scout' | 'judge';
  createdAt?: string; key?: string; repeatEveryMs?: number;
  anchorAt?: string /* first slot */; lastFiredAt?: string; firedAt?: string /* legacy */ }
```

- Every new field is optional, so existing records still parse.
- `parseReminderRecord(raw: string): Result<ReminderRecord, { code: 'reminder.malformed' }>`.

**`reminder-schedule.ts`:** a pure function that runs when the coordinator fires a due
repeating reminder.

```ts
advanceRepeatingReminder({ triggerAtMs, repeatEveryMs, nowMs }):
  { nextTriggerAtMs: number; missedOccurrences: number }
// precondition: triggerAtMs <= nowMs
// missedOccurrences = floor((nowMs - triggerAtMs) / repeatEveryMs)
//   (slots after the due one that are also already past; they are not fired separately)
// nextTriggerAtMs  = triggerAtMs + (missedOccurrences + 1) * repeatEveryMs   // always > nowMs
```

**Tests:**
- On time → 0 missed, next = due + interval.
- Three intervals late → 3 missed, and the next slot stays on the original grid.
- `now` exactly on a later slot → that slot counts as missed, and next is strictly
  after `now`.

### WP4. Tools (D1, D2, D3) — DONE

Files: `apps/worker/src/tools/tasks.ts`, `apps/worker/src/tools/index.ts`,
`packages/domain/src/tools.ts`

**Wiring:** export `createTaskTools(config: { reminders: ReminderConfig })` instead of
the `taskTools` array. In `tools/index.ts`, follow how other factories receive deps
(e.g. `createBrowserTools(deps?.browserPool)`) and pass the reminders config from
`agentRuntimePolicy.reminders`.

**`schedule_reminder`:**
- **New optional params:**
  - `repeatEveryMinutes` (int). Its ms value must be within `[minRepeatIntervalMs, maxRepeatIntervalMs]`, else `reminder.invalid_interval`.
  - `key` (`/^[a-z0-9][a-z0-9_-]{0,63}$/`).
- **Validation unchanged:** `triggerAt` must be in the future.
- **Same `key` exists:** delete the old field, write the new record, and set
  `replaced: true` and `previousReminderId`.
- **Limit:** if not replacing and the agent already has `maxActivePerAgent` records,
  return `reminder.limit_exceeded`.
- **New record:** `{ id, message, triggerAt, scheduledBy: ctx.phase, createdAt, key?, repeatEveryMs?, anchorAt: triggerAt (if repeating) }`.
- **Result:** `{ ok, reminderId, triggerAt, repeatEveryMinutes?, key?, replaced, previousReminderId? }`.
- **Description:** "Schedule a reminder at an absolute datetime (ISO 8601 UTC). It can
  repeat with `repeatEveryMinutes`. Scheduling with an existing `key` replaces that
  reminder."

**`list_reminders`** (new, category `read-memory`, so the scout can use it too):
- No params.
- Returns `{ reminders: [{ reminderId, key, message, nextTriggerAt, repeatEveryMinutes, anchorAt, lastFiredAt }] }`, sorted by `nextTriggerAt`.
- Skips malformed records with a warn log.

**`cancel_reminder`** (new, category `write-memory`):
- Takes `{ reminderId?: string; key?: string }`, exactly one (Zod refine, else `reminder.invalid_target`).
- Returns `{ ok, found }`.

**`packages/domain/src/tools.ts`:** add both names to `KNOWN_AGENT_TOOL_NAMES` and to
the metadata map (~line 247), and update the `schedule_reminder` description there.

**Concurrency:** key replacement is a read-then-write on the agent's own hash. One
agent's tool calls run sequentially, so no lock is needed.

**Tests:**
- Below-minimum and above-maximum repeats are rejected.
- The same key replaces and reports the previous id.
- The limit is enforced, but not when replacing.
- A one-shot reminder without a key behaves exactly as before.
- List is sorted.
- Cancel works by id and by key; an unknown target returns `found: false`; both or
  neither target is rejected.

### WP5. ReminderCoordinator (D4, D5, D7) — DONE

File: `apps/worker/src/reminder-coordinator.ts` (constructed in
`apps/worker/src/index.ts` ~line 829)

**Constructor:** add `workerId` and `config: ReminderConfig`
(`appConfig.agentRuntime.reminders`). Replace `POLL_INTERVAL_MS` with
`config.pollIntervalMs`.

**Lease:** each poll, before scanning:
- If not holding it: `SET reminder-coordinator:lease <workerId> EX <ttl> NX`. Skip the
  poll unless the result is `OK`.
- If holding it: renew it. Copy the acquire/renew/release pattern in
  `apps/worker/src/alerting/alert-dispatcher.ts` (~line 111).
- Release on `stop()`.

**Per record:**
- Parse with `parseReminderRecord`; warn and skip malformed records.
- Skip records with a legacy `firedAt` (as today).
- Skip records that aren't due yet.

**Due record:**
- **Repeating:** compute `{ nextTriggerAtMs, missedOccurrences }` with
  `advanceRepeatingReminder`. One-shot reminders have `missedOccurrences = 0`.
- **Emit** `emitAgentWake` with
  `context: { reminderId, message, scheduledBy, key?, repeatEveryMs?, scheduledFor: triggerAt, missedOccurrences, nextTriggerAt? }`.
- **On success:**
  - One-shot: `HDEL` (unchanged).
  - Repeating: `HSET` the record with `triggerAt = nextTriggerAt` and
    `lastFiredAt = now`.
- **On failure:** leave the record unchanged and log an error (retried next poll).

**Unchanged:**
- The coordinator does no active-hours check. The runtime gate lets reminder wakes
  through (D5).
- Inactive agents are still not polled, so overdue reminders fire once when the agent
  is active again (D4).

**Tests:**
- One-shot fires and is removed.
- Repeating fires and is re-scheduled on the grid.
- Late repeating fires once with a missed count.
- A failed publish leaves the record unchanged.
- Without the lease nothing fires.
- Malformed records are skipped.

### WP6. Wake contract and prompt — DONE

**Wake contract** (`packages/domain/src/trading/trading-protocol.ts`): add optional
fields to `ReminderWakeContextSchema`:
- `key: z.string()`
- `repeatEveryMs: z.number().int()`
- `scheduledFor: z.string().datetime()`
- `missedOccurrences: z.number().int().min(0)`
- `nextTriggerAt: z.string().datetime()`

Optional-only additions keep old payloads valid. A copy of this file exists in the
separate traderton repo; it doesn't need changing.

**Reminder block on the tick it fires** (`apps/worker/src/runtime-composition.ts`):
- Extend `RuntimeReminderContext` (~line 49) and its population from the wake
  (~line 2014) with the new fields.
- The `reminder-context` provider (~line 1028) adds these lines:
  - `Repeats every: 24h` or `One-shot`
  - `Scheduled for: <ISO>`
  - `Missed occurrences: <n>` (only if > 0)
  - `Next occurrence: <ISO>`

**Always-visible reminder list:**
- In `agent.ts`, once per tick and next to the agent-memory load (~line 2611), read
  `agent:reminders:{agentId}` (`HGETALL`) and parse each entry. Store the result,
  sorted by `triggerAt` and capped at `promptMaxEntries`, in a new
  `runtimeState.metrics.scheduledReminders`. Also store the total count.
- On a Redis error, warn and keep the previous value.
- New context provider `id: 'scheduled-reminders'`, modelled on `reminder-context`
  (`costTier: 'free'`, `section: 'dynamic'`, `preserveWhenTrimmed: true`):
  - Title: "Your scheduled reminders".
  - One line each, e.g.
    `- [daily_report] Send the daily summary — repeats every 24h; last fired 2026-10-06T09:00Z; next 2026-10-07T09:00Z`.
  - Ends with `…and N more (use list_reminders)` when capped.
  - Returns `null` when there are none.

**Timing line:** `apps/worker/src/prompt-timing-context.ts` gets an optional
`nextReminderIso`, rendered as `Next scheduled reminder (UTC): <ISO>`. Pass the earliest
`triggerAt` from the list above.

**Do not** add reminders to the context hash (`computeDecisionContextHash` inputs stay
the same).

**Tests:**
- The list block renders, caps and is absent when empty.
- The fire block shows the repeat, missed and next lines.
- The timing line shows the next reminder.
- The hash is identical with and without reminders.

### WP7. Task and reminder tools move into the base skill (D8) — DONE

File: `packages/domain/src/skills.ts`

**`BASE_SKILL`:**
- `description`: "Core tools: memory, tasks, reminders, messaging, cost tracking, and
  schema fetching. Auto-injected into every agent."
- `requiredTools`: append `create_task`, `list_tasks`, `resolve_task`,
  `complete_task`, `schedule_reminder`, `list_reminders`, `cancel_reminder`.
- `instructions`: move in the five tool lines from `TASK_MANAGEMENT_SKILL` (update the
  `schedule_reminder` line to mention repeating and `key`), then the WP8 text.

**Remove `TASK_MANAGEMENT_SKILL`:**
- **Domain:** delete the constant and its entry in `SYSTEM_SKILLS`.
  `SYSTEM_SKILL_SLUGS` is derived from it.
- **Preset:** `SKILL_PRESET_MAP['personal-assistant']` becomes `['web-access', 'email']`.
- **Worker:** remove the `'task-management'` entry from the built-in skill map in
  `apps/worker/src/agent.ts` (~line 478).
- **Platform docs:** in `apps/worker/src/tools/platform-docs-data.ts` and
  `scripts/ts/build-docs-index.ts`, remove the task-management skill entry and its
  line in the preset mapping text, and mention the tasks/reminders in the base skill
  entry.
- **Tests:** update every one that imports `TASK_MANAGEMENT_SKILL` or uses the id
  `'task-management'`. Run `rg "TASK_MANAGEMENT_SKILL|'task-management'|system/task-management" apps packages scripts`.
  Where a test only needs some non-trading skill, use `WEB_ACCESS_SKILL`.

**Fail-soft for old references** (until the migration runs, and for safety after):
- **Descriptor resolution** (`packages/db/src/agent-runtime-descriptor.ts`, around
  `buildRuntimeDescriptor`): when an assigned skill id is `task-management`, drop it
  without error and log at info.
- **`add_skills`** (`apps/worker/src/tools/skills.ts` ~line 339): for
  `task-management` or `system/task-management`, return success with
  `"already included in the base skill"` and write nothing.
- **API create/update** (`resolveSkillSlugs` in `apps/api/src/routes/agents.ts`
  ~line 360): silently drop the id/slug, so old clients don't get "Unknown skills".

**Data migration:**
- Create it with `pnpm --filter @herobids/db exec drizzle-kit generate --custom --name remove_task_management_skill`
  (the existing scripts are `db:generate` / `db:migrate`).
- SQL: delete from `agent_skills` where `skill_id = 'task-management'`, then delete the
  `skills` row with that id.
- First check foreign keys from `skill_revisions` and any other table referencing
  `skills.id` (`packages/db/src/schema/`), and delete or let cascade in the right order.
- `syncSystemSkills` (`apps/api/src/sync-system-skills.ts`) only upserts skills in
  `SYSTEM_SKILLS`, so it won't recreate the row. Confirm this by reading it.

**Tool-visibility budget check:**
- `getVisibleToolNames` (`apps/worker/src/runtime-tool-visibility.ts` ~line 38) stops
  adding tools at `maxVisibleToolSchemas` (careful style: 32), in `resolvedSkills`
  order.
- Confirm `base` is first in `resolvedSkills` (an existing descriptor test expects
  `['base', ...]`).
- Then count: base goes from 12 to 19 tools. Add a test that a careful agent with
  base + `web-access` + `email` + `programming` still sees all of their tools. If not,
  raise careful's `maxVisibleToolSchemas` default and say so in the PR.

**Tests:**
- `BASE_SKILL` has the seven tools.
- `SYSTEM_SKILLS` has no `task-management`.
- The preset maps to `web-access` + `email`.
- `inferDependsOn(['schedule_reminder'], 'x')` returns `[]`.
- A descriptor with a stale `task-management` assignment resolves without error.
- `add_skills('system/task-management')` reports that it's already included.
- The visibility budget test above.

### WP8. Routine guidance and docs — DONE

Append to the `BASE_SKILL` instructions. Keep the non-assertive "you can" tone from
`docs/tech/agents/skill-authoring.md`:

```text
Routine work:
- If you have work that repeats on a schedule, you can schedule it once with `schedule_reminder` using `repeatEveryMinutes` and a stable `key` (e.g. `daily_report`). The platform schedules each next occurrence for you, including across restarts.
- Scheduling again with the same `key` replaces the existing reminder instead of adding a second one.
- Your scheduled reminders are listed in your context. You can also use `list_reminders` to check them and `cancel_reminder` to stop one.
- A routine is normally done when its reminder arrives. On other ticks, you can check your scheduled reminders before doing routine work early.
- You can record each completed run with `set_memory` so you can tell whether an occurrence was handled.
- When a reminder reports missed occurrences, you can decide whether one catch-up run is enough.
```

Docs:
- `docs/agents/skills/flight-deal-monitoring.md`: replace "Use `schedule_reminder` to
  trigger the next scan and the next scheduled summary" with repeating reminders keyed
  `scan` (search interval) and `report` (report frequency).
- `docs/agents/skills/personal-property-locator-tools.md`: replace both "schedule the
  next tick" mentions with one repeating reminder keyed `sweep`.
- `docs/agents/prompts/security-audit-prompt.md`: "Use task-management to track…" →
  "Use tasks (`create_task`) to track…".
- `docs/tech/agents/skill-authoring.md`: note that task and reminder tools come with
  the base skill. Markdown skills may still list them in `requiredTools`, which is
  harmless.
- `docs/tech/agents/wake-signal-and-technical-scan.md`: add a "Reminders" section:
  - one-shot vs repeating, and `key` replacement
  - the coordinator lease
  - missed occurrences
  - reminders and user messages bypass active hours

### WP9. Skip-unchanged setting and 24 h default (D9, D10) — PENDING

**9a. Domain** (`packages/domain/src/config/schema.ts`):
- `AgentRuntimePolicyOverridesSchema` gains
  `skipUnchangedTicks: z.boolean().nullable().optional()`.
- `ResolvedAgentRuntimePolicy` gains `skipUnchangedTicks: boolean`.
- `resolveAgentRuntimePolicy` resolves it as `overrides.skipUnchangedTicks ?? (options?.hasTradingCapability ?? true)`.
  When the option is omitted, that's `true`, matching today. All three callers already
  pass the option (WP1c).

**9b. Worker** (`apps/worker/src/agent.ts`, `apps/worker/src/scout-gating.ts`). When
`agentConfig.resolvedRuntimePolicy?.skipUnchangedTicks === false`:
- Pass `enabledGates: { ...costProfile.enabledGates, contextHash: false }` to
  `buildTickGateState` (~line 2760).
- `resolvePreScoutDecision` gains `forceJudgeOnScheduledTick?: boolean`. When true, it
  returns `{ disposition: 'escalate', reason: 'scheduled_check_in' }` with a new
  `source: 'forced_scheduled_check_in'`. It's checked after the user-message and
  judge-reminder checks, so those reasons keep priority.
- The session gate, billing gate and circuit breaker are unchanged.

**9c. Default interval at create** (`apps/api/src/routes/agents.ts`, create handler):
- If the request has no `tickIntervalMs` and the agent has no trading capability, set
  `tickIntervalMs = agentRuntime.nonTradingDefaults.tickIntervalMs`.
- Check how operator `agentRuntime` config reaches the API routes (the route module
  already receives `agentRiskDefaults` / `agentCostEstimates`). If it doesn't, pass the
  value in the same way.
- PATCH never recomputes it.

**9d. maxHold validation:**
- `validateMaxHoldDurationInvariant` (API) returns no issues when the resolved
  `skipUnchangedTicks` is `false`.
- Its web twin in `apps/web/src/features/agents/form-validation.ts` (~line 56) gets the
  same rule.
- Reason: max hold only affects skipped ticks. Without this, careful style (450 min)
  rejects a 24 h interval.

**9e. Long interval vs active hours.** In `agent.ts`, when a tick is skipped by the
session gate (`skipDecision.gate === 'session'`), schedule the next tick at
min(normal interval, ms until the start of the next allowed hour).
- Put the "next allowed hour" calculation in `tick-gates.ts`, next to
  `isWithinTradingHours`, and reuse its session/hour logic.
- Without this, a 24 h check-in that lands outside the window would be skipped every
  day.

**9f. Web** (`apps/web/src/features/agents/`):
- **Tick interval default:** in `style-mapping.ts` and where the create form fills
  `tickIntervalMins` from the style, use 24 h (1440 min) when the selected skills have
  no trading capability. Use `hasCapabilityFamily(selectedSkills, 'trading')`, as
  `AgentsPage.tsx` and `EditAgentModal.tsx` already do.
  - Get the 24 h value from the API if an operator-defaults endpoint exists (check
    `/agents/risk-defaults` or similar). Otherwise mirror the default in one shared
    constant with a comment pointing to the operator config key.
- **Checkbox** in the Advanced → AI section, under Tick interval:
  - Label: "Skip check-ins when nothing has changed".
  - Helper: "Saves cost for agents that check in often, such as trading agents.
    Reminders and messages always reach the agent."
  - The unchecked default follows the skills (checked for trading, unchecked
    otherwise).
  - Map it into `runtimePolicyOverrides.skipUnchangedTicks` in `agent-payloads.ts`,
    hydrate it in `agent-form-state.ts`, and send `null` when the user hasn't touched
    it.
- **Cost hint:** when skipping is off and the interval is under 60 min, show "Each
  check-in runs the full model, about N runs a day."
- **i18n:** add every new string to `apps/web/src/app/i18n/locales/en.ts`, `ar.ts` and
  `hi.ts`.

**Tests:**
- **Resolution:** a non-trading agent resolves to `false`, a trading agent to `true`,
  and an explicit override wins.
- **Ticks:** with skipping off, an unchanged-context scheduled tick escalates to the
  judge as `scheduled_check_in`.
- **Create default:** a non-trading create without an interval stores 24 h; a trading
  create stores the style interval.
- **Validation:** a 24 h interval passes validation with skipping off and still fails
  with skipping on (careful style).
- **Active hours:** a session-gate skip schedules the next tick at the window start.
- **Web:** the checkbox round-trips; a style change keeps 1440 min for non-trading
  skills; strings exist in all three locales.

## Verification (run before declaring done)

```bash
pnpm install
pnpm --filter @herobids/db run db:migrate      # applies the WP7 migration (needs docker compose up -d)
pnpm lint
pnpm build
pnpm test
scripts/shell/tests/run-all-tests.sh --e2e
```

Then do a manual smoke test with `scripts/shell/run/reset-and-run.sh`:
1. Create a non-trading agent and confirm the tick interval defaults to 24 h.
2. Ask it "remind me every 15 minutes to stretch, key stretch".
3. Confirm one reminder in Redis, `agent:reminders:<agentId>`, with `repeatEveryMs: 900000`.
4. Confirm it fires twice, about 15 min apart, with no "Tick skipped — context_unchanged" entries.
5. Send a message outside the agent's active hours and confirm it gets a reply.

## Risks

- **Cost:** every reminder tick is a judge run (a 15 min repeat is about 96 runs a
  day). The operator minimum and spend budget cap it; Part 3 makes the effective
  cadence visible.
- **Behaviour changes** (accepted, D5/D6):
  - Trading agents answer user messages and reminders outside active hours.
  - Careful non-trading agents are no longer limited to 14–20 UTC unless the creator
    set those hours.
- **Removing a skill** touches data and many tests. The fail-soft paths ship in the
  same change as the migration.
- **Tool budget:** see the WP7 check.
- **Prompt growth:** capped by `promptMaxEntries`.

## Non-goals

- Time-of-day/timezone schedules, delivery acknowledgement, schedules UI, scout
  awareness (Part 3).
- Agent-controlled tick interval (Part 2, optional).
- Changing the `context_hash` gate's logic or `maxHoldDurationMs` values.
- Editing a reminder in place (use key replacement).
- Migrating existing agents' intervals (D11).

## Outstanding Issues

Non-critical review findings deferred during implementation (grouped by work package).

### WP1
- LOW (`apps/worker/src/runtime-composition.ts`): reminder-context reconstruction is duplicated between the drain path and `applyRuntimeMessage`. Consider extracting a `toRuntimeReminderContext(wakeId, requestedAt, ctx)` helper to keep them in sync.
- LOW (`apps/worker/src/tick-gate-state.ts`): the `payload?.source === 'reminder'` check uses a narrow cast rather than the `AgentWakePayloadSchema`. A typed guard would be marginally safer; acceptable for a hot gate path.

### WP2
- LOW (stylistic only, no action needed): `config/default.yaml` comments use em dashes while the schema uses hyphens; the refine message uses ASCII `<=` (verbatim from the plan) while nearby messages use `≤`.

### WP3
- LOW: `scheduledBy` ↔ `ctx.phase` coupling is guaranteed only by the typechecker.
- LOW: `reminder-coordinator.ts` still uses `JSON.parse(raw) as ReminderRecord` (unvalidated); switched to `parseReminderRecord` in WP5.

### WP4
- MEDIUM: `cancel_reminder`'s internal `safeParse` → `reminder.invalid_target` is effectively redundant because the dispatch boundary validates params first (surfaces `validation.invalid_parameters`). Behaviour satisfies the plan; consider dropping the re-parse or commenting that it exists for direct-call/test safety.
- LOW: `list_reminders` could emit a fractional `repeatEveryMinutes` if a future path writes a non-minute-aligned `repeatEveryMs` (today always aligned).
- LOW: `isNaN(triggerDate.getTime())` branch in `schedule_reminder` is practically unreachable given `z.string().datetime()`; harmless defensive code.

### WP5
- LOW: the "drain cannot throw" guarantee lives in `start()`'s `.catch` wrapper rather than structurally in `stop()`; consider hoisting the wrap into a private helper used by any `tickDrain` assignment site.
- LOW: the stop-drain test assigns a raw `tick()` promise (no `.catch`) rather than the exact promise shape `start()` produces; informational.
- LOW (deferred to WP6): wake `context` carries `key`/`repeatEveryMs`/`scheduledFor`/`missedOccurrences`/`nextTriggerAt` which are stripped by the current `ReminderWakeContextSchema` until WP6 extends it.

### WP6
- LOW: the hash-invariant test is effectively tautological (same inputs both sides); the real guard is that `computeDecisionContextHash`'s input type has no reminder field. Optional to strengthen or delete.
- LOW: `scheduledRemindersTotal` counts valid (parsed) records, not raw hash size, so the "…and N more" footer excludes malformed entries — sensible but an undocumented deviation from a literal "total count".
- LOW: no direct test that a Redis `hgetall` rejection keeps the previous `scheduledReminders` snapshot (covered only indirectly).

### WP7
- Regression fixed during WP7 (root cause in WP1): `deriveHasTradingCapability` threw when a `RuntimeDescriptor.resolvedSkills` entry omitted `capabilityFamilies` (the runtime shape is narrower than the `SkillDefinition` type), which the session-launch try/catch swallowed and blocked `runtimeLauncher.launch`. Fixed with an `Array.isArray` guard. Bug report: `docs/bug-reports/2026/10/06/002-derive-has-trading-capability-throws-on-runtime-skill-shape.md`.
- LOW: fail-soft logging asymmetry — only the descriptor-resolution path logs when a stale `task-management` ref is dropped; the `add_skills` (returns a user-visible note) and API `resolveSkillSlugs` (silent) paths do not. Consistent with the plan, which permits note/silent for those two.
- LOW (pre-existing, unrelated to this feature): `apps/worker/src/runtime-composition.ts:785` uses the same unguarded `.capabilityFamilies.includes(...)` pattern; left untouched to keep the fix targeted.

### WP8
- LOW: `flight-deal-monitoring.md` new sentence is long (could split for readability); `security-audit-prompt.md` has no trailing newline (pre-existing). Both harmless.
