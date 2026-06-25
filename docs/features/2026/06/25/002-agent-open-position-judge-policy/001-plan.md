# Plan: Per-Agent Open Position Escalation To Judge Policy

**Status:** draft  
**Created:** 2026-06-25  
**Feature ID:** 002-agent-open-position-judge-policy

## Problem

The worker currently forces judge on any tick with open positions in `apps/worker/src/scout-gating.ts`. That behavior is hard-coded and cannot vary per agent.

The product now wants this behavior to be configurable per agent and aligned with the existing frontend personas:

- `careful` -> `never`
- `balanced` -> `uncovered_or_triggered`
- `bold` -> `always`

The configuration name should be explicit: `openPositionEscalationToJudgePolicy`.

This change spans backend and frontend because:

- the policy must be persisted per agent
- create and edit flows must expose or derive it
- the worker must consume it at runtime
- the existing style/persona system must map to it predictably
- user-facing copy may need to replace `Standard` with `Balanced` where the current label would otherwise confuse the persona mapping

## Scope

Add a new per-agent config field, `openPositionEscalationToJudgePolicy`, wired end to end across DB, API, worker, and web.

Out of scope:

- redesigning the full watch-coverage system
- changing the first-tick and judge-reminder rules; those remain unconditional
- renaming the backend `costPreset` enum value `standard` unless we explicitly decide to broaden the change beyond user-facing copy

## Product Decisions

### 1. Canonical policy field

Persist an explicit per-agent field:

```ts
openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always'
```

Semantics:

- `never`: open positions alone do not force judge
- `uncovered_or_triggered`: force judge only when open-position management is actionable
- `always`: any open position forces judge

### 2. Persona mapping

Frontend style/persona defaults map to the policy as follows:

- `careful` -> `never`
- `balanced` -> `uncovered_or_triggered`
- `bold` -> `always`

This mapping is intentionally independent from the existing cost preset mapping.

### 3. Explicit field beats inferred style

`style` remains a preset source, not the worker’s runtime source of truth.

The worker must read `openPositionEscalationToJudgePolicy` directly from the agent record, not infer it from `style`.

### 4. Update behavior

Create flow:

- initialize `openPositionEscalationToJudgePolicy` from the selected style
- allow the user to override it in advanced controls

Edit flow:

- show the current explicit stored value
- allow it to be changed directly
- do not silently rewrite it from `style` after initial creation unless the UI explicitly offers a “reset to style defaults” action

## Backend Plan

### Phase 1: Database and repository layer

Add a new nullable or non-nullable agent column for the policy.

Recommended shape:

- column name: `open_position_escalation_to_judge_policy`
- stored values: `never`, `uncovered_or_triggered`, `always`

Files:

- `packages/db/src/schema/agents.ts`
- matching Drizzle migration files
- any agent repository row mapping / insert-update types

Implementation notes:

- Prefer a real column over burying this in generic JSON because this is creator-configured runtime policy, not opaque metadata.
- If the rollout wants stricter safety, make the column non-null with a migration default of `uncovered_or_triggered` for existing agents.
- If a non-null migration is too disruptive, add the column nullable first and resolve null to `uncovered_or_triggered` in API/worker until backfill completes.

### Phase 2: API contract and validation

Extend create, update, and response shapes.

Files:

- `apps/api/src/routes/agents.ts`
- any shared agent API response mappers/tests

Required changes:

- Add `openPositionEscalationToJudgePolicy` to the create schema.
- Add `openPositionEscalationToJudgePolicy` to the update schema.
- Include the field in create persistence and update persistence.
- Include the field in the agent response payload returned to the web app.

Suggested validation:

```ts
z.enum(['never', 'uncovered_or_triggered', 'always'])
```

Implementation note:

- `style` is currently accepted in create but not clearly part of the update schema. Decide whether update should also accept `style` as part of this work, because the frontend persona selector is otherwise only partially end-to-end.

### Phase 3: Worker runtime wiring

Teach the worker to use the per-agent policy when resolving pre-scout escalation.

Files:

- `apps/worker/src/scout-gating.ts`
- `apps/worker/src/agent.ts`
- related worker/runtime tests

Required changes:

- Extend `resolvePreScoutDecision(...)` inputs to accept `openPositionEscalationToJudgePolicy`.
- Replace the current blanket `hasOpenPositions -> escalate` rule with policy-based behavior.
- Keep first tick and judge-scheduled reminders unconditional.

Suggested interim behavior before the full watch redesign lands:

- `always`: current behavior
- `never`: do not force judge for open positions
- `uncovered_or_triggered`: use the best currently available narrow signal surface

Important constraint:

- `uncovered_or_triggered` is only fully correct once structured watch coverage exists. Until then, the implementation should use the narrowest trustworthy proxy available and document that the mode becomes more precise after the watch-system redesign.

### Phase 4: Backend tests

Add focused tests for create, update, response serialization, and worker gating.

API tests:

- create agent with each allowed policy value
- reject invalid policy values
- update agent policy successfully
- agent detail/list payload includes the stored policy

Worker tests:

- `always` + open positions -> forced judge
- `never` + open positions -> scout allowed
- `uncovered_or_triggered` + no actionable signal -> scout allowed
- judge reminder still overrides all policies
- first tick still overrides all policies

## Frontend Plan

### Phase 5: Web API types and payload builders

Files:

- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/agents/agent-payloads.ts`

Required changes:

- Add `openPositionEscalationToJudgePolicy` to the `Agent` type.
- Add it to create payload typing.
- Add it to update payload typing.
- Pass it through the create and edit payload builders.

### Phase 6: Persona default mapping in create flow

Files:

- `apps/web/src/features/agents/style-mapping.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
- possibly a dedicated helper if the mapping should stay isolated from other style defaults

Required changes:

- Extend the style defaults model to include `openPositionEscalationToJudgePolicy`.
- Initialize create-form state from the selected style:
  - `careful` -> `never`
  - `balanced` -> `uncovered_or_triggered`
  - `bold` -> `always`
- When the user changes style in the create flow, update the policy only while the policy has not been manually overridden.

Recommended UI behavior:

- track a local “policy manually changed” flag in form state
- once touched, style changes no longer overwrite the explicit selection

### Phase 7: Edit flow and advanced controls

Files:

- `apps/web/src/features/agents/AgentControlsSection.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/AgentsPage.tsx`

Required changes:

- Add a dedicated control for `openPositionEscalationToJudgePolicy` in advanced trading/runtime controls.
- Render human-readable options, for example:
  - `never` -> “Let scout inspect open positions first”
  - `uncovered_or_triggered` -> “Escalate only when coverage is missing or a watch fires”
  - `always` -> “Always escalate open positions to judge”
- Populate the control from the stored agent value in edit mode.

### Phase 8: Translation and copy updates

Files:

- `apps/web/src/app/i18n/locales/en.ts`
- `apps/web/src/app/i18n/locales/ar.ts`
- `apps/web/src/app/i18n/locales/hi.ts`
- any other supported locale files if present

Required additions:

- label for the new field
- help text for the new field
- option labels/descriptions for the three enum values

`Standard` -> `Balanced` copy review:

- The existing persona label is already `Balanced`.
- The existing cost preset enum/value is still `standard` and appears in user-facing copy such as `agents.controls.costPreset.standard`.

Recommended approach:

- Keep backend `costPreset: 'standard'` unchanged.
- Only change user-facing translation copy from `Standard` to `Balanced` where the intent is to describe the persona tier rather than the internal pricing preset.
- Update the balanced style description copy if needed so it does not conflict with the new explicit persona-policy mapping.

This avoids unnecessary churn in cadence/spend logic that still uses the `standard` preset key.

### Phase 9: Frontend tests

Add focused tests around persona defaults, override behavior, and payload wiring.

Suggested coverage:

- create flow initializes policy from `balanced`
- switching style updates policy before manual override
- manual policy override survives later style changes
- edit modal loads and submits stored policy
- translated labels/options render correctly
- payload builders include `openPositionEscalationToJudgePolicy`

## Suggested File Touch List

Backend:

- `packages/db/src/schema/agents.ts`
- Drizzle migration files
- `apps/api/src/routes/agents.ts`
- `apps/worker/src/scout-gating.ts`
- `apps/worker/src/agent.ts`
- worker/API tests covering agent create/update and scout gating

Frontend:

- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/agents/agent-payloads.ts`
- `apps/web/src/features/agents/style-mapping.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/AgentControlsSection.tsx`
- translation locale files
- related web tests

## Rollout Notes

- Existing agents need a deterministic default. Use `uncovered_or_triggered` unless product wants legacy parity.
- If `uncovered_or_triggered` ships before structured watch coverage is implemented, document that it is an incremental narrowing based on current signals and will become stricter after the watch-system redesign.
- Do not infer runtime behavior from `style` in the worker. Persist the explicit policy and read that field directly.

## Acceptance Criteria

1. Every agent can store an explicit `openPositionEscalationToJudgePolicy`.
2. The API supports create, read, and update for that field.
3. The worker uses that field when deciding whether open positions force judge.
4. Persona defaults map exactly as requested:
   - `careful` -> `never`
   - `balanced` -> `uncovered_or_triggered`
   - `bold` -> `always`
5. Users can override the derived value explicitly in the frontend.
6. Edit flow preserves and updates the explicit stored value.
7. User-facing copy and translations are updated anywhere the old `Standard` wording would conflict with the `Balanced` persona language.

---

## Outstanding Issues

### Phase 1
- ~~MEDIUM~~ RESOLVED in Phase 2: `InsertAgent` and `UpdateAgent` repository interfaces in `packages/db/src/agent-repository.ts` updated with the new field.

### Phase 3
- MEDIUM: Missing test for default policy (no `openPositionEscalationToJudgePolicy` param) with open positions. Default changed from "always escalate" to "allow scout" — a regression test gap.
- MEDIUM: `uncovered_or_triggered` is behaviorally identical to `never` until watch coverage exists. Deferred TODO should reference tracking issue.
- LOW: `source: 'scout'` is ambiguous when positions exist but policy blocks escalation — consider distinct source like `'scout_policy_deferred'`.
- LOW: `as any` cast in invalid policy test — acceptable in test code.
- LOW: `docker-agent-manager.ts` `.call()` pattern for dynamic log level — stylistic, no behavior issue.
- LOW: `JSON.parse(...) as AgentConfig` is unchecked cast — pre-existing pattern, incremental improvement via runtime validation.

### Phase 4
- MEDIUM: PATCH test doesn't verify the response body includes the updated policy field — only checks internal mock state (updateSets).
- MEDIUM: Missing test for PATCH with invalid policy value (only POST path tested).
- MEDIUM: Missing test for default value behavior when field is omitted on create.
- LOW: Misleading payload name 'test-default' in create test — should be 'test-uncovered-or-triggered'.
- LOW: opaque `agentRows` entry named 'agent-refetch' could use a comment.

### Phase 5
- ~~HIGH~~ FIXED: Unsafe `as` cast from `string` to union type in EditAgentModal. Replaced with `normalizeEscalationPolicy()` helper.
- MEDIUM: Missing `openPositionEscalationToJudgePolicy` in create flow wiring (AgentsPage.tsx) — Phase 6 will address.
- MEDIUM: Inconsistent conditional-spread pattern in update builder vs sibling fields (uses `!== undefined` while others use `|| null`). Intentional for PATCH semantics.
- LOW: No tests for new field in payload builders — Phase 9.

### Phase 6
- ~~HIGH~~ FIXED: Missing `policyManuallySetRef` to prevent style changes from overwriting explicit policy selection. Added ref with conditional spread.
- ~~MEDIUM~~ FIXED: Inconsistent initial-state access — now uses `styleDefaults` variable.
- ~~MEDIUM~~ FIXED: Missing policy in review step — added ReviewRow with conditional gating.
- LOW: Hardcoded label in review row — translations come in Phase 8.
- LOW: Raw enum value displayed without human-readable formatting.
- LOW: Policy field has no validateFieldOnBlur wiring — Phase 7 dropdown should add this.
- LOW: `normalizeEscalationPolicy()` called twice in conditional — micro-optimization.

### Phase 7
- MEDIUM: Hardcoded English labels in dropdown — translations come in Phase 8.
- MEDIUM: Hardcoded English label in review step — translations come in Phase 8.
- LOW: Raw enum value displayed in review step (uncovered_or_triggered) — should map to human-readable.
- LOW: `normalizeEscalationPolicy()` called twice in conditional spread — micro-optimization.
- LOW: `as` cast from `string` to union in AgentControlsSection.tsx — practically safe, options are hardcoded.
- LOW: No render test for new dropdown in AgentControlsSection.test.tsx — gap.