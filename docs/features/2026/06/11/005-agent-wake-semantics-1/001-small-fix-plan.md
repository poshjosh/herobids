# Agent Wake Semantics Small-Fix Plan

Stop misleading agents with generic market-related wake reasons by making the
existing `agent.market.wake` payload precise enough for the agent runtime to
render a capability-relevant summary for the immediate tick.

This is the small fix, not the end state. It keeps the current wake family,
current scheduler shape, and current event delivery model. The goal is to
remove the misleading `market_monitor_triggered` abstraction without taking on
the larger subscription and eligibility redesign.

## Background

- The current wake contract in `packages/domain/src/agent-protocol.ts` exposes a
  generic `reason` string plus `eventIds`.
- The market monitor currently emits `reason: "market_monitor_triggered"` from
  `apps/worker/src/market-intelligence/monitor.ts`.
- The runtime currently turns non-reminder wakes into `Market wake: {reason}` in
  `apps/worker/src/runtime-composition.ts`.
- That behavior is technically valid but semantically weak: the agent is told
  it was woken by the market monitor, not what actually happened.
- Reminder wakes already demonstrate the product need for explicit wake context,
  but they currently rely on a string-prefix convention rather than a proper
  typed payload.

## Goal

For the immediate wake-triggered tick, the agent should see a short structured
summary of the triggering market event in capability-relevant terms, rather
than a generic market-monitor label.

## Scope

### In scope

- Extend `agent.market.wake` with structured context for the triggering market
  event while remaining backward compatible.
- Preserve the existing wake scheduling, cooldown, and coalescing model.
- Keep current targeting based on active watch keys; do not redesign all wake
  eligibility rules in this slice.
- Replace generic runtime rendering for non-reminder wakes with specific wake
  context blocks.
- Add focused tests for protocol validation, monitor emission, and runtime
  context rendering.

### Out of scope

- Strong capability/subscription gating for all wake families.
- A new generalized wake-subscription data model.
- Redesign of all market event persistence or replay behavior.
- Migration of the whole system away from `agent.market.wake` as the single wake
  message type.

## Constraints

### Backward compatibility first

The worker and runtime should continue to accept older wake payloads during the
 rollout. New fields should be additive before old fallback behavior is removed.

### Small fix should stay small

This plan should not pull in the larger subscription architecture. The intent is
to improve correctness of wake semantics with minimal surface area.

### Preserve bounded wake behavior

Wake cooldown, coalescing, and early-tick scheduling behavior should stay as-is
unless a change is necessary to attach accurate context.

## Proposed Design

### Add typed wake context without replacing the message family

Extend `AgentMarketWakePayloadSchema` with additive fields such as:

- `source`: `reminder | watch_threshold | discovery_delta | regime_change`
- `context`: a compact structured object specific to the source

Recommended small-fix shape:

```ts
type AgentMarketWakePayload = {
  wakeId: string;
  reason: string;
  eventIds: string[];
  priority: 'low' | 'normal' | 'high';
  requestedAt: string;
  notBefore?: string;
  source?: 'reminder' | 'watch_threshold' | 'discovery_delta' | 'regime_change';
  context?: Record<string, unknown>;
};
```

This keeps the current contract shape valid while giving the runtime a reliable
way to render wake meaning.

### Publish a concrete wake summary from the monitor

When the monitor emits a wake, it should derive the wake summary from the
triggering event instead of hard-coding `market_monitor_triggered`.

Examples:

- watch threshold:
  - `source: "watch_threshold"`
  - `reason: "SOL crossed above 200"`
  - `context`: `{ symbol, chain, condition, thresholdPrice, currentPrice, stale, triggeredAt, watchId }`
- discovery delta:
  - `source: "discovery_delta"`
  - `reason: "WIF entered top discovery set"`
  - `context`: `{ symbol, network, address, reason, rank, liquidityUsd, volume24hUsd, detectedAt }`
- regime change:
  - `source: "regime_change"`
  - `reason: "BTC regime changed to unfavorable"`
  - `context`: `{ benchmarkSymbol, previousState, currentState, changedAt, details }`

The `reason` remains useful for logs and compatibility, but it should no longer
be a generic scheduler label.

### Replace string-prefix reminder parsing with typed handling where available

In `apps/worker/src/runtime-composition.ts`, prefer `source === 'reminder'`
plus structured context over the current `reminder:` string-prefix convention.
Keep the prefix fallback during migration.

### Render dedicated wake-context blocks

Add explicit runtime context blocks for the immediate tick, for example:

- `## Reminder Context`
- `## Watch Trigger Context`
- `## Discovery Trigger Context`
- `## Regime Change Context`

These should be short, structured, and reset after the tick, matching the
current reminder-context lifecycle.

## Plan

1. Extend the wake protocol schema with additive typed fields.
   Files: `packages/domain/src/agent-protocol.ts` and related protocol tests.
   Change: add optional `source` and `context` fields to
   `AgentMarketWakePayloadSchema`; keep current fields valid so existing payloads
   still round-trip during rollout.
   Dependency: none.

2. Change wake producers to emit meaningful reasons and structured context.
   Files: `apps/worker/src/market-intelligence/monitor.ts`, reminder wake
   producer path, and associated emitter tests.
   Change: replace `market_monitor_triggered` with concise, event-derived reason
   text and attach source-specific context data for watch, discovery, regime,
   and reminder wakes.
   Dependency: step 1.

3. Update runtime message handling to prefer typed wake context.
   Files: `apps/worker/src/runtime-composition.ts` and
   `apps/worker/src/runtime-composition.test.ts`.
   Change: decode `source/context` first, preserve a compatibility fallback for
   legacy reminder and generic market wakes, and render dedicated wake-context
   blocks for the immediate tick.
   Dependency: steps 1 and 2.

4. Keep wake scheduling behavior unchanged but validate the end-to-end flow.
   Files: wake scheduler tests, monitor tests, and runtime tests.
   Change: prove that the runtime still gets early ticks while now seeing
   meaningful wake context rather than a generic label.
   Dependency: steps 1 through 3.

5. Remove the misleading generic reason from current tests and fixtures.
   Files: protocol tests, runtime tests, and any monitor/emitter fixtures using
   `market_monitor_triggered` as the expected semantic reason.
   Change: update tests to assert meaningful source-specific wake summaries.
   Dependency: steps 2 through 4.

## Test Strategy

- Protocol tests proving old payloads still validate and new typed payloads
  round-trip.
- Monitor/emitter tests proving watch, discovery, regime, and reminder wakes
  emit meaningful `reason` values plus typed `source/context`.
- Runtime composition tests proving the immediate tick renders a dedicated wake
  block instead of `Market wake: market_monitor_triggered`.
- Validation command: `pnpm lint`

## Rollout Notes

1. Ship schema support first with compatibility fallback.
2. Ship producer changes next so new wakes include typed context.
3. Ship runtime rendering changes after that so agents begin seeing the richer
   wake context.
4. Remove any remaining assertions or docs that rely on
   `market_monitor_triggered` as the semantic contract.

## Exit Criteria

- No newly emitted market-related wake uses `market_monitor_triggered` as the
  user-facing semantic reason.
- The immediate wake-driven tick shows concrete trigger context for watch,
  discovery, regime, and reminder wakes.
- The runtime still accepts older wake payloads during rollout.
- Reminder handling no longer depends solely on string-prefix parsing when the
  new typed fields are present.
- Focused tests and `pnpm lint` pass.