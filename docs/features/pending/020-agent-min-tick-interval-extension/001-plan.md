# Agent Minimum Tick Interval Extension

## Summary

Add an agent mode where the configured tick interval becomes a minimum rather than a fixed cadence. When enabled for an agent, the agent may request that its next scheduled tick occur later than the current effective interval. The agent must never be able to shorten the cadence below the existing schedule floor, and wake signals must still be allowed to trigger earlier ticks.

This plan covers the worker/runtime behavior, API/domain contract, and a create/edit UI control in Advanced Settings -> AI under the existing tick interval field.

## Recommended Product Semantics

### Core behavior

- The existing tick interval remains the minimum timer cadence.
- If the feature is enabled for the agent, the agent may request a one-shot delay for the next scheduled timer tick.
- A requested delay may only increase the next timer delay; it must never decrease it.
- The delay request is consumed after one scheduling decision. It does not persist indefinitely.
- Wake-driven ticks still override the delayed timer and may fire earlier than the requested delay.

### Recommended creator-facing controls

Under the AI tab in Advanced Settings, directly under Tick interval:

- Checkbox: Allow agent to delay its next tick beyond the base interval

Recommended UX behavior:

- Checkbox off: agent cannot request later ticks.
- Checkbox on: agent may request a later next timer tick, bounded by operator-controlled limits.

If the max extra delay is operator-owned, it should not be configurable per agent in create/edit. The create/edit form should only expose the permission boundary.

## Architecture Recommendation

Use `runtimePolicyOverrides` and resolved runtime policy instead of adding new top-level agent columns.

Reasoning:

- The system already resolves per-agent runtime behavior from `style + runtimePolicyOverrides`.
- The worker already receives `resolvedRuntimePolicy` in `agent-session-manager.ts`.
- `runtime_policy_overrides` is JSONB, so this change avoids a database migration.
- The feature is a per-agent runtime behavior permission, which fits the existing policy flow better than a standalone column.

Recommended new fields:

- `allowTickIntervalExtension: boolean | null`

Resolved policy additions:

- `allowTickIntervalExtension: boolean`
- `maxTickIntervalExtensionMs: number | undefined`

Default values:

- Style defaults: `allowTickIntervalExtension = false`
- Style defaults do not define a per-agent cap override.
- Operator hard cap lives in config.

## Detailed Plan

### 1. Extend domain runtime-policy schema

Files:

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/schema.test.ts`
- `packages/domain/src/config/runtime-policy-propagation.integration.test.ts`

Changes:

- Extend `AgentRuntimePolicyOverridesSchema` with:
  - `allowTickIntervalExtension: z.boolean().nullable().optional()`
- Extend `ResolvedAgentRuntimePolicy` with the same fields in resolved form.
- Add the fields to `AGENT_STYLE_RUNTIME_DEFAULTS` for all styles with conservative defaults:
  - `allowTickIntervalExtension: false`
  - `maxTickIntervalExtensionMs: undefined`
- Update `resolveAgentRuntimePolicy()` so runtime overrides can enable the feature, while the resolved cap comes from operator config.

Validation rules:

- `allowTickIntervalExtension` remains the only per-agent override.
- `maxTickIntervalExtensionMs` is resolved from operator config, not agent input.

Recommendation:

- Keep the runtime cap as an extension amount, not an absolute next-tick time. That avoids awkward invariants with changing base/effective intervals.

### 2. Add operator hard cap

Files:

- `config/default.yaml`
- `config/development.yaml` if needed for local testing clarity
- `packages/domain/src/config/schema.ts` if the operator config schema needs expansion
- Any config tests that validate resolved config loading

Changes:

- Add one operator-owned hard cap for this feature under agent runtime config or the runtime policy ceiling area, whichever is already the authoritative location for loop controls.

Recommended fields:

- `agentRuntime.tickExtension.maxExtensionMs: 86_400_000` (24h suggested hard cap)

Notes:

- The user-facing per-agent setting should never be able to exceed `maxExtensionMs`.
- The agent UI does not expose this value because it is operator-owned.
- The worker resolves one effective cap from operator config.

### 3. Propagate resolved policy into worker behavior

Files:

- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/agent-wake-scheduler.ts`
- `apps/worker/src/agent-wake-scheduler.test.ts`

Changes:

- No major propagation change should be needed if the new fields are part of `resolvedRuntimePolicy`; they will already flow through `agentConfig`.
- In `agent.ts`, add module-level one-shot scheduling state for the agent-requested delay.

Recommended runtime state:

- `let requestedNextTickDelayMs: number | null = null`
- optionally `let requestedNextTickReason: string | null = null` for logging/debugging

Scheduling behavior:

- When `scheduleNextTick(delayMs = effectiveTickIntervalMs)` runs, compute:
  - base timer delay = current scheduling delay
  - agent requested delay = one-shot requested total delay
  - effective timer delay = `Math.max(base timer delay, requested delay)`
- Then clear the one-shot request after it has been consumed into a scheduled timer.

Clamp behavior:

- If agent extension is disabled, ignore tool requests.
- If enabled, clamp the requested total delay to:
  - lower bound: current effective delay
  - upper bound: `current effective delay + operatorHardCapTickIntervalExtensionMs`

Wake precedence:

- Preserve current wake behavior.
- `resolveNextTickDelay()` should continue to allow wake-driven earlier ticks.
- If a wake arrives before the delayed timer fires, the wake-triggered tick should run and the previously delayed timer state should be considered satisfied/consumed by normal rescheduling.

Logging:

- Log accepted/clamped/rejected delay requests with requested ms, applied ms, and cap.
- Log when a delayed tick is pre-empted by a wake.

### 4. Add an agent tool for one-shot delay requests

Files:

- `apps/worker/src/tools/index.ts`
- new file such as `apps/worker/src/tools/tick-scheduling.ts`
- related tool tests

Changes:

- Add a new tool, recommended name: `set_next_tick_delay`

Recommended tool contract:

- Input:
  - `delayMinutes` or `delayMs`
  - optional `reason` for journaling/logging only
- Behavior:
  - is excluded from the agent tool list when `allowTickIntervalExtension` is not enabled
  - fails if the agent is not permitted
  - accepts a one-shot request for the next timer tick
  - clamps to the allowed range
  - returns the requested delay, applied delay, and the expected next timer time

Recommended tool description:

- Explain clearly that the tick interval is a minimum cadence.
- Explain that wake signals may still trigger earlier ticks.
- Explain that the request is one-shot and only affects the next scheduled timer tick.

Context wiring:

- Extend `ToolContext` with a small scheduling-control surface instead of letting tools mutate module locals directly.
- Example methods:
  - `getTickSchedulingPolicy()`
  - `requestNextTickDelay(totalDelayMs: number, reason?: string)`

This keeps the tool implementation testable and avoids leaking scheduler internals into tool modules.

Visibility and enforcement:

- Filter the tool out of the visible tool list unless `allowTickIntervalExtension` is enabled for the agent.
- Still keep execution-time permission checks in the tool handler as a fail-closed safeguard.
- Treat "tool visible" and "tool permitted" as aligned in the normal path, with handler validation covering drift or bugs.

### 5. Update prompt/context so the agent understands the feature

Files:

- `apps/worker/src/prompt-timing-context.ts`
- `apps/worker/src/runtime-composition.ts`
- any prompt composition tests

Changes:

- Extend timing or runtime prompt context so the agent can see:
  - current nominal tick interval
  - whether it may delay the next timer tick
  - the operator hard cap for extra delay it is allowed to request
  - that wakes can still trigger earlier
- If a delay is currently pending, optionally expose the pending scheduled next tick time.
- Add a short prompt-guidance section explaining when delaying the next scheduled timer tick is cost-efficient, but only when `allowTickIntervalExtension` is enabled.

Recommendation:

- Do not rely only on the tool description. Put the permission and constraint in prompt context so the agent can reason about it before deciding whether to call the tool.
- Gate the guidance on the same permission as the tool. If the agent cannot extend ticks, do not mention the tactic in prompt guidance.

Recommended guidance content:

- Tell the agent it may save cost by delaying the next scheduled timer tick when the market is quiet, low-volatility, and not near a decision boundary.
- More concretely: favor delay only when there is no urgent position management, no fresh wake signal, no near-trigger watch, no reminder deadline, no regime/news shock, and market structure is materially unchanged.
- Do not suggest delay when volatility is expanding, a watch is near trigger, a position needs active management, or timely follow-up is likely needed.

### 6. Extend API request/response schemas

Files:

- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/agent-config-helpers.ts`
- `apps/api/src/routes/agents.test.ts`
- `apps/api/src/routes/agent-interactivity.ts` if it exposes the same shape
- `apps/web/src/lib/api-client.ts`

Changes:

- Accept the new runtime-policy override field on create and patch.
- Ensure `decorateAgentResponse()` includes them through `resolvedRuntimePolicy`.
- If the frontend reads raw `runtimePolicyOverrides`, ensure the types include the new fields there too.

Validation additions:

- No per-agent cap field should be accepted if the cap is operator-owned.
- Normalize missing/false `allowTickIntervalExtension` cleanly.

Note:

- Because the fields live in `runtimePolicyOverrides`, no repository schema migration should be required.

### 7. Add create/edit UI controls in Advanced Settings -> AI

Files:

- `apps/web/src/features/agents/AgentControlsSection.tsx`
- `apps/web/src/features/agents/AgentFormBody.tsx`
- `apps/web/src/features/agents/agent-form-state.ts`
- `apps/web/src/features/agents/agent-payloads.ts`
- `apps/web/src/features/agents/style-mapping.ts`
- `apps/web/src/features/agents/form-validation.ts`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/EditAgentModal.render.test.tsx`
- create-flow tests in `apps/web/src/features/agents/*.test.ts`
- i18n files:
  - `apps/web/src/app/i18n/locales/en.ts`
  - `apps/web/src/app/i18n/locales/ar.ts`
  - `apps/web/src/app/i18n/locales/hi.ts`

Recommended UX layout:

- Keep the existing Tick interval field unchanged.
- Directly below it add:
  - checkbox: Allow agent to delay its next tick beyond this interval
  - helper text: The tick interval remains the minimum cadence. The agent may request a later next timer tick, but wake signals can still run sooner.

Do not add a per-agent max extra delay field if that limit is operator-owned.

State wiring:

- Extend `AgentFormState` with UI-friendly fields, for example:
  - `allowTickIntervalExtension: boolean`
- Map that field into `runtimePolicyOverrides` in `agent-payloads.ts`.
- Hydrate them from existing agent data in `agentToFormState()`.

Validation:

- If checkbox is unchecked, clear the outgoing override payload for this permission.
- Consider adding the new field to `ADVANCED_FIELD_TAB` so validation can auto-open the AI tab.

Recommendation:

- Do not overload the existing `tickIntervalMins` field semantics in the UI. Keep the base cadence and the permission to delay distinct.

### 8. Decide how style defaults interact with the feature

Recommendation for v1:

- All styles default to disabled.
- This is a creator opt-in behavior, not something inferred from careful/balanced/bold.

Reasoning:

- It is a capability permission, not a style personality trait.
- It keeps rollout conservative.
- It avoids surprising cadence changes for existing agents.

### 9. Testing plan

#### Domain/config

- `AgentRuntimePolicyOverridesSchema` accepts the new permission field.
- operator config rejects invalid cap values.
- `resolveAgentRuntimePolicy()` returns expected defaults and overrides.

#### API

- create agent persists the new permission field through `runtimePolicyOverrides`.
- patch agent updates and clears the permission field correctly.
- response decoration exposes the resolved values.

#### Worker runtime

- when disabled, tool request is rejected.
- when enabled, a request later than the current effective interval delays the next timer tick.
- a request earlier than the current effective interval is clamped upward and does not accelerate the schedule.
- a request above the per-agent or operator cap is clamped downward.
- a wake arriving before the delayed timer still triggers early.
- the request is one-shot and is cleared after scheduling/consumption.

#### Web

- create flow serializes the checkbox into `runtimePolicyOverrides`.
- edit flow hydrates persisted values and sends patch updates correctly.
- conditional field rendering works.
- i18n strings render in create/edit forms.

### 10. Documentation updates

Files:

- `docs/tech/agents/runtime-policy-and-reasoning.md`
- optionally `README.md` if it documents tick cadence behavior
- optionally product/help content for agent settings

Changes:

- Update the runtime policy doc to explain that the configured tick interval is the minimum cadence when this feature is enabled.
- Document that agent-requested delay is one-shot and wake signals still pre-empt timer delays.

## Suggested Implementation Order

1. Extend domain/runtime-policy schemas and tests.
2. Propagate resolved policy and add worker scheduling state.
3. Add the `set_next_tick_delay` tool and worker tests.
4. Extend API types and route validation.
5. Add web form state, payload mapping, and AI-tab controls.
6. Add render/form tests and i18n.
7. Update docs.
8. Run focused tests, then `pnpm lint`.

## Risks and Guardrails

- Risk: agents self-silence for too long.
  - Mitigation: creator opt-in, operator-owned hard cap, wakes still pre-empt.
- Risk: stale requested delay persists across multiple ticks.
  - Mitigation: one-shot request state must be consumed and cleared deterministically.
- Risk: scheduler complexity introduces missed reschedules.
  - Mitigation: keep the change inside existing `scheduleNextTick()` / wake scheduler flow and add focused unit tests.
- Risk: prompt ambiguity causes incorrect agent assumptions.
  - Mitigation: expose the permission and cap explicitly in prompt context and tool description.

## Open Decisions

These do not block drafting, but should be settled before implementation starts:

1. Should the tool accept minutes or milliseconds?
   Recommendation: use minutes in the agent-facing tool for readability, but store and schedule in milliseconds.
2. Should the agent be allowed to replace an already-pending delay request before the next tick fires?
   Recommendation: yes; latest valid request wins.
3. Should the pending delayed next tick be surfaced in prompt context after the tool is used?
   Recommendation: yes, if easy to expose without extra prompt noise.

## Non-Goals For V1

- No persistent multi-tick slowdown mode.
- No new wake-source types.
- No agent ability to suppress or defer wakes.
- No attempt to move base `tickIntervalMs` into runtime-policy overrides in this change.