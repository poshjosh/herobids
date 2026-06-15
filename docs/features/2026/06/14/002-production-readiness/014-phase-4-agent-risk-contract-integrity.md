# Phase 4 — Agent Risk Contract Integrity

**Parent phase:** [010-phase-4-config-validation-and-operational-polish.md](./010-phase-4-config-validation-and-operational-polish.md)

**Related docs:**

1. [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md)
2. [runtime-boundary-and-message-contract.md](../../../../../tech/agents/runtime-boundary-and-message-contract.md)
3. [001-plan.md](../../15/009-agent-risk-config-ui/001-plan.md)

## Purpose

Turn the remaining MVP launch blocker around agent risk semantics into one focused implementation slice.

This plan is not about adding more raw risk checks. Those already exist. It is about making the agent risk contract truthful and enforceable end to end:

1. creator-configured limits stay immutable
2. operator defaults remain explicit defaults and ceilings
3. agent-adjustable limits are adjustable only when they came from defaults
4. the runtime can explain which rule came from which source

## Problem

The codebase has partial pieces of the intended contract, but not the contract itself.

What is already true:

1. operator defaults exist in `config.agentRiskDefaults`
2. API create/update validation rejects user-supplied values above operator ceilings
3. worker risk-limit construction preserves explicit user values over defaults
4. `RiskGate` enforces effective numeric limits consistently

What is still missing:

1. the runtime does not track per-field source as `user` vs `default` vs `agent_override`
2. immutable creator limits and mutable default-derived limits are collapsed into the same `RiskLimits` shape
3. there is no first-class persisted home for agent runtime overrides
4. the agent cannot read its effective risk contract in a structured way
5. the agent cannot adjust default-derived limits through a controlled surface

That means the current implementation is numerically functional but contractually incomplete.

## Why This Needs Its Own Doc

This is a launch blocker, but it is narrower than the full Phase 4 umbrella.

It also cuts across multiple layers:

1. operator config
2. creator-configured agent fields
3. worker/runtime resolution
4. agent-facing tool contract
5. engine enforcement inputs

If this stays buried in the larger Phase 4 document, the likely failure mode is another round of partial fixes that preserve values but still lose source and mutability semantics.

## Locked Constraints

These constraints come from the current repo rules and should be treated as non-negotiable for this slice:

1. user-configured limits are immutable at runtime
2. operator defaults are the initial fallback and the ceiling for agent adjustment
3. the agent must be able to read its effective limits
4. the engine risk gate still enforces hard safety invariants regardless of agent autonomy
5. operator config and runtime actor config must stay in separate resolution chains

## Scope

In scope:

1. a typed resolved agent-risk contract with per-field source and mutability
2. persistence for agent-adjustable runtime overrides separate from creator-configured fields
3. a single resolution path that derives effective limits from creator config, operator defaults, and runtime overrides
4. an agent-facing read surface for effective limits
5. an agent-facing adjustment surface for default-derived limits only
6. worker and engine wiring so enforcement uses resolved effective values while immutability rules remain provable
7. focused tests for source, ceiling, adjustment, and reset behavior

Out of scope:

1. redesigning the numeric meaning of every risk field
2. introducing new risk dimensions beyond the current MVP blocker
3. the broader `dailyLossLimit` vs `maxDrawdownPct` schema split from the pending plan
4. rich frontend UX beyond what is already covered in the separate UI plan
5. bot risk-contract redesign

## Current Verified Baseline

From the code as it exists today:

1. `apps/api/src/routes/agents.ts` validates user-entered risk values against `agentRiskDefaults`
2. `apps/worker/src/agent-risk-limits.ts` resolves effective numeric limits by preferring user values and filling gaps from defaults
3. `packages/engine/src/risk-gate.ts` enforces the resulting values uniformly
4. `apps/web/src/features/agents/AgentControlsSection.tsx` already has risk-control form fields in the web surface

The missing layer is the two-path runtime contract, not basic field presence.

## Design Direction

The core design rule for this plan is:

**Do not overload the existing nullable creator-configured columns to represent agent runtime adjustments.**

Those columns currently mean:

1. explicit creator-set hard limit when non-null
2. use operator default when null

If agent adjustments overwrite those same fields, the system loses the ability to prove:

1. what the creator explicitly locked
2. which limits remain mutable
3. whether a current value came from the user, the operator fallback, or the agent

So this plan should introduce a separate persisted home for runtime risk overrides.

## Target State

After this slice:

1. every agent risk field resolves to a structured descriptor with:
   - effective value
   - source
   - mutable flag
   - operator ceiling
   - creator-configured value when present
2. creator-configured values remain hard limits that the agent cannot weaken or clear
3. default-derived values can be adjusted by the agent within operator ceilings
4. agent runtime adjustments persist separately from creator config and survive restart
5. the worker derives `RiskLimits` from the resolved contract rather than from raw agent fields alone
6. the agent can inspect and update only the subset of fields that are actually mutable

## Implementation Plan

### Step 1: Define a typed resolved risk-contract model

**Goal:** create one canonical domain model that represents risk limit source, ceiling, effective value, and mutability.

Add a small domain-level contract for agent risk semantics, for example:

```typescript
type AgentRiskFieldSource = 'user' | 'default' | 'agent_override';

interface AgentRiskField<T> {
  effectiveValue: T;
  source: AgentRiskFieldSource;
  mutable: boolean;
  operatorCeiling: T;
  creatorValue?: T;
  overrideValue?: T;
}

interface ResolvedAgentRiskContract {
  maxOpenPositions: AgentRiskField<number>;
  maxPositionSizePct?: AgentRiskField<number>;
  stopLossPct: AgentRiskField<number>;
  stopLossCooldownMs: AgentRiskField<number>;
  dailyLoss: AgentRiskField<{ mode: 'absolute' | 'pct'; value: number }>;
}
```

The exact shape may vary, but the important part is that source and mutability become first-class, typed data rather than comments or implied behavior.

Likely files:

1. `packages/domain/src/` new contract helper or schema module
2. `apps/worker/src/agent-risk-limits.ts`
3. related worker tests

### Step 2: Add persistence for agent runtime risk overrides

**Goal:** persist agent-adjustable values without destroying the meaning of creator-configured fields.

Preferred direction:

1. keep existing agent table columns as creator-owned nullable inputs
2. add a separate persisted structure for runtime overrides
3. store only fields that the agent has actively changed
4. support explicit reset back to operator default by clearing the override

Acceptable storage forms:

1. dedicated `agent_risk_overrides` table keyed by `agent_id`
2. or a separate JSONB column if the team wants a smaller schema footprint

The critical rule is separation of ownership, not the exact storage primitive.

Migration note: existing agents that have no runtime overrides start with an empty override set. Their effective limits remain unchanged (creator-configured values or operator defaults apply as before). No backfill is required.

Likely files:

1. `packages/db/src/schema/agents.ts` or a new risk-overrides schema file
2. `packages/db/src/repositories.ts`
3. migration files

### Step 3: Centralize contract resolution in one helper

**Goal:** eliminate duplicated, partial resolution logic across API, worker, and tool surfaces.

Add one resolver that combines:

1. creator-configured agent values
2. operator defaults from `appConfig.agentRiskDefaults`
3. persisted runtime overrides

Resolution rules:

1. creator value present → source `user`, mutable `false`, effective value = creator value
2. creator value absent and runtime override absent → source `default`, mutable `true`, effective value = operator default
3. creator value absent and runtime override present → source `agent_override`, mutable `true`, effective value = override value
4. no runtime override may exceed operator ceiling
5. no runtime override may exist for a creator-locked field

Likely files:

1. `apps/worker/src/agent-risk-limits.ts`
2. `apps/worker/src/agents/agent-intake-resolver.ts`
3. `apps/worker/src/index.ts`
4. any API serializer that exposes agent controls

### Step 4: Expose a read surface for effective agent risk limits

**Goal:** make the effective contract visible to both the agent and operators.

The agent needs a machine-readable view that says more than just "here are numbers". It must be able to see:

1. current effective value
2. source of that value
3. whether it may change it
4. operator ceiling

This can be exposed through:

1. an API response field used by the web and worker
2. a worker/runtime query surface for agent tools
3. optional activity or audit metadata when limits change

Likely files:

1. `apps/api/src/routes/agents.ts`
2. `apps/web/src/features/agents/AgentControlsSection.tsx`
3. agent runtime tool contract files if the current tool catalog is already structured for it

### Step 5: Add a controlled agent-facing adjustment surface

**Goal:** let agents adjust only the limits that are default-derived and therefore mutable.

Add a focused tool or command surface, likely named `adjust_risk_limits`, with behavior such as:

1. update one or more mutable fields
2. reject attempts to change creator-locked fields
3. reject attempts above operator ceilings
4. allow reset to operator default by clearing an override
5. persist override changes durably before returning success

This tool should be narrow. It is not a general config editor.

Interaction boundary: a runtime override takes effect on the *next* decision cycle. In-flight execution (e.g., a pending swap or open position being managed) is not retroactively constrained by a newly applied override. The engine evaluates limits at decision submission time, not retroactively against committed work.

Likely files:

1. worker agent tool registration and handler files
2. `apps/api/src/routes/agents.ts` or a dedicated route if persistence flows through API
3. repository methods for reading and writing overrides

### Step 6: Build `RiskLimits` from the resolved contract, not raw columns

**Goal:** preserve the current engine enforcement while making the contract semantics truthful.

The engine does not need to know every provenance detail. `RiskGate` can still enforce a plain numeric `RiskLimits` shape.

But the worker must now derive that shape from the resolved contract, not directly from:

1. raw creator-configured agent columns
2. ad hoc fallback logic

This keeps the engine simple while ensuring runtime decisions reflect the two-path model.

Likely files:

1. `apps/worker/src/agent-risk-limits.ts`
2. `apps/worker/src/agents/agent-intake-resolver.ts`
3. `apps/worker/src/agent-trading-actor.ts`
4. `packages/engine/src/risk-gate.ts` only if small typing changes are needed

### Step 7: Add focused regression coverage

**Goal:** prove the contract, not just the numeric calculations.

Required test classes:

1. creator-configured field resolves as immutable and ignores runtime override attempts
2. default-derived field resolves as mutable and accepts valid runtime override
3. override above operator ceiling is rejected
4. clearing an override resets the field back to operator default
5. worker restart reloads overrides and preserves effective values
6. engine receives the resolved effective limits consistently
7. agent-facing read surface reports source and mutability correctly

Likely files:

1. `apps/worker/src/agent-risk-limits.test.ts`
2. `apps/worker/src/agents/agent-intake-resolver.test.ts`
3. `apps/api/src/routes/agents.test.ts`
4. integration tests for agent runtime or decision submission if a tool surface is added

## Acceptance Criteria

This slice is done when all of the following are true:

1. every agent risk field has a truthful resolved source at runtime
2. user-configured risk values cannot be weakened by the agent
3. default-derived risk values can be adjusted by the agent within operator ceilings
4. runtime overrides persist separately from creator config and survive restart
5. the agent can read its effective limits and see which ones are mutable
6. `RiskGate` enforcement uses the resolved effective values consistently
7. focused tests cover immutable, mutable, ceiling, reset, and restart behavior

## Suggested Validation

1. focused tests for `agent-risk-limits.ts`
2. focused tests for agent route validation and serialization
3. focused tests for agent tool or command handling if added
4. one integration test proving a default-derived limit can change while a creator-locked limit cannot
5. `pnpm lint`

## Relationship To Other Plans

This plan closes the contractual backend/runtime gap for the MVP launch blocker.

It is related to, but separate from:

1. [001-plan.md](../../15/009-agent-risk-config-ui/001-plan.md), which is primarily about creator-facing UI exposure
2. `docs/features/pending/split-agent-loss-and-drawdown-limits/001-plan.md`, which is a broader schema refinement and not required to establish the two-path mutability contract

## Relationship To Release Checklist

Closing this doc should directly move `Risk contract integrity` in [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md) from `incomplete` to `complete`.