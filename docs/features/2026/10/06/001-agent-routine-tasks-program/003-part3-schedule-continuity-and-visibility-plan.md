# Part 3: Schedule Continuity and Visibility

**Status:** Draft
**Created:** 2026-10-06
**Program:** [Outline](./000-outline.md) · Builds on: [Part 1](./001-part1-repeating-reminders-mvp-plan.md), [Part 2](./002-part2-agent-controlled-tick-interval-plan.md)
**Precedence:** this program takes precedence over overlapping plans (see the outline).

## Summary

Parts 1 and 2 make routines run. This part makes them fit real-world schedules and
lets creators see and trust them:

- **Calendar schedules:** "weekdays 09:00 Europe/London", with daylight saving
  handled.
- **Delivery acknowledgement:** an occurrence that fired but was never handled (tick
  failed, billing block, crash) is reported as missed instead of vanishing.
- **Schedules panel:** shown on the agent page with the effective cadence, plus
  reminder entries and a clearer skip message in the activity timeline.
- **Scout awareness:** the scout can see the next due routine, so an overdue one
  escalates.

## Verified vs assumed

Verified by reading code (2026-10-06):

- `apps/worker/src/tick-gates.ts` already derives timezone offsets with
  `Intl.DateTimeFormat` (`America/New_York`), so no date library is needed.
- `agent.ts` sets `lastEscalationTimestamp` after a completed judge run (~line 4030).
  This is the natural hook for acknowledging delivery.
- The tick-skipped timeline text is built in
  `apps/api/src/routes/agent-activity-mapper.ts` (`Tick skipped — ${reason}${gate}.`),
  from `TickSkippedPayloadSchema` in `packages/domain/src/agent-protocol.ts`.
- The agent page is `apps/web/src/features/agents/AgentDetailPage.tsx`; the timeline
  is `AgentActivityTimeline.tsx`.
- `buildScoutSystemPrompt` (`apps/worker/src/scout-dispatch.ts`) gives non-trading
  agents only "Only escalate when there is good reason…".

Assumed (verify during implementation):

- How the worker-side coordinator can write activity entries. The runtime uses
  `emitActivityEvent`, persisted by the broker; the coordinator may need a repository
  write or a broker-routed envelope.
- Whether timeline summaries are localized in the web app or shown as API strings.
  Follow the existing pattern.
- The ownership/auth middleware used by other per-agent API routes. New routes must
  use it; no unauthenticated endpoints.

## Detailed plan

### 1. Calendar schedules

Files: `apps/worker/src/tools/tasks.ts`, `apps/worker/src/reminders/reminder-record.ts`,
`apps/worker/src/reminders/reminder-schedule.ts`, `packages/domain/src/tools.ts`
(+ tests)

- `schedule_reminder` gains
  `repeatAt: { time: 'HH:mm', timeZone: string (IANA), daysOfWeek?: ('mon'|…|'sun')[] }`.
  It is mutually exclusive with `repeatEveryMinutes` (Zod refine).
- Validate the time zone with `Intl.DateTimeFormat(undefined, { timeZone })`. An
  invalid zone throws `RangeError`, which becomes error `reminder.invalid_time_zone`.
- `ReminderRecord` gains an optional `calendar` field.
- `computeNextCalendarOccurrence({ calendar, after })` is pure and Intl-based (the
  offset helper is generalised from `tick-gates.ts`). Daylight-saving rules:
  - A local time that doesn't exist (spring forward) fires at the next valid minute.
  - An ambiguous local time (fall back) fires at the first occurrence.
- Missed-occurrence counting from Part 1 applies unchanged, and reminder wakes still
  bypass active hours.

### 2. Delivery acknowledgement and missed runs

Files: `apps/worker/src/agent.ts`, `apps/worker/src/reminders/reminder-record.ts`,
`apps/worker/src/runtime-composition.ts` (+ tests)

- The record gains `lastFiredSlotAt` (set by the coordinator) and
  `lastDeliveredSlotAt` (set by the runtime).
- After a judge run that carried a reminder completes (the
  `lastEscalationTimestamp` hook), the runtime writes `lastDeliveredSlotAt` for that
  reminder id. The write is a no-op if the record was cancelled or replaced
  (`reminderId` mismatch).
- `lastFiredSlotAt > lastDeliveredSlotAt` means the occurrence was fired but not
  handled. The Part 1 routines block shows it as
  "missed: fired at T, not handled", and the next occurrence's reminder block
  includes it.
- No automatic redelivery: it could loop on a persistent failure. The agent decides
  whether to catch up.
- One-shot reminders are deleted on fire today. To cover them, keep the fired
  one-shot record as `status: 'fired'` until delivered, then delete. Records not
  delivered within `maxRepeatIntervalMs` are purged, so the limit isn't hit by stale
  entries.

### 3. Activity timeline

Files: `packages/domain/src/agent-protocol.ts`,
`apps/api/src/routes/agent-activity-mapper.ts`, `apps/worker/src/agent.ts`,
`apps/worker/src/reminder-coordinator.ts`

- **New activity types:**
  - `reminder.fired` (coordinator): key, message, scheduled for, missed count.
  - `reminder.delivered` (runtime).
- **`TickSkippedPayloadSchema`:** add optional `nextReminderDueAt`.
- **Mapper:** when the reason is `context_unchanged`, the summary becomes "Nothing new
  since the last check. Next scheduled reminder: 16:00 UTC." It falls back to today's
  text when there's no reminder.

### 4. Schedules API and panel

Files: `apps/api/src/routes/agents.ts` (or a new `agent-reminders.ts` route module),
`apps/web/src/lib/api-client.ts`, `apps/web/src/features/agents/AgentDetailPage.tsx`
(+ a new `AgentSchedulesSection.tsx`), i18n `en.ts`, `ar.ts`, `hi.ts`

- **`GET /agents/:id/reminders`:** owner-scoped. Reads `agent:reminders:{id}` via
  `redisClient` and parses with the shared Zod schema. Malformed entries are omitted
  and logged.
- **`DELETE /agents/:id/reminders/:reminderId`:** owner-scoped, so the creator can
  cancel a routine.
- **Panel:**
  - Each reminder: message, repeat or calendar rule, next fire, last fired, last
    handled, missed indicator, cancel button.
  - The check-in interval and its source (Part 2).
  - An effective-cadence note when any routine repeats more often than the check-in
    interval: "Reminders run every 15 min, more often than the 90 min check-in
    interval. Each reminder run uses the full model."
- **Effective active hours,** including the Part 1 rule that style-default hours don't
  apply to non-trading agents, shown in the existing runtime-policy section.
- All new strings in the three locales.

### 5. Scout awareness

File: `apps/worker/src/scout-dispatch.ts` (+ test)

- For agents without trading capability, add `Next scheduled reminder (UTC): …` to the
  scout's Operating Context, from Part 1's timing line.
- Extend the non-trading escalation instruction: "…or a scheduled reminder is overdue
  or was not handled."
- Reminder-triggered ticks still bypass the scout (unchanged). This only matters for
  ordinary ticks.

## Testing plan

**Worker: calendar**
- Fires at the local time across a daylight-saving change.
- A nonexistent local time moves to the next valid minute.
- An ambiguous local time fires once.
- `daysOfWeek` skips other days.
- An invalid time zone is rejected.

**Worker: delivery**
- A completed judge run marks delivery.
- A failed tick leaves the occurrence reported as missed.
- A cancelled or replaced reminder isn't written.
- A fired one-shot is deleted after delivery.

**API**
- The list is owner-scoped and returns 404 for another user's agent.
- Delete removes the reminder.
- Malformed entries are omitted.

**Mapper**
- The context-unchanged summary includes the next reminder.
- It falls back when there is none.

**Web**
- The panel renders reminders, the effective-cadence note, and cancel.
- Strings render in all three locales.

**Scout**
- The non-trading scout prompt includes the next reminder line.

**Suite:** `pnpm lint`, focused tests, `scripts/shell/tests/run-all-tests.sh --e2e`
for the UI flow.

## Implementation order

1. Calendar schedules.
2. Delivery acknowledgement.
3. Activity types and mapper.
4. API routes.
5. Web panel and i18n.
6. Scout awareness.
7. Docs (`docs/tech/agents/wake-signal-and-technical-scan.md`, skill text examples for
   `repeatAt`), lint, tests.

## Risks

- **Daylight-saving edge cases.** Mitigation: pure functions with explicit tests for
  both transitions.
- **Delivery writes racing a re-schedule.** Mitigation: write only the
  `lastDeliveredSlotAt` field, guarded by `reminderId`; keep it small, or use a Lua
  compare if needed.
- **New API surface.** Mitigation: owner-scoped routes using the existing middleware;
  no unauthenticated access.

## Non-goals

- General cron expressions.
- Editing reminders from the UI (cancel only).
- Automatic redelivery of missed occurrences.
- Delivery history beyond the last fired and last delivered slot.

## Open decisions (minor)

1. Should the creator be able to create routines from the UI? Recommendation: not in
   this part; routines stay agent-owned.
2. Should the panel show one-shot reminders too? Recommendation: yes, in a separate
   "Upcoming" list.
