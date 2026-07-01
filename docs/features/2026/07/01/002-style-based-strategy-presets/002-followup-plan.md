# Follow-Up Plan: Complete Style-Based Strategy Presets

**Status:** Follow-up needed after partial implementation  
**Date:** 2026-07-01  
**Depends on:** `001-plan.md` in this folder  
**Scope:** finish the unfinished parts of style-based strategy presets without reworking the parts that already landed

---

## Why This Follow-Up Exists

The original plan in `001-plan.md` was only partially completed.

Implemented already:
- percent-of-equity sizing for `MechanicalStrategy`
- economy/standard/premium YAML preset files
- backend preset loader and preset API routes
- bot creation UI fetching presets from the backend
- migration of legacy blueprint and bot config JSONB

Not fully implemented yet:
- DCA still behaves as fixed-amount at runtime even though preset YAML now uses `amountPerBuyMode: percent_equity`
- agent creation/edit flows still use the older hardcoded `TECHNICAL_PRESETS` path instead of the new style-based strategy preset system
- the agent preset split contract does not line up with the current unified agent execution schema
- the agent preset split path does not currently guard against unsupported `dca` usage
- schema/docs/tests around the new agent and DCA behavior are incomplete

This follow-up plan finishes only the missing slices. It does not re-plan the bot/blueprint preset work that is already in place.

---

## Current State Summary

### Done

- `config/strategy-presets/{economy,standard,premium}.yaml` exists and is style-differentiated.
- `packages/domain/src/config/presets.ts` exists with loader, style mapping, and `applyPresetToAgent()`.
- `apps/api/src/routes/blueprints.ts` serves presets and exposes `/presets/for-agent`.
- `apps/web/src/features/bots/BotsPage.tsx` fetches preset data from the backend.
- `packages/db/drizzle/0029_migrate_blueprint_config_pct.sql` migrates legacy bot/blueprint config.

### Still Wrong or Incomplete

- `packages/strategy/src/dca-strategy.ts` still treats `amountPerBuy` as a fixed quantity and ignores percent-of-equity semantics.
- `apps/web/src/features/agents/technical-presets.ts` and related helpers still define a separate hardcoded agent preset system.
- `apps/web/src/features/agents/TechnicalConfigSection.tsx` still renders those old hardcoded presets as the agent preset UX.
- `apps/api/src/routes/agents.ts` does not accept a style-based strategy preset input and does not resolve presets into agent config on write.
- `packages/domain/src/config/presets.ts` returns `execution.positionSize`, but `UnifiedAgentConfigSchema` expects `execution.fixedPositionSize`.
- `/presets/for-agent` currently allows any strategy key even though `dca` is not a meaningful agent technical preset.
- Public schema/docs for DCA still describe fixed amount semantics.

---

## Goals

1. Finish DCA percent-of-equity runtime parity so the preset YAML matches actual behavior.
2. Make style-based strategy presets usable in agent create and edit flows.
3. Keep the backend as the source of truth for preset resolution and style mapping.
4. Remove or demote the older hardcoded agent technical preset path so the product does not expose two competing preset systems.
5. Bring tests, API contract, and docs into alignment with the final behavior.

---

## Non-Goals

This follow-up does not include:
- scalper-only time restrictions
- ICT swing-checklist derived settings
- exit-policy enhancements
- sentiment adapter work
- subscription-plan-specific preset variations
- redesign of the broader agent technical editor beyond what is needed to integrate preset selection

Those belong in separate plans.

---

## Guiding Decisions

### 1. Backend remains the source of truth

Preset loading, style-tier mapping, and preset-to-agent translation must happen in backend/domain code. The web app may preview presets, but the agent write path must not depend on frontend-only mapping logic.

### 2. Agent preset selection is a write-time API concern, not just a UI concern

The API should accept a preset key for agent create/update, derive the style tier from the agent's style, resolve the preset, and persist the translated technical/risk/execution values.

### 3. DCA is bot-only for this preset system

`dca` should remain valid for bots and blueprints, but it should not be selectable for agent technical preset application unless a separate product design is approved. The current `applyPresetToAgent()` contract already hints that DCA is not meaningful for agents. The implementation should make that explicit.

### 4. Preserve advanced editing as a fallback

The first pass should not remove the ability to customize agent technical config manually. The style-based preset path should become the primary happy path, while the detailed editor remains available for custom overrides.

---

## Phase 0: Contract Correction Before UI Work

### Problem

The current domain split helper does not cleanly match the agent config shape:
- preset split returns `execution.positionSize`
- agent unified config expects `execution.fixedPositionSize`

That mismatch will cause drift or ad hoc translation if not corrected first.

### Files

- `packages/domain/src/config/presets.ts`
- `packages/domain/src/config/presets.test.ts`
- `packages/domain/src/config/schema.ts`
- `apps/api/src/routes/blueprints.ts`

### Tasks

1. Replace the agent preset execution mapping shape with the actual unified agent execution shape.
2. Decide one canonical agent execution field name and use it consistently.
   - Recommended: keep `UnifiedAgentConfigSchema` as the source of truth and translate preset `positionSize` into `fixedPositionSize` for agent config.
3. Tighten `applyPresetToAgent()` typing so it returns values that can be persisted directly into `unifiedConfig` without a second ad hoc rename step.
4. Reject `dca` in the agent preset split helper or at the API boundary with a clear validation error such as `preset_not_supported_for_agent`.
5. Add tests covering:
   - technical strategy preset split uses the persisted agent field names
   - `dca` is rejected for agent preset application

### Acceptance Criteria

- Agent preset split output matches `UnifiedAgentConfigSchema` exactly.
- There is one clear place where preset `positionSize` becomes agent execution config.
- Agent preset split cannot silently produce meaningless DCA technical config.

---

## Phase 1: Finish DCA Runtime Parity

### Problem

Preset YAML declares percent-based DCA sizing, but runtime still interprets DCA amounts as fixed values.

### Files

- `packages/strategy/src/dca-strategy.ts`
- `packages/strategy/src/dca-strategy.test.ts`
- `apps/worker/src/trading-actor.ts`
- `apps/api/src/routes/strategy-schemas.ts`
- `packages/domain/src/tool-schemas.ts`

### Tasks

1. Extend `DcaParamsSchema` with:
   - `amountPerBuyMode: z.enum(['fixed', 'percent_equity']).default('fixed')`
2. Add a `resolveDcaAmount()` helper mirroring the mechanical strategy pattern.
3. Use `snapshot.data.accountEquity` when `amountPerBuyMode === 'percent_equity'`.
4. Return `'0'` and skip effective trade sizing when equity is missing, non-positive, or the computed amount is too small.
5. Verify that `TradingActor` already supplies `accountEquity` to all strategy evaluations. If not, wire it for DCA as well.
6. Update the public DCA schema/docs so they no longer describe fixed-only sizing.

### Tests

Add unit tests for:
- percent-equity DCA sizing with valid equity
- missing equity returns zero-size decision or no-op, depending on the chosen DCA contract
- fixed mode remains unchanged
- invalid `amountPerBuy` still fails validation

### Acceptance Criteria

- DCA presets using `amountPerBuyMode: percent_equity` behave correctly at runtime.
- Public DCA schema/docs match the implementation.

---

## Phase 2: Add Preset-Aware Agent API Writes

### Problem

The preset read path exists, but agent create/update writes still accept only raw technical config and manual risk fields.

### Files

- `apps/api/src/routes/agents.ts`
- `packages/domain/src/config/presets.ts`
- `packages/domain/src/config/index.ts`
- `apps/api/src/routes/agents.test.ts`

### Recommended API Shape

Add an optional agent write field that represents the selected preset key.

Recommended field name:

```typescript
strategyPreset: z.enum([
  'momentum',
  'momentum-position',
  'range',
  'swing',
  'scalper',
  'contrarian',
]).optional()
```

Do not include `dca` here.

### Create Path Tasks

1. Extend `CreateAgentSchema` with optional `strategyPreset`.
2. If `strategyPreset` is present:
   - require `style` or fall back explicitly to `balanced`
   - map `style` via `agentStyleToPresetStyle()`
   - resolve preset via `getPreset()`
   - translate preset via corrected `applyPresetToAgent()`
   - persist translated technical config into `unifiedConfig.technical`
   - persist translated execution config into `unifiedConfig.execution`
   - persist translated risk fields into the appropriate agent DB columns unless explicitly overridden in the request
3. Preserve explicit user-supplied risk overrides as higher priority than preset defaults.
4. Reject invalid combinations, for example:
   - `strategyPreset` set to unsupported value
   - `strategyPreset` set to `dca`
   - preset missing from YAML for resolved style

### Update Path Tasks

1. Extend `UpdateAgentSchema` with optional `strategyPreset`.
2. On PATCH, support three cases:
   - omitted: leave existing preset-derived config unchanged
   - provided with value: re-apply preset using the effective style after merge
   - explicitly cleared if supported by the product decision: remove preset-managed config and keep manual config only
3. Define merge precedence clearly:
   - explicit PATCH fields win over preset defaults
   - preset defaults win over empty/null existing agent config where appropriate
4. Ensure stopping/running edit rules stay unchanged.

### Important Merge Rule

Preset application must be deterministic and partial-safe. Do not wipe unrelated `unifiedConfig` keys.

### Acceptance Criteria

- Agent create/update routes can accept a preset key and persist the translated configuration.
- Style tier is derived server-side from agent style.
- Explicit user risk overrides are not silently overwritten by preset defaults.

---

## Phase 3: Replace the Old Agent Hardcoded Preset UX

### Problem

The web agent flow still uses the older hardcoded `TECHNICAL_PRESETS` system. That creates a second preset universe unrelated to the new YAML presets.

### Files

- `apps/web/src/features/agents/TechnicalConfigSection.tsx`
- `apps/web/src/features/agents/technical-presets.ts`
- `apps/web/src/features/agents/technical-config-helpers.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/agent-payloads.ts`
- `apps/web/src/lib/api-client.ts`
- relevant tests under `apps/web/src/features/agents/`

### Recommended UX

1. For trading-capable agents, add a new primary selector labeled `Strategy preset` that lists:
   - Momentum — Day
   - Momentum — Position
   - Range Trading
   - Swing
   - Scalper
   - Contrarian
2. Show a note that style tier is derived automatically from the agent style (`careful`, `balanced`, `bold`).
3. Exclude DCA from this selector.
4. Preserve the detailed technical editor as an advanced/custom mode.
5. If the user switches to custom editing after preset selection, decide whether the form should:
   - remain linked to the preset until fields diverge, or
   - immediately become `custom`

Recommended first pass: switch to `custom` on first manual divergence.

### Tasks

1. Add API client support for agent preset preview if the UI needs read-only preview cards.
   - This can use `/presets/for-agent` or a refined endpoint if Phase 0 changes it.
2. Add `strategyPreset` into the agent form state and payload builders.
3. Update create flow to submit `strategyPreset` instead of only a raw hardcoded technical preset patch.
4. Update edit flow to read and write the same field.
5. Demote or remove `TECHNICAL_PRESETS` from the primary path.
   - Recommended: keep only `custom` helper behavior or replace the file entirely after migration.
6. Make preset cards read from backend data, not duplicated frontend constants.

### Acceptance Criteria

- Agent create flow uses the style-based preset system.
- Agent edit flow can display and update preset-managed agents.
- The old hardcoded agent preset set is no longer the default path.

---

## Phase 4: Read/Write Round-Trip and Editing Semantics

### Problem

Once presets are persisted into agent config, the UI must be able to re-open an existing agent and present a stable editing model.

### Files

- `apps/api/src/routes/agents.ts`
- `apps/web/src/features/agents/agent-form-state.ts`
- `apps/web/src/features/agents/technical-config-helpers.ts`
- `apps/web/src/features/agents/EditAgentModal.tsx`

### Tasks

1. Decide how preset provenance is represented.

Recommended approach:
- persist a lightweight preset marker in agent config metadata or a dedicated field so the UI can distinguish:
  - preset-managed config
  - custom config

Possible shapes:

```typescript
unifiedConfig: {
  technical: { ... },
  execution: { ... },
  metadata: {
    strategyPreset: 'momentum',
    strategyPresetStyle: 'standard',
    strategyPresetSource: 'agent-style'
  }
}
```

or a top-level DB column if later justified.

Recommended first pass: keep this metadata inside `unifiedConfig` to avoid an immediate schema migration unless product reporting requires a dedicated column.

2. On GET, expose enough data for the frontend to know whether the agent was preset-driven.
3. On edit open, hydrate form state consistently:
   - if preset metadata exists, show the matching preset card selected
   - if config no longer matches a known preset, fall back to `custom`
4. Define how manual edits affect preset status.

### Acceptance Criteria

- Preset-managed agents reopen predictably in the edit UI.
- Manual divergence is handled explicitly rather than silently.

---

## Phase 5: Cleanup of Old Surfaces and Stale Schema Documentation

### Problem

Even after the new write path is added, stale docs and schema descriptions will keep generating wrong payloads.

### Files

- `apps/api/src/routes/strategy-schemas.ts`
- `packages/domain/src/tool-schemas.ts`
- agent form labels/help text in the web app
- any docs referencing fixed-only DCA sizing or the older agent technical preset list

### Tasks

1. Update DCA schema descriptions to mention `amountPerBuyMode` and percent-equity support.
2. Update any tool schemas or developer-facing schema docs that still imply fixed-only DCA values.
3. Update agent-facing copy so users understand:
   - preset choice selects strategy identity
   - agent style selects economy/standard/premium tier
   - custom editing can override preset defaults
4. Remove stale references to the old frontend-only technical preset system where it is no longer user-facing.

### Acceptance Criteria

- API and tool schema descriptions no longer contradict the runtime.
- User-facing preset copy matches the actual product behavior.

---

## Phase 6: Tests

### Domain / Strategy Tests

- `packages/strategy/src/dca-strategy.test.ts`
  - percent-equity DCA sizing
  - fixed mode unchanged
  - missing equity behavior
- `packages/domain/src/config/presets.test.ts`
  - corrected execution mapping shape
  - `dca` rejected for agent preset split

### API Tests

- `apps/api/src/routes/blueprints.test.ts`
  - add `/presets/for-agent` success case for a technical strategy
  - add `/presets/for-agent` rejection for `dca`
- `apps/api/src/routes/agents.test.ts`
  - POST `/agents` with `strategyPreset + style` persists translated technical/risk/execution config
  - PATCH `/agents/:id` can re-apply preset when style changes
  - explicit risk overrides beat preset defaults
  - preset-managed agent edit does not wipe unrelated config keys

### Web Tests

- create-flow test for preset selection submission
- edit-flow test for round-trip hydration of preset-managed agents
- custom divergence test switches the form to `custom`

### End-to-End Validation

1. Create a `careful` agent with `strategyPreset = momentum`.
2. Verify API persists economy-tier translated config.
3. Edit the agent to `bold` and confirm premium-tier translated values are applied.
4. Create a bot from the same preset/style and confirm bot config still reflects the direct mechanical preset.
5. Validate DCA bot with percent-equity sizing using account equity in snapshot.

---

## Implementation Order

1. Phase 0: fix contract mismatch and DCA-for-agent rejection.
2. Phase 1: finish DCA runtime parity.
3. Phase 2: add preset-aware agent API writes.
4. Phase 3: switch agent create/edit UI to the preset-aware path.
5. Phase 4: add edit round-trip metadata and semantics.
6. Phase 5: clean up stale schema/docs.
7. Phase 6: run targeted tests, then `pnpm lint`, then broader test pass.

---

## Risks and Mitigations

### Risk: preset application overwrites user customizations

Mitigation:
- define precedence explicitly
- only apply preset defaults to the fields the preset owns
- preserve explicit overrides

### Risk: agent edit UI cannot tell preset-managed from custom config

Mitigation:
- persist lightweight preset provenance metadata
- treat unknown/mutated configs as `custom`

### Risk: DCA contract differs from mechanical contract on zero-size behavior

Mitigation:
- define the DCA behavior explicitly in tests before implementation
- prefer the same loud-failure semantics as mechanical percent-equity sizing

### Risk: frontend duplicates style mapping again

Mitigation:
- resolve style tier server-side in `/agents` create/update paths
- keep frontend mapping for display only, not persistence

---

## Open Questions

These are not blocking for drafting this plan, but they should be answered before implementation starts:

1. Should preset-managed agent config persist provenance metadata inside `unifiedConfig`, or do we want a dedicated DB column for reporting/filtering?
2. When a user manually edits a preset-managed agent, should the UI immediately mark it `custom`, or should it keep a soft link to the original preset until save?
3. Should `/presets/for-agent` remain as a UI preview endpoint once `/agents` create/update can resolve presets directly, or should it be treated as internal-only and possibly removed later?

Recommended defaults for this follow-up:
- keep provenance metadata inside `unifiedConfig`
- switch to `custom` on first manual divergence
- keep `/presets/for-agent` as a read-only preview endpoint

---

## Final Acceptance Criteria

This follow-up is complete when all of the following are true:

1. DCA percent-equity presets work at runtime.
2. Agent create/update can accept a style-based strategy preset and resolve it server-side.
3. The agent preset path excludes unsupported `dca` usage.
4. The agent preset split output matches the unified agent schema.
5. The web agent flow uses backend-driven style-based strategy presets as the primary path.
6. Existing bot/blueprint preset behavior remains unchanged.
7. Public schema/docs do not describe stale fixed-only DCA behavior.
8. `pnpm lint` passes and targeted API/web/strategy tests cover the new behavior.