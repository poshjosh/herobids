# Decision Brief D2-a (herobids half): disposition of `domain-config-presets`

- **Question:** Option 1 (ratified) moves the preset **YAML data source** to traderton
  via a new `get_strategy_presets` read tool, and keeps herobids' derivation logic
  (`applyPresetToAgent` / `computePresetBehaviorVersion` / `agentStyleToPresetStyle`).
  That cleanly drops the three `strategy-preset-*` YAML entries and
  `domain-config-presets-loader` (the loader becomes boundary-backed). But the fifth
  entry — `domain-config-presets` (`packages/domain/src/config/presets.ts`) — now has a
  **wire shape** inside it (`PresetEntry` / `PresetEntrySchema` cross the boundary in the
  new tool's response), so it no longer cleanly meets the disposition-6 "no wire
  exposure" bar. How should that entry be resolved?
- **Status:** RATIFIED (2026-10-12) — Option 1.

## Evidence

- `presets.ts` (byte-identical in both repos, verified 2026-10-12) contains **both** the
  wire/type surface and the derivation logic:
  - Wire/type: `PresetEntrySchema`, `PresetFileSchema`, `PresetEntry`, `StyleKey`,
    `isStyleKey`, `agentStyleToPresetStyle`.
  - Derivation (herobids-local per Option 1): `applyPresetToAgent`,
    `computePresetBehaviorVersion`, `extractBehaviorFields`, `AGENT_TECHNICAL_STRATEGY_TYPES`,
    `AgentPresetMapping`, `AgentTechnicalStrategyType`.
- The new `get_strategy_presets` tool returns the full `PresetEntry` over the wire, so
  herobids must validate the response against a `PresetEntrySchema`. That schema is now a
  **wire contract**, not a coincidentally-identical utility.
- Precedent: `agent-risk-defaults` (B4) dropped its entry even though
  `AgentRiskDefaultsSchema` crosses the wire in `get_operator_defaults` — but there the
  schema lived in the un-mirrored `config/schema.ts`, not a dedicated mirrored file.

## Options

1. **Move the wire/type surface to `@poshjosh/contracts`** (`PresetEntrySchema`,
   `PresetEntry`, `StyleKey`, `isStyleKey`, `agentStyleToPresetStyle`); keep the
   derivation (`applyPresetToAgent`, `computePresetBehaviorVersion`, `extractBehaviorFields`)
   herobids-local. Traderton's `presets.ts` re-points its schema to the package too.
   - Cost: a new contracts shape group (v0.3.0) + a herobids/traderton re-point. This is
     the "schemas + types only" charter's natural home for a wire shape.
   - Reversibility: high.
2. **Retire the obligation (disposition 6) for `presets.ts`.** Herobids keeps its whole
   `presets.ts` (schema + derivation) as a local validation shape; traderton keeps its
   whole copy; the entry is dropped. The boundary read is validated fail-closed against
   herobids' local `PresetEntrySchema`.
   - Cost: the schema is now a wire contract that is *not* pinned — drift between the two
     `PresetEntrySchema` copies would surface only as a runtime validation failure, not a
     CI failure. This is the same residual risk the `agent-risk-defaults` drop accepted.
   - Reversibility: high (re-add the entry or move to contracts later).
3. **Keep the entry mirrored** (narrow to the schema sub-region). Defeats the epic's
   purpose; not recommended.

## Recommendation

**Option 1** — move the wire/type surface to `@poshjosh/contracts`. It is the correct
home for a shape that now crosses the wire, keeps the contracts charter intact, and
removes the last mirror cleanly. Option 2 is acceptable if you want to avoid another
contracts bump and accept the fail-closed-only drift guard (matching the
`agent-risk-defaults` precedent).

## What this blocks

- The herobids half of D2-a (drop the last 5 entries), the herobids release, traderton
  dedupe, and C6.

## Decision

**Option 1 RATIFIED (human, 2026-10-12).** Move the wire/type surface
(`PresetEntrySchema`, `PresetFileSchema`, `PresetEntry`, `StyleKey`, `isStyleKey`,
`agentStyleToPresetStyle`) to `@poshjosh/contracts` (v0.3.0); keep the derivation
(`applyPresetToAgent`, `computePresetBehaviorVersion`, `extractBehaviorFields`,
`AGENT_TECHNICAL_STRATEGY_TYPES`, `AgentPresetMapping`, `AgentTechnicalStrategyType`)
local in each repo's `presets.ts`. The `domain-config-presets` entry is then dropped
(disposition 6 for the now-in-process-only derivation).