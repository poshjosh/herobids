# Agent Runtime Loop Controls

## Status

`draft`

## Purpose

Make the most impactful hardcoded agent loop controls in `apps/worker/src/agent.ts` operator-configurable, starting with scout/judge `maxTurns`, and extend the same config surface to a small set of adjacent runtime knobs that are clearly policy or tuning concerns rather than internal implementation details.

This plan is intentionally narrow. It does not attempt to redesign the agent runtime, prompt architecture, or tool execution pipeline. It only lifts selected hardcoded values into `agentRuntime` config in a way that is typed, validated, documented, and regression-tested.

## Scope

### In scope

1. Add config for scout loop `maxTurns`.
2. Add config for judge loop `maxTurns`.
3. Add config for scout request tuning values that are currently hardcoded and operationally meaningful.
4. Add config for wake-loop timing knobs that are currently hardcoded in `agent.ts`.
5. Add config for small market-intelligence fanout limits that are currently hardcoded in `agent.ts`.
6. Wire the new config through existing `AgentRuntimePolicySchema` parsing and runtime call sites.
7. Add focused tests for config parsing and runtime behavior.
8. Update operator docs in `config/default.yaml` comments.

### Out of scope

1. Do not redesign `structured-tool-loop.ts` semantics.
2. Do not add per-agent overrides for these values in agent records or `runtimeDescriptor`.
3. Do not redesign tool visibility, skill composition, or prompt assembly in this plan.
4. Do not add `maxToolCallsPerTurn` or `maxToolCallsPerTick` in this pass unless implementation proves they are required for coherence.
5. Do not move stream names, Redis consumer group names, or internal error strings into config.

## Problem Statement

`apps/worker/src/agent.ts` currently contains several hardcoded runtime policy values that should be adjustable without code edits:

1. Scout loop `maxTurns: 3`
2. Judge loop `maxTurns: 3`
3. Scout generation settings such as `maxTokens: 256` and `temperature: 0`
4. Wake timing constants such as `WAKE_MIN_INTERVAL_MS = 15_000` and `WAKE_SIGNAL_POLL_MS = 1000`
5. Market-intelligence enrichment caps such as `slice(0, 3)` and `slice(0, 2)`

These are operational tuning knobs. Leaving them hardcoded makes runtime behavior harder to tune, harder to reason about during incidents, and inconsistent with the codebase’s configuration principles.

## Target End State

After this plan lands:

1. `agentRuntime.llm.scout.maxTurns` exists and controls scout loop turn count.
2. `agentRuntime.llm.judge.maxTurns` exists and controls judge loop turn count.
3. Scout request tuning values come from config instead of literals.
4. Wake scheduling and polling timing come from config instead of literals.
5. Market-intelligence fanout caps come from config instead of literals.
6. `config/default.yaml` documents all of the above with clear comments.
7. Validation rejects invalid values at startup.
8. Focused tests protect both config parsing and call-site usage.

## Proposed Config Shape

Add the following fields under `agentRuntime`:

```yaml
agentRuntime:
  llm:
    scout:
      maxTurns: 3
      maxTokens: 256
      temperature: 0
      maxHoldDurationMs: null
    judge:
      maxTurns: 3
      temperature: 0.3
  wake:
    minIntervalMs: 15000
    pollMs: 1000
  marketIntelligence:
    maxTrackedPerps: 3
    maxTrackedDexTargets: 3
    maxRefreshedDexTargetsPerTick: 2
```

Notes:

1. `judge.maxTokens` does not need a new field initially because the judge already uses operator `LLM_MAX_TOKENS` / `requestBase.maxTokens` intentionally.
2. `judge.temperature` is worth exposing because it is currently a literal and is clearly an inference-policy knob.
3. `maxTrackedDexTargetsPerTick` is separate from `maxTrackedDexTargets` because one controls collection breadth and the other controls refresh fanout.

## Files Expected To Change

### Primary runtime files

- `apps/worker/src/agent.ts`
- `apps/worker/src/structured-tool-loop.ts` only if a helper signature needs refinement

### Config and types

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/runtime-composition.ts` only if shared runtime policy typing needs adjustment
- `config/default.yaml`

### Tests

- `apps/worker/src/config.test.ts`
- `apps/worker/src/structured-tool-loop.test.ts` only if needed
- add or update a focused agent-runtime config usage test if an appropriate existing surface exists

## Implementation Plan

### Slice 1 — Add schema support for new runtime knobs

#### Goal

Extend `AgentRuntimeConfigSchema` so the runtime policy can express the new loop and wake controls.

#### Tasks

1. Extend `LlmScoutConfigSchema` with:
   - `maxTurns`
   - `maxTokens`
   - `temperature`
2. Add a new `LlmJudgeConfigSchema` with:
   - `maxTurns`
   - `temperature`
3. Add a new `wake` config object with:
   - `minIntervalMs`
   - `pollMs`
4. Add a new `marketIntelligence` config object with:
   - `maxTrackedPerps`
   - `maxTrackedDexTargets`
   - `maxRefreshedDexTargetsPerTick`
5. Set safe defaults matching current behavior.
6. Add clear validation bounds:
   - turns: integer, min 1
   - tokens: integer, min 1
   - temperatures: numeric, sensible min/max
   - intervals: integer milliseconds with nonzero minimums
   - fanout caps: integer, min 1

#### Validation

1. Update config-schema tests to assert default values match current runtime behavior.
2. Add negative tests for invalid values.

#### Exit criteria

- `AgentRuntimePolicySchema.parse({})` yields the current hardcoded defaults.
- Invalid operator config fails fast.

---

### Slice 2 — Document the knobs in operator config

#### Goal

Make the new runtime controls visible and self-documenting in `config/default.yaml`.

#### Tasks

1. Add `agentRuntime.llm.scout.maxTurns`.
2. Add `agentRuntime.llm.scout.maxTokens`.
3. Add `agentRuntime.llm.scout.temperature`.
4. Add `agentRuntime.llm.judge.maxTurns`.
5. Add `agentRuntime.llm.judge.temperature`.
6. Add `agentRuntime.wake.minIntervalMs`.
7. Add `agentRuntime.wake.pollMs`.
8. Add `agentRuntime.marketIntelligence.maxTrackedPerps`.
9. Add `agentRuntime.marketIntelligence.maxTrackedDexTargets`.
10. Add `agentRuntime.marketIntelligence.maxRefreshedDexTargetsPerTick`.
11. Write comments that explain operational tradeoffs, not just restate field names.

#### Validation

1. Config load tests continue to pass.
2. Inline comments remain consistent with current behavior.

#### Exit criteria

- An operator can discover and understand each new knob from `config/default.yaml` alone.

---

### Slice 3 — Replace hardcoded scout loop values in `agent.ts`

#### Goal

Make scout loop runtime behavior use parsed config instead of literals.

#### Current literals

In `apps/worker/src/agent.ts`:

- scout `maxTokens: 256`
- scout `temperature: 0`
- scout `maxTurns: 3`

#### Tasks

1. Replace scout request `maxTokens: 256` with `agentRuntimePolicy.llm.scout.maxTokens`.
2. Replace scout request `temperature: 0` with `agentRuntimePolicy.llm.scout.temperature`.
3. Replace scout `maxTurns: 3` with `agentRuntimePolicy.llm.scout.maxTurns`.
4. Ensure retry and failure behavior remain unchanged.
5. Keep all semantics of `runStructuredToolLoop` identical.

#### Validation

1. Add or update tests that verify the configured scout turn cap is passed through.
2. Add or update tests that verify scout request settings use config defaults.

#### Exit criteria

- No scout-loop literal remains for the moved settings.

---

### Slice 4 — Replace hardcoded judge loop values in `agent.ts`

#### Goal

Make judge loop runtime behavior use parsed config instead of literals.

#### Current literals

In `apps/worker/src/agent.ts`:

- judge `temperature: 0.3`
- judge `maxTurns: 3`

#### Tasks

1. Replace judge request `temperature: 0.3` with `agentRuntimePolicy.llm.judge.temperature`.
2. Replace judge `maxTurns: 3` with `agentRuntimePolicy.llm.judge.maxTurns`.
3. Leave judge max token behavior unchanged unless a later plan explicitly broadens scope.

#### Validation

1. Add or update tests that verify the configured judge turn cap is passed through.
2. Ensure current behavior is preserved with defaults.

#### Exit criteria

- Judge loop turn cap and temperature come entirely from config.

---

### Slice 5 — Replace hardcoded wake timing values

#### Goal

Make wake-driven scheduling tunable without code changes.

#### Current literals

In `apps/worker/src/agent.ts`:

- `WAKE_MIN_INTERVAL_MS = 15_000`
- `WAKE_SIGNAL_POLL_MS = 1000`

#### Tasks

1. Replace `WAKE_MIN_INTERVAL_MS` with `agentRuntimePolicy.wake.minIntervalMs`.
2. Replace `WAKE_SIGNAL_POLL_MS` with `agentRuntimePolicy.wake.pollMs`.
3. Keep existing wake semantics intact.
4. Ensure no call site still depends on the old constants.

#### Validation

1. Re-run the wake scheduling tests.
2. Re-run the wake-signal tick gating regression tests.

#### Exit criteria

- Wake scheduling behavior is unchanged at defaults and tunable through config.

---

### Slice 6 — Replace hardcoded market-intelligence fanout caps

#### Goal

Make the venue-intelligence breadth caps operator-tunable.

#### Current literals

In `apps/worker/src/agent.ts`:

- `collectPerpsTrackedSymbols(...).slice(0, 3)`
- `collectDexTrackedTargets(...).slice(0, 3)`
- `trackedDexTargets.slice(0, 2)`

#### Tasks

1. Replace the perp symbol cap with `agentRuntimePolicy.marketIntelligence.maxTrackedPerps`.
2. Replace the DEX target collection cap with `agentRuntimePolicy.marketIntelligence.maxTrackedDexTargets`.
3. Replace the per-tick refreshed DEX subset cap with `agentRuntimePolicy.marketIntelligence.maxRefreshedDexTargetsPerTick`.
4. Preserve the existing ordering semantics.

#### Validation

1. Add or update tests for venue-intelligence breadth if a focused test surface exists.
2. If no narrow tests exist, add a minimal helper extraction only if necessary to test this cleanly.

#### Exit criteria

- All three fanout caps are driven by config, not literals.

---

### Slice 7 — Verification and regression hardening

#### Goal

Verify defaults preserve current behavior and new config values are actually honored.

#### Required validation

1. `pnpm lint`
2. Focused worker tests covering:
   - config parsing defaults
   - invalid config rejection
   - scout config usage
   - judge config usage
   - wake scheduling behavior
3. Any targeted existing tests for `agent-wake-scheduler`, `structured-tool-loop`, or runtime config loading

#### Optional follow-up validation

1. Add a small integration-style runtime test if there is already a cheap seam for asserting `maxTurns` is passed into the loop.

#### Exit criteria

- Defaults preserve current behavior.
- Configured non-defaults are consumed by the runtime.

## Implementation Notes

### Why this plan is intentionally narrow

There are additional literals in `agent.ts`, but not all of them belong in config.

Examples that should remain code unless a separate requirement appears:

1. Redis consumer group names
2. stream names
3. fallback prompt strings
4. internal error message strings
5. `process.exit(1)` startup behavior

The goal here is not “config all literals.” The goal is to move policy and operator-tuning values that are likely to need adjustment across environments.

### Why `maxToolCallsPerTurn` is excluded from this plan

`maxToolCallsPerTurn` is a legitimate future control, but it is a behavior change, not just config extraction. It would require a decision on whether to:

1. reject extra tool calls
2. truncate the tool call list
3. fail the turn
4. surface a synthetic tool error back to the model

That deserves its own focused plan after `maxTurns` and adjacent knobs are made configurable.

## Risks

1. Adding too many knobs at once could make the operator config noisy.
2. Scout and judge behavior could drift unintentionally if defaults do not exactly match current literals.
3. Wake timing changes could alter reminder or market-wake latency if validation bounds are too loose.
4. Market-intelligence fanout knobs could increase provider load if operators set them too aggressively.

## Mitigations

1. Match current hardcoded behavior exactly in defaults.
2. Add schema bounds that prevent obviously unsafe values.
3. Keep the first pass limited to a small number of clearly useful knobs.
4. Verify each changed call site with focused tests instead of relying only on typecheck.

## Suggested Delivery Order

1. Schema and defaults
2. YAML documentation
3. Scout config usage
4. Judge config usage
5. Wake config usage
6. Market-intelligence caps
7. Validation and cleanup

## Exit Criteria

- [ ] New runtime config fields are defined and validated.
- [ ] `config/default.yaml` documents the new knobs.
- [ ] Scout loop literals are removed in favor of config.
- [ ] Judge loop literals are removed in favor of config.
- [ ] Wake timing literals are removed in favor of config.
- [ ] Market-intelligence breadth caps are removed in favor of config.
- [ ] Focused tests cover parsing and runtime usage.
- [ ] `pnpm lint` passes.

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-06-12 | Start with `maxTurns` and a small set of adjacent runtime knobs rather than trying to externalize every literal in `agent.ts`. | Keeps the change focused on operationally meaningful policy values. |
| 2026-06-12 | Exclude `maxToolCallsPerTurn` and `maxToolCallsPerTick` from the first implementation plan. | They require behavior decisions beyond simple config extraction. |
| 2026-06-12 | Keep this plan under `docs/features/pending/agent-runtime-loop-controls/001-plan.md`. | Matches repo convention for a focused pending implementation plan. |
