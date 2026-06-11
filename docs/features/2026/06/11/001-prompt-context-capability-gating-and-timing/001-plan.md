# Plan: Prompt Context Capability Gating And Timing

## Goal

Update agent-facing prompts so that:

- all agents receive explicit timing context in Operating Context
- trading-only prompt fields are excluded from non-trading agents
- judge and scout prompts use the same timing source and wording for exact versus estimated scheduling data

This plan combines two related fixes into one prompt-composition task:

1. Exclude trading-related info from non-trading agents.
2. Add prompt timing context to both judge and scout prompts.

## Current State

### Prompt builders

- `apps/worker/src/runtime-composition.ts`
  - `buildSystemPrompt(state)` builds the judge/system prompt.
  - It currently injects `Current time (UTC)` inside `## Operating Context` using `new Date().toISOString()` locally.
  - It currently renders trading-related fields unconditionally:
    - `Execution mode`
    - `Daily loss limit`
    - `Max concurrent bots`
- `apps/worker/src/scout-dispatch.ts`
  - `buildScoutSystemPrompt(...)` currently does not include timing context.
  - It takes `agentId`, optional `name`, `goal`, and `readOnlyTools`.
- `apps/worker/src/agent.ts`
  - Around the current prompt-build call sites, the runtime has access to the live scheduling state needed to produce explicit timing context:
    - `costProfile.tickIntervalMs`
    - `effectiveTickIntervalMs`
    - `nextTickDueAt`
  - The judge prompt is built around the `composeSystemPrompt(runtimeState)` call.
  - The scout prompt is built around the `buildScoutSystemPrompt(...)` call.

### Descriptor/runtime shape

- `packages/domain/src/runtime-composition.ts`
  - `RuntimeDescriptor.executionMode` is currently required as `string`.
- `packages/db/src/agent-runtime-descriptor.ts`
  - `buildRuntimeDescriptor(...)` defaults `executionMode` to `'paper'`.
- `apps/worker/src/agent.ts`
  - `buildFallbackRuntimeDescriptor()` also defaults `executionMode` to `'paper'`.

### Why non-trading leakage happens

Trading-related information appears for non-trading agents for two separate reasons:

1. Prompt rendering is unconditional in `buildSystemPrompt()` and the `core-platform` static block.
2. Runtime descriptor construction defaults `executionMode` to `'paper'` even when the agent has no trading capability.

The user-visible defect can be fixed at the prompt layer without immediately changing the descriptor contract.

## Proposed Implementation

### 1. Introduce an explicit prompt timing context

Create a small worker-local shared type for prompt timing, used by both prompt builders.

Recommended shape:

```ts
export interface PromptTimingContext {
  currentTimeIso: string;
  nominalTickIntervalMs: number;
  expectedNextTickIso: string | null;
}
```

Recommended location:

- new file: `apps/worker/src/prompt-timing-context.ts`

Reasoning:

- keeps the timing contract explicit and shared between judge and scout prompt builders
- avoids duplicating timestamp logic or letting each prompt builder call `new Date()` independently
- avoids coupling `scout-dispatch.ts` to `runtime-composition.ts`

### 2. Compute timing context once per tick in `agent.ts`

Update `apps/worker/src/agent.ts` in the prompt-build slice around the existing call sites so both prompts receive the same timing object.

Concrete change:

- compute a `PromptTimingContext` immediately before prompt construction in `runTick()`
- populate it from live runtime state:
  - `currentTimeIso`: exact `new Date().toISOString()` at prompt-build time
  - `nominalTickIntervalMs`: `costProfile.tickIntervalMs`
  - `expectedNextTickIso`: derived from runtime scheduling state, but labeled tentative

Implementation detail for `expectedNextTickIso`:

- Prefer a timestamp derived from the runtime’s current scheduling expectation rather than hard-coding nominal interval.
- Because `nextTickDueAt` can be `0` while the current tick is in flight and before rescheduling completes, the plan should define a stable fallback:
  - if `nextTickDueAt > 0`, use `new Date(nextTickDueAt).toISOString()`
  - otherwise estimate from `Date.now() + effectiveTickIntervalMs`

This preserves the user’s requested exact-vs-estimated distinction:

- `Current time (UTC)` is exact
- `Expected next tick (UTC, tentative)` is explicitly estimated/tentative
- `Nominal tick interval` remains the stable operator-facing baseline

### 3. Extend judge/system prompt builder to accept timing context

Update `apps/worker/src/runtime-composition.ts`:

- change `buildSystemPrompt(state)` to `buildSystemPrompt(state, timing)`
- render a normalized `## Operating Context` block that includes:
  - `Current time (UTC): ...`
  - `Nominal tick interval: ...`
  - `Expected next tick (UTC, tentative): ...` when available

Implementation notes:

- add a small formatter for tick intervals, for example rendering human-readable minutes where practical
- do not let `buildSystemPrompt()` call `new Date()` internally anymore once timing is plumbed in
- preserve current prompt ordering unless there is a strong reason to reorder sections

### 4. Extend scout prompt builder to accept timing context

Update `apps/worker/src/scout-dispatch.ts`:

- extend `buildScoutSystemPrompt(...)` params with `timing: PromptTimingContext`
- add an `Operating Context` section or equivalent lines that include:
  - `Current time (UTC): ...`
  - `Nominal tick interval: ...`
  - `Expected next tick (UTC, tentative): ...` when available

The scout and judge wording should match exactly for the timing lines so agents are not exposed to conflicting semantics.

### 5. Add trading-capability gating for prompt fields

Update `apps/worker/src/runtime-composition.ts` to gate trading-only prompt fields.

Add a helper such as:

```ts
function hasTradingCapability(runtimeDescriptor: RuntimeDescriptor): boolean
```

Recommended detection strategy:

- check `resolvedSkills[*].capabilityFamilies` for `trading`
- or `readinessByFamily['trading']`
- or `grantedBindingsByFamily['trading']`

Use this helper in two places:

1. `RUNTIME_CONTEXT_PROVIDERS` static `core-platform` block
   - hide `Execution mode` for non-trading agents
2. `buildSystemPrompt()`
   - hide trading-only lines for non-trading agents:
     - `Execution mode`
     - `Daily loss limit`
     - `Max concurrent bots`

Keep non-trading-safe global fields visible for all agents:

- `Current time (UTC)`
- `Nominal tick interval`
- `Expected next tick (UTC, tentative)`
- `Daily token budget`
- tool visibility
- goal

### 6. Decide whether to clean up the runtime descriptor contract now or later

There are two implementation options.

#### Option A: Prompt-layer gating only

Change only prompt rendering.

Pros:

- smallest change
- lowest risk
- immediately fixes the user-visible defect
- avoids rippling `executionMode` nullability through worker/domain/tests

Cons:

- non-trading agents still carry a synthetic `executionMode: 'paper'` in runtime descriptor data

#### Option B: Prompt-layer gating plus descriptor cleanup

Also update the descriptor contract so non-trading agents stop carrying fake trading defaults.

Likely file touches:

- `packages/domain/src/runtime-composition.ts`
  - make `RuntimeDescriptor.executionMode` nullable/optional
- `packages/db/src/agent-runtime-descriptor.ts`
  - stop defaulting to `'paper'` for non-trading descriptors
- `apps/worker/src/agent.ts`
  - same fallback adjustment
- worker tests and any call sites relying on required `executionMode`

Pros:

- cleaner semantics at the data model level
- avoids future accidental prompt leakage from other surfaces

Cons:

- larger surface area
- higher regression risk
- may affect unrelated worker/runtime code that expects a concrete string

Recommendation:

- implement Option A in this task unless code inspection during implementation shows Option B is now cheap and low-risk
- record Option B as a follow-up if not taken

## Concrete File Plan

### Primary implementation files

1. `apps/worker/src/agent.ts`
   - compute shared `PromptTimingContext`
   - plumb timing into both prompt builders
2. `apps/worker/src/runtime-composition.ts`
   - add trading-capability helper
   - update `buildSystemPrompt()` signature and rendering
   - conditionally render trading-only fields
   - add interval formatting helper if needed
3. `apps/worker/src/scout-dispatch.ts`
   - extend prompt builder params with timing context
   - add timing lines to scout prompt
4. `apps/worker/src/prompt-timing-context.ts`
   - new shared timing type/module for judge + scout prompt builders

### Supporting type/contract files

5. `packages/domain/src/runtime-composition.ts`
   - only if descriptor cleanup is included in scope
6. `packages/db/src/agent-runtime-descriptor.ts`
   - only if descriptor cleanup is included in scope

### Test files

7. `apps/worker/src/runtime-composition.test.ts`
   - extend prompt assertions for timing context
   - add non-trading prompt assertions excluding trading-only fields
   - add trading prompt assertions preserving them
8. `apps/worker/src/scout-dispatch.test.ts`
   - add timing context assertions
   - verify scout wording matches explicit exact/tentative semantics
9. `apps/worker/src/agent-wake-scheduler.test.ts` or a new focused worker test
   - only if a narrow tick-level timing test is feasible and useful

## Ordered Task List

1. Add a shared worker-local `PromptTimingContext` type/module.
   - Dependency: none.
   - Files: `apps/worker/src/prompt-timing-context.ts`.

2. Update `apps/worker/src/agent.ts` to construct one timing context per tick and pass it to both prompt builders.
   - Dependency: Task 1.
   - Files: `apps/worker/src/agent.ts`.
   - Notes: use exact current time plus explicit tentative next-tick timestamp.

3. Update `buildSystemPrompt()` in `apps/worker/src/runtime-composition.ts` to accept timing context and render Operating Context with explicit exact/tentative wording.
   - Dependency: Task 2.
   - Files: `apps/worker/src/runtime-composition.ts`.

4. Add a trading-capability helper in `apps/worker/src/runtime-composition.ts` and gate trading-only fields in both the static core-platform block and the system prompt body.
   - Dependency: Task 3.
   - Files: `apps/worker/src/runtime-composition.ts`.

5. Update `buildScoutSystemPrompt()` in `apps/worker/src/scout-dispatch.ts` to accept timing context and render the same timing lines.
   - Dependency: Task 2.
   - Files: `apps/worker/src/scout-dispatch.ts`.

6. Update judge/scout prompt tests.
   - Dependency: Tasks 3, 4, 5.
   - Files:
     - `apps/worker/src/runtime-composition.test.ts`
     - `apps/worker/src/scout-dispatch.test.ts`

7. Decide whether descriptor cleanup belongs in this same implementation or should remain follow-up work.
   - Dependency: after Tasks 3–5 are understood in code.
   - Files if included:
     - `packages/domain/src/runtime-composition.ts`
     - `packages/db/src/agent-runtime-descriptor.ts`
     - `apps/worker/src/agent.ts`
   - Recommendation: do not block prompt fix on this unless the change surface remains small.

8. Run focused validation, then repo typecheck.
   - Dependency: all code changes complete.
   - Commands:
     - focused `vitest` for runtime/scout prompt tests
     - `pnpm lint`

## Test Strategy

### Unit tests

- `apps/worker/src/runtime-composition.test.ts`
  - judge prompt includes:
    - `Current time (UTC)`
    - `Nominal tick interval`
    - `Expected next tick (UTC, tentative)`
  - non-trading descriptor does not include:
    - `Execution mode`
    - `Daily loss limit`
    - `Max concurrent bots`
  - trading descriptor still includes them

- `apps/worker/src/scout-dispatch.test.ts`
  - scout prompt includes the same timing lines
  - scout prompt wording explicitly labels next tick as tentative

### Narrow integration or behavior test

- Optional worker-level test if a small surface exists:
  - verify the same timing context object feeds both judge and scout prompt builders during a tick
  - verify expected-next-tick output remains present even when reschedule state is currently derived rather than already scheduled

### Repo validation

- `pnpm vitest run apps/worker/src/runtime-composition.test.ts apps/worker/src/scout-dispatch.test.ts`
- `pnpm lint`

## Risks And Open Questions

1. `nextTickDueAt` is not always authoritative during prompt construction.
   - Mitigation: never present it as authoritative; label as `Expected next tick (UTC, tentative)`.

2. Human-readable interval formatting can create noisy snapshots if formatting rules are inconsistent.
   - Mitigation: centralize formatting in one helper and keep it stable.

3. Prompt-layer gating alone fixes the user-visible issue but leaves the descriptor semantically noisy.
   - Mitigation: record descriptor cleanup as explicit follow-up if not included.

4. There may be other prompt surfaces beyond judge and scout that later reuse `RuntimeDescriptor.executionMode` directly.
   - Mitigation: search for prompt text renderers using `executionMode` during implementation before deciding whether prompt-layer gating is sufficient.

## Recommended Scope Decision

Implement this as a single prompt-composition task with:

- shared timing context plumbed from `agent.ts`
- judge + scout timing updates
- trading-only prompt field exclusion for non-trading agents
- tests covering both capability gating and timing wording

Treat descriptor cleanup as optional follow-up unless implementation shows it can be completed safely with minimal extra surface.
