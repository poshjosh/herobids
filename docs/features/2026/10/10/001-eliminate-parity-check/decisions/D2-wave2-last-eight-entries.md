# Decision Brief D2 (Wave 2): disposition of the last 8 manifest entries

- **Question:** How should herobids resolve the 8 remaining `mirror-only` manifest
  entries (three `strategy-preset-*` YAMLs, `domain-config-presets-loader`,
  `domain-config-presets`, `domain-config-strategy-parameters`,
  `domain-ports-candle-fetcher` [residual `PriceCandle`], `domain-scanner-types`)
  whose herobids copies are **live** (not dead), when the traderton copies are also
  live and single-owner?
- **Status:** PARTIALLY RATIFIED (2026-10-12) — D2-a ratified (Option 1); D2-b/c/d pending.

## Evidence

Wave 1 (delete `market-assessment.ts`) is done — manifest 9 → 8. The 8 remaining
entries are **not** dead: each herobids copy still has live non-test consumers
(verified 2026-10-12, see
[`plans/D2-herobids-drops-last-manifest-entries.md`](../plans/D2-herobids-drops-last-manifest-entries.md)
§2). The blocking gap is §3 of that plan:

- Traderton's `list_strategy_presets` tool returns a **thin catalog**
  (`{ key, name, description, strategyType, signalBias, behaviorVersion }`); herobids'
  consumers need the **full** `PresetEntry` (`strategy.params`, `risk`, `execution`) to
  derive config (`strategy-preset-resolver.ts` → `applyPresetToAgent`,
  `profile-scan-config.ts:153`, `blueprints.ts:461,467,503`). A blind re-point would
  silently drop `params`/`risk`/`execution` and regress agent-create and blueprint
  preset defaulting — a user-facing behavior change.
- `HybridPricingIdentity` is **already** in `@poshjosh/contracts` (`trading/pricing-identity.ts`),
  but `ScannerCandleTarget`, `SwapExecutionIdentity`, `scannerTargetKey` and `PriceCandle`
  are **not** — they were explicitly deferred in the contracts carve-out plan
  ([`C1-contracts-package-carveout.md`](../plans/C1-contracts-package-carveout.md) §"Deliberately out of scope").
- The contracts charter is "schemas + types only" — moving `applyPresetToAgent`,
  `computePresetBehaviorVersion`, or the strategy-parameters registry would weaken it.

## Options (one disposition per row; each is heavyweight — H3/H4/H5)

**D2-a — Preset catalog + derivation** (`strategy-preset-economy|premium|standard`,
`domain-config-presets-loader`, `domain-config-presets`):

1. Add a **new traderton read tool** returning the full `PresetEntry` (not the thin
   catalog) and re-point herobids' 4 call sites to it. Cost: a traderton milestone +
   pin bump; keeps herobids derivation logic but changes its data source.
2. Move `PresetEntry` + `applyPresetToAgent` + `computePresetBehaviorVersion` into
   `@poshjosh/contracts`. Cost: weakens the "schemas + types only" charter (logic in a
   DTO package).
3. **Retire herobids' local derivation** and rely on `strategyPreset` + `styleTier` as
   creator input that traderton resolves (aligns with Item 5/6 ownership — herobids
   never derives `active_strategy`). Cost: must confirm preset-defaulting UX is preserved.
   *(Plan's default leaning.)*

**D2-b — `scanner-types.ts`** (`HybridPricingIdentity` already in contracts +
`ScannerCandleTarget`, `SwapExecutionIdentity`, `scannerTargetKey`):

1. Add the three missing shapes to contracts (they are wire-ish). *(Plan's default leaning.)*
2. Keep `SwapExecutionIdentity`/`ScannerCandleTarget` herobids-local and reclassify the
   manifest entry to only the shared `HybridPricingIdentity` region.

**D2-c — `PriceCandle`** (`domain-ports-candle-fetcher` residual):

1. Add to contracts (plain wire shape). *(Plan's default leaning.)*
2. Keep herobids-local, reclassify the entry.

**D2-d — `strategy-parameters.ts` registry** (`domain-config-strategy-parameters`):

1. Move to contracts (likely wrong home — it is herobids config-validation logic, not a
   wire DTO).
2. Retire herobids' local strategy/decision-mode validation vs delegate to traderton.
3. Keep herobids-local, reclassify the entry (may require narrowing to a genuinely-shared
   sub-region). *(Plan's default leaning; needs a reader of `config/schema.ts` validation.)*

## Recommendation

Adopt the plan's default leanings — **D2-a: option 3, D2-b: option 1, D2-c: option 1,
D2-d: option 3** — **provided** you confirm two things: (a) the preset-defaulting UX is
preserved under D2-a option 3, and (b) a reader of `config/schema.ts` confirms the
strategy-parameters registry has a genuinely-shared sub-region to narrow D2-d to.

D2-a option 3 is the only row that changes user-facing flows (it retires herobids'
derivation in favour of `strategyPreset` + `styleTier` as creator input resolved by
traderton), so it is the one I would not proceed on without your explicit sign-off on the
UX.

## What this blocks

- **Wave 2** (the remaining 8 manifest entries) — none may be dropped before these
  dispositions are ratified.
- **C6** (delete the checker/manifest/test/CI job) — blocked until the manifest has zero
  entries.

## Decision

- **D2-a — Option 1 RATIFIED (human, 2026-10-12).** Add a new traderton read tool that
  returns the full `PresetEntry` (not the thin catalog) and re-point herobids' 4 call
  sites (`strategy-preset-resolver.ts`, `profile-scan-config.ts:153`,
  `blueprints.ts:461,467,503`) to it. Herobids keeps its `applyPresetToAgent` /
  `computePresetBehaviorVersion` / `agentStyleToPresetStyle` derivation logic; only the
  YAML data source moves to traderton. Rationale (human): simplest, no UX change to
  create/blueprint flows, no logic moved into the contracts package.
- **D2-b, D2-c, D2-d — pending** (human to confirm one option per row).