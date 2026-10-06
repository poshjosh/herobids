# Part 2: Agent-Controlled Tick Interval

**Status:** Draft
**Created:** 2026-10-06
**Program:** [Outline](./000-outline.md) · Builds on: [Part 1](./001-part1-repeating-reminders-mvp-plan.md) · Next: [Part 3](./003-part3-schedule-continuity-and-visibility-plan.md)
**Precedence:**
- Supersedes [070 agent min tick interval extension](../../../../pending/070-agent-min-tick-interval-extension/001-plan.md).
- Takes precedence over [071 skill-driven tick interval defaults](../../../../pending/071-skill-driven-tick-interval-defaults/001-plan.md) where they overlap.

## Summary

The agent can set its own check-in (tick) interval within operator bounds
(default 15 min–24 h), based on its goal or skills.

- The value persists across restarts.
- The creator's interval stays the default the agent can reset to.
- Trading agents with open positions are capped at an operator ceiling (default 1 h).
- Wakes and user messages still fire immediately.
- Routine work stays on Part 1 repeating reminders. The tick interval only controls
  unprompted check-ins.

## Decisions

From the [outline](./000-outline.md#decisions-defaults-the-user-can-revisit): 2, 3, 4, 9.

## Verified vs assumed

Verified by reading code (2026-10-06):

- `agents.tick_interval_ms` holds the creator value (`packages/db/src/schema/agents.ts`).
  `resolveAgentCostProfile` (`packages/domain/src/cost-profile.ts`) lets it win over
  the preset interval.
- `apps/worker/src/agent.ts`:
  - `let effectiveTickIntervalMs = costProfile.tickIntervalMs` (~line 2219).
  - `scheduleNextTick` reschedules with `effectiveTickIntervalMs` after every tick
    (~lines 2273–2330).
  - The gate gets `baseTickIntervalMs: costProfile.tickIntervalMs` (~line 2759).
  - The prompt timing uses `nominalTickIntervalMs: costProfile.tickIntervalMs`
    (~line 3419).
- The adaptive interval (`resolveAdaptiveIntervalMs`) runs only when
  `fetchVolatilityPct` is provided, i.e. for trading agents. It can reach 2× base.
- Wakes only shorten the next delay (`apps/worker/src/agent-wake-scheduler.ts`).
- `validateMaxHoldDurationInvariant` (`apps/api/src/routes/agent-config-helpers.ts`)
  validates creator config only.
- The API route module already receives `redisClient`
  (`apps/api/src/routes/agents.ts`; e.g. it syncs `agent:wake:prefs:{id}`).
- Base skill tools are excluded from tool ownership (`buildToolOwnershipMap`), so
  adding a tool to `BASE_SKILL` doesn't change `inferDependsOn`.
- `AGENT_RUNTIME_ACTIVITY_TYPES` and `TickSkippedPayloadSchema` live in
  `packages/domain/src/agent-protocol.ts`.

Assumed (verify during implementation):

- How a creator PATCH of `tickIntervalMs` reaches a running agent today (restart vs
  config update). The override clear (decision 9) must use the same path.
- Whether an existing endpoint already exposes operator values to the web form (071
  mentions `/agents/risk-defaults`). If so, reuse it for the bounds.

## Detailed plan

### 1. Operator config

Files: `packages/domain/src/config/schema.ts`, `config/default.yaml` (+ schema test)

Add `tickInterval` to `AgentRuntimeConfigSchema`:

```ts
tickInterval: z.object({
  agentMinMs: z.number().int().min(60_000).default(900_000),        // 15 min
  agentMaxMs: z.number().int().min(60_000).default(86_400_000),     // 24 h
  openPositionMaxMs: z.number().int().min(60_000).default(3_600_000), // 1 h
}).refine((t) => t.agentMinMs <= t.agentMaxMs, { message: 'agentMinMs must be <= agentMaxMs' })
  .default({}),
```

These bounds apply to agent-chosen values only. Creator values keep their existing
validation (and 071's creator-default clamp).

### 2. Persistence

- **Key:** `agent:tick_interval:{agentId}`.
- **Value:** JSON `{ intervalMs, setAt, reason? }`, validated with Zod. No TTL.
- **Why Redis:**
  - It is the same store as memory and reminders, which agents already rely on for
    continuity.
  - No migration.
  - The API reads it through the existing `redisClient`.
  - The creator's column is never overwritten.
- **Rejected alternatives:**
  - `runtimePolicyOverrides`: creator-owned JSONB, so ownership would be mixed and a
    broker DB write would be needed.
  - `agents.tick_interval_ms`: would erase the creator value the agent resets to.

### 3. Policy module (new)

New file: `apps/worker/src/tick-interval-policy.ts` (+ test). Pure functions:

- `resolveBaseTickIntervalMs({ creatorIntervalMs, agentIntervalMs, bounds })` returns
  `{ intervalMs, source: 'creator' | 'agent' }`. The agent value is clamped to bounds
  defensively, covering stale stored values after an operator bounds change.
- `applyOpenPositionCeiling({ intervalMs, hasOpenPositions, openPositionMaxMs })`
  returns the capped interval.

### 4. Runtime wiring

File: `apps/worker/src/agent.ts`

- **At startup:** read the override key. On a read failure, warn and use the creator
  value. Introduce a `baseTickIntervalMs` variable and use it wherever
  `costProfile.tickIntervalMs` is used as the base:
  - the initial `effectiveTickIntervalMs`
  - the gate's `baseTickIntervalMs`
  - the prompt's `nominalTickIntervalMs`
- **Each tick:** once `hasOpenPositions` is known, apply `applyOpenPositionCeiling` to
  the base and to `skipDecision.nextTickIntervalMs` before it becomes
  `effectiveTickIntervalMs`.
- **On tool success:** update `baseTickIntervalMs` and `effectiveTickIntervalMs`. The
  tool runs inside a tick, and `scheduleNextTick` runs in that tick's `finally`, so the
  new value applies from the next schedule with no timer surgery.
- **Unaffected:**
  - Wakes and user messages.
  - Hybrid agents: their housekeeping ticks follow the new interval; LLM dispatch is
    unchanged.
  - `maxHoldDurationMs`. When the agent's interval exceeds it, every scheduled tick
    bypasses the `context_unchanged` skip. That's acceptable because those ticks are
    rare; document it.

### 5. Tool

New file: `apps/worker/src/tools/tick-interval.ts`. Also edit
`apps/worker/src/tools/index.ts` and `packages/domain/src/tools.ts`.

- **Name:** `set_tick_interval`, category `write-memory`. It is judge-only in
  practice because the scout gets read-only tools.
- **Params:** `{ intervalMinutes?: int, reset?: true, reason?: string (≤200) }`, with
  exactly one of `intervalMinutes` or `reset`.
- **Out-of-bounds values are rejected, not clamped,** so the agent learns the range.
  Error `tick_interval.out_of_bounds` includes `{ minMinutes, maxMinutes }`.
- **Result:** `{ intervalMinutes, source, effectiveIntervalMinutes, openPositionCeilingApplied, expectedNextTickAt }`.
- **New optional `ToolContext.tickScheduling`** (the ToolContext surface idea comes
  from 070):
  - `getPolicy(): { creatorIntervalMs, agentIntervalMs: number | null, effectiveIntervalMs, bounds, openPositionCeilingMs: number | null }`
  - `setAgentInterval(intervalMs: number | null, reason?: string): Promise<Result<…>>`
    (null means reset)
- Add to `KNOWN_AGENT_TOOL_NAMES` and the metadata map.

### 6. Base skill

File: `packages/domain/src/skills.ts`

Add `set_tick_interval` to `BASE_SKILL.requiredTools` (every agent gets it) and append:

```text
Check-in interval:
- Your tick interval is how often you check in when nothing has woken you. Reminders, user messages and other wake signals still reach you immediately.
- You can use `set_tick_interval` to change it within the allowed range shown in your operating context, or reset it to your creator's setting.
- Work that repeats on a schedule belongs on repeating reminders, not on the tick interval. If your goal is mostly routine work, a long interval can keep costs down while your reminders keep running.
- You can choose a shorter interval when your goal needs frequent unprompted checks.
```

The timing context (`apps/worker/src/prompt-timing-context.ts`) shows the interval,
its source (creator or agent), the allowed range, and whether the open-position
ceiling is active.

### 7. Activity events

Files: `packages/domain/src/agent-protocol.ts`,
`apps/worker/src/agents/agent-message-broker.ts`,
`apps/api/src/routes/agent-activity-mapper.ts`

- Add `TICK_INTERVAL_CHANGED: 'agent.tick_interval.changed'` with payload
  `{ intervalMs | null (reset), previousIntervalMs, source, reason? }`.
- Handle it as audit-only in the broker, like the other activity types.
- Mapper summary: "Check-in interval changed to 2h (set by agent: <reason>)".

### 8. API

Files: `apps/api/src/routes/agents.ts`, `apps/api/src/routes/agent-config-helpers.ts`,
`apps/web/src/lib/api-client.ts` (+ route tests)

- **GET agent:** add `agentTickInterval: { intervalMs, setAt, reason } | null` from
  Redis. It is `null` when absent or Redis is unavailable (warn).
- **PATCH with an explicit `tickIntervalMs`:** `DEL` the override (decision 9) and
  signal the running agent by the existing config path (see Assumed).
- `validateMaxHoldDurationInvariant` is unchanged; it still validates creator values
  only.

### 9. Web

Files: `apps/web/src/features/agents/AgentDetailPage.tsx`, the tick-interval field in
the agent form (`apps/web/src/features/agents/AgentControlsSection.tsx` or wherever
`tickIntervalMins` renders), i18n `en.ts`, `ar.ts`, `hi.ts`

- **Detail page:** "Check-in interval: 2 h (set by the agent, creator default 30 min)".
- **Form helper text** under Tick interval: "The agent can adjust this between 15 min
  and 24 h. Saving a new value here resets any adjustment the agent made." The bounds
  come from the API, not literals.

### 10. Docs

- `docs/tech/agents/runtime-policy-and-reasoning.md`: the agent-chosen interval,
  bounds, persistence, open-position ceiling, and the `maxHoldDurationMs`
  interaction.
- The precedence notes in 070 and 071 were added with this program.

## Relationship to 071

- 071 computes the creator default at create time. Here it is the reset target, and
  071 stays valid for that.
- 071's `[1 min, 24 h]` clamp governs creator defaults only. Agent-chosen values use
  `agentRuntime.tickInterval` (this plan wins on conflict).
- 071's `maxHoldDurationMs` comment updates should describe the creator default,
  since this plan leaves `maxHoldDurationMs` unchanged when the agent changes its
  interval.

## Testing plan

**Domain**
- Config defaults load, and min > max is rejected.
- The activity payload schema validates.
- `BASE_SKILL` includes `set_tick_interval`, and ownership/`inferDependsOn` are
  unchanged for other skills.

**Worker: policy**
- The agent value wins over the creator value.
- A missing override falls back to the creator value.
- A stale stored value is clamped to current bounds.
- The ceiling applies only with open positions.

**Worker: tool**
- Sets and persists the interval.
- Rejects out-of-range values with the allowed range.
- Reset restores the creator value and deletes the key.
- The latest request wins.

**Worker: runtime**
- The next scheduled tick uses the new interval.
- A restart restores the agent value.
- A wake still triggers an early tick on a 24 h interval.
- The open-position ceiling caps the adaptive interval.

**API**
- GET returns the override or null.
- PATCH `tickIntervalMs` clears the override.

**Web**
- The detail page shows the source.
- The helper text renders in all three locales.

**Suite:** `pnpm lint`, focused tests, `scripts/shell/tests/run-all-tests.sh`.

## Implementation order

1. Config.
2. Policy module.
3. Persistence and runtime wiring.
4. Tool and `ToolContext`.
5. Base skill text and timing context.
6. Activity event.
7. API.
8. Web and i18n.
9. Docs, lint, tests.

## Risks

- **The agent silences itself for 24 h.** Mitigation: reminders, user messages and
  wakes still fire; the open-position ceiling applies; the creator sees the source in
  the UI.
- **Cost rises when the agent picks 15 min.** Mitigation: the spend budget and the
  billing gate are unchanged.
- **The tick interval and routines get confused.** Mitigation: the Part 1 design rule
  plus the guidance text that routines live on reminders.
- **A stale override after the creator edits.** Mitigation: decision 9.

## Non-goals

- 070's one-shot delay and creator opt-in.
- Runtime derivation from skills (071 handles defaults at create time).
- Per-agent configurable bounds.
- Changing `maxHoldDurationMs`.

## Open decisions (minor)

1. Show the agent's reason in the UI. Recommendation: yes, truncated.
2. Emit the activity event on reset too. Recommendation: yes.
