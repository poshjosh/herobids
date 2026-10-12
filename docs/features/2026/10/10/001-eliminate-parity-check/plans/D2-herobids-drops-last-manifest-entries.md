# D2 — Herobids drops the last 9 manifest entries

**Milestone:** M-D (Track D). **Status:** blocked → part-unblocked by this doc. This is the
execution handoff for a fresh agent with no prior context. Read
[`000-roadmap.md`](../000-roadmap.md) "If you are an executing agent: start here" first, then
this file, then [`invariants-and-quality-gates.md`](../invariants-and-quality-gates.md)
(I1–I15, GP-H, GP-T, the floor §3.1).

---

## 0. Where we are (state as of 2026-10-12)

- **Strategic objective:** eliminate the parity-drift check entirely — delete
  `scripts/parity-drift-manifest.json`, `scripts/check-parity-drift.mjs` (+ test) and the
  `parity-drift` CI job from **both** repos, by resolving the duplication behind every
  manifest entry (delete dead copies, re-point logic to the traderton boundary or a shared
  `@poshjosh/contracts` package, or retire the obligation). Done when the manifest has
  **zero entries**, then C6 removes the checker/manifest/test/CI job.
- **Tracks A, B, C are done.** Manifest went 35 → 17 → 9.
- **Item 4** (Wave E herobids halves) merged; **Item 5** (preset assessment → traderton,
  data-only) merged (traderton `4de0b99`). **Item 6** (herobids H1–H6) merged (herobids
  `88e67c98`), including the destructive drop of the 10 assessment/scan tables
  (migration `0074_supreme_human_torch.sql`).
- **Released:** traderton **`v0.1.4`**, herobids **`v0.6.11`** (both tagged + pushed).
- **Both working trees clean at start of D2.**

The **9 remaining manifest entries** are all the Track-D set. They are **not dead** — nearly
every one still has live non-test consumers in herobids (see §2). This was discovered by
investigation, not assumed.

---

## 1. Why this is not a `git rm`

The D2 note in the roadmap says herobids' preset files "go with H5 itself". H5's plan
qualified this with *"removed only when no consumer is left"*. The re-pointing step that H5
deferred — *"read from Traderton `list_strategy_presets`"* — was **never done**, and
investigation shows it cannot be done naively (see §3 gap). So D2 is split into two waves:

- **Wave 1 (autonomous, herobids-only):** delete the one genuinely-dead file
  (`market-assessment.ts`) and drop its single entry.
- **Wave 2 (cross-repo, needs a heavyweight decision first):** resolve the 8 live files.

Wave 2 **must not be started autonomously** — its first step is surfacing §5's decision to the
human (a heavyweight path per the decision framework), because it changes user-facing agent
/blueprint creation flows and/or moves logic into a package whose charter is "schemas + types
only".

---

## 2. The 9 entries and their herobids consumers (verified 2026-10-12)

Each entry is `authority: mirror-only`. For every one, the traderton side is **live and
stays** (single-owner after the mirror obligation is retired); only the **herobids** side is
deleted or re-pointed. Dropping an entry ends the mirror obligation for both sides.

| # | Entry id | Herobids path | Live herobids consumers (non-test) | Resolution path |
|---|---|---|---|---|
| 1 | `strategy-preset-economy` | `config/strategy-presets/economy.yaml` | `presets-loader.ts` (`STYLE_FILES` → `loadPresets()`) | Wave 2 / D2-a |
| 2 | `strategy-preset-premium` | `config/strategy-presets/premium.yaml` | same | Wave 2 / D2-a |
| 3 | `strategy-preset-standard` | `config/strategy-presets/standard.yaml` | same | Wave 2 / D2-a |
| 4 | `domain-config-presets-loader` | `packages/domain/src/config/presets-loader.ts` | `apps/api/src/agents/profile-scan-config.ts:12`, `apps/api/src/agents/strategy-preset-resolver.ts:2`, `apps/api/src/routes/blueprints.ts:46` | Wave 2 / D2-a |
| 5 | `domain-config-presets` | `packages/domain/src/config/presets.ts` | `presets-loader.ts:3` (`PresetFileSchema`/`PresetEntry`/`StyleKey`); `config/index.ts:7,10`; `strategy-preset-resolver.ts:1` + `profile-scan-config.ts:2,3` (`applyPresetToAgent`, `agentStyleToPresetStyle`, `computePresetBehaviorVersion`) | Wave 2 / D2-a |
| 6 | `domain-config-strategy-parameters` | `packages/domain/src/config/strategy-parameters.ts` | `config/schema.ts:6-10` (`initStrategyRegistry`, `registerAgentDecisionModes`, `getStrategyParameters`, `validateStrategyParams`); `config/index.ts:124-129` | Wave 2 / D2-d |
| 7 | `domain-market-assessment` | `packages/domain/src/market-assessment.ts` | `index.ts:41` barrel (`export *`); only non-test code consumer left is a **test** import (`tick-gates.test.ts:2` imports `RegimeResult` from `@herobids/domain`) | **Wave 1 — delete** |
| 8 | `domain-ports-candle-fetcher` | `packages/domain/src/ports/candle-fetcher.ts` (now only `PriceCandle` after A3) | `apps/worker/src/tick-gates.ts:3` imports `PriceCandle` from `@herobids/domain`; `market-assessment.ts:4,1047,1059` (removed with Wave 1); `ports/index.ts:1` barrel | Wave 2 / D2-c |
| 9 | `domain-scanner-types` | `packages/domain/src/scanner-types.ts` | `apps/worker/src/runtime-composition.ts:1` imports `HybridPricingIdentity`, `SwapExecutionIdentity`; `index.ts:40` barrel | Wave 2 / D2-b |

Notes confirmed by investigation:

- **`HybridPricingIdentity` already lives in contracts** (`trading/pricing-identity.ts`) —
  runtime-composition can re-point it with no contract change (§4 table shows the current
  contracts surface).
- `ScannerCandleTarget`, `SwapExecutionIdentity`, `scannerTargetKey` are **not** yet in
  contracts; they remain live in traderton (`domain/scanner-types.ts`) and herobids
  (`runtime-composition.ts:1,26`).
- `PriceCandle` is **not** yet in contracts; traderton's is `ports/candle-fetcher.ts`, still
  live (`boundary/bin.ts`, `boundary/preset-assessment-ops.ts`, `worker/tools/strategy.ts`).
- `RegimeResult` in herobids `market-assessment.ts` has already been superseded in all real
  code by `@poshjosh/contracts` (see C3.5); only `tick-gates.test.ts` still pulls it from the
  herobids barrel.

---

## 3. The blocking gap (why Wave 2 needs a decision)

H5's intended resolution was *"re-point preset consumers to traderton
`list_strategy_presets`"*. That tool (`traderton/packages/worker/src/tools/preset-assessment.ts:25-65`)
returns a **thin catalog**:

```
{ key, name, description, strategyType, signalBias, behaviorVersion }
```

Herobids' consumers need the **full preset definition** to derive config:

- `strategy-preset-resolver.ts` → `applyPresetToAgent(...)` needs `strategy.params`,
  `risk`, `execution` (full `PresetEntry`).
- `profile-scan-config.ts:153` → `applyPresetToAgent(...).technical` (params).
- `blueprints.ts:461,467,503` → `listPresets` / `getPreset` full entries.

So a blind re-point would silently drop `params`/`risk`/`execution` and regress agent-create and
blueprint preset defaulting. That is a user-facing behavior change, hence the heavyweight decision
in §5.

---

## 4. Current `@poshjosh/contracts` surface (for Wave 2 planning)

`packages/contracts/src/index.ts` re-exports: watch, watch-purpose, scan-state,
pricing-identity (`HybridPricingIdentity`), wake, risk-overrides, assessment/identity
(`MarketAssessmentIdentity`+Schema), assessment/regime (`RegimeResult`), assessment/evidence
(`EvidenceValue`, `VolatilityEvidence`).

**Missing for Wave 2:** `PriceCandle`, `ScannerCandleTarget`, `SwapExecutionIdentity`,
`scannerTargetKey`, `PresetEntry`/`PresetEntrySchema`, `applyPresetToAgent`,
`computePresetBehaviorVersion`, `agentStyleToPresetStyle`/`isStyleKey`, the strategy-parameters
registry. The contracts charter (see
[`decisions/wire-dto-package-mechanics.md`](../decisions/wire-dto-package-mechanics.md) and
[`plans/C1-contracts-package-carveout.md`](../plans/C1-contracts-package-carveout.md) §"Deliberately out
of scope") explicitly lists `ScannerCandleTarget`, `SwapExecutionIdentity`, and `PriceCandle` as
deferred — that is the range of a new decision, not a silent expansion.

---

## 5. Decisions required before Wave 2 (heavyweight — surface to the human, do not self-decide)

These are one-time disposition choices. The executing agent must **stop and ask the human** at this
point; each is a heavyweight decision (the "retire the obligation" and "move logic into contracts"
options trip the checklist).

| ID | Question | Options | Default leaning (record, don't act) |
|---|---|---|---|
| **D2-a** | Preset catalog + derivation (`PresetEntry`, `applyPresetToAgent`, `computePresetBehaviorVersion`, presets-loader, 3 YAMLs) | (i) add a **new traderton read tool** returning full `PresetEntry` (not the thin catalog) and re-point herobids' 4 call sites; (ii) move these into `@poshjosh/contracts` (weakens "schemas+types only" charter); (iii) retire herobids' local derivation and rely on `strategyPreset`+`styleTier` as creator input that traderton resolves (aligns with Item 5/6 ownership rule — herobids never derives `active_strategy`) | (iii) — matches the ownership direction, but must confirm preset defaulting UX is preserved |
| **D2-b** | `scanner-types.ts` — `HybridPricingIdentity` (already in contracts), `ScannerCandleTarget`, `SwapExecutionIdentity`, `scannerTargetKey` | (i) add the missing three to contracts (they are wire-ish shapes); (ii) keep `SwapExecutionIdentity`/`ScannerCandleTarget` herobids-local, reclassify the manifest entry to only the shared `HybridPricingIdentity` region | (i) |
| **D2-c** | `PriceCandle` | (i) add to contracts (`trading/` or `assessment/`); (ii) keep herobids-local, reclassify | (i) — it is a plain wire shape |
| **D2-d** | `strategy-parameters.ts` registry | (i) move to contracts (it is herobids config-validation logic, not a wire DTO — likely wrong home); (ii) retire herobids' local strategy/decision-mode validation vs delegate to traderton; (iii) keep herobids-local, reclassify entry (may require narrowing the manifest to a genuinely-shared sub-region) | (iii) lean, but needs a reader of `config/schema.ts` validation |

**Once the human picks one option per row**, record the result in
[`EXECUTION_LEDGER.md`](../EXECUTION_LEDGER.md) (a "disposition" entry, mirror of the B1.2 /
G2 records), then execute Wave 2 sub-steps in order.

---

## 6. Wave 1 — autonomous, do now (herobids only)

Only entry 7 (`domain-market-assessment`) is dead. Execute exactly:

1. **Re-home the residue before deleting** (I6 step 1): the only non-test reference is
   `tick-gates.test.ts:2` importing `RegimeResult` from `@herobids/domain`. Re-point that import
   to `@poshjosh/contracts` (already consumed by `tick-gates.ts` itself).
2. **Trial-delete** `packages/domain/src/market-assessment.ts` + its test
   `packages/domain/src/market-assessment.test.ts`; prune `packages/domain/src/index.ts:41`
   (`export * from './market-assessment.js'`) (I7).
3. **Rebuild domain first** (roadmap gotcha 1): `pnpm --filter @herobids/domain run build`, then
   `pnpm lint`, then per-app `tsc` (worker/api/domain) + `pnpm --filter @herobids/web run typecheck`.
   Confirm all green.
4. **Full suite from clean env** (I13): `env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run`
   (the I6 closer). Also run `pnpm test:slow` (herobids local default vs sibling working tree).
5. **Drop the entry** `domain-market-assessment` from `scripts/parity-drift-manifest.json` **and**
   remove its id from `REQUIRED_ENTRY_IDS` **and** `REQUIRED_ENTRY_AUTHORITIES` in
   `scripts/check-parity-drift.mjs` (I1). **Same change.**
6. **Retarget/update** `scripts/check-parity-drift.test.mjs` (I2): the
   "rejects altered required authority classifications" test names `domain-market-assessment` at
   line 53 — retarget to an id that survives Wave 1 (e.g. `domain-config-presets`), and update the
   mirror-only-id fixture if needed.
7. **GP-H gates** (§3.2 of invariants): manifest entry count == 8;
   `node --test scripts/check-parity-drift.test.mjs` passes; both herobids recipes in §2 of the
   invariants doc pass; I6 grep returns zero references to `market-assessment.ts`;
   `git diff --check` clean.
8. **CHANGELOG** `## [Unreleased]` → `### Removed` line; **ledger** entry (starting SHAs, commit,
   validation, next item). **STOP.** Report and wait before Wave 2.

---

## 7. Wave 2 — after the §5 decision (cross-repo, ordered)

Follow the same additive-then-swap-then-dedupe + release ordering as Track C (see
[`plans/C1-contracts-package-carveout.md`](../plans/C1-contracts-package-carveout.md) and
[`plans/C3-herobids-consumes-contracts.md`](../plans/C3-herobids-consumes-contracts.md)). The exact
list depends on the §5 dispositions; the skeleton is:

1. **Contracts change (traderton, additive):** add the agreed shapes/functions (new files, no
   manifest-listed edit → no pin bump yet). Bump package version. Publish.
2. **Herobids consumes (additive):** re-point herobids' call sites to the new contracts exports;
   delete the herobids copy of each fully-moved file; prune barrels (I7); drop the corresponding
   manifest entries + `REQUIRED_*` ids (I1) + retarget the drift test (I2). **Herobids-first
   ordering** (I3): do herobids, then tag.
3. **Release herobids** (new tag, e.g. `v0.6.12`) via `scripts/shell/ops/release.sh <tag>`.
4. **Traderton dedupe:** delete/stop-mirroring the traderton side of any entry whose herobids copy
   is now gone, and **bump the sibling pin** with
   `scripts/shell/ops/release.sh --bump-parity-pin <herobids-tag>` (I4) in the same change. Record
   the pin pair in the ledger "Pin pairs" table.
5. **GP-T** for the traderton side; **GP-H** for the herobids side; floor §3.1 throughout.
6. Repeat until 8 → 0.

---

## 8. After D2 → C6 (finish line)

When the manifest has **zero entries**, report and wait; do not auto-start C6. C6 then deletes the
checker/manifest/test/CI job from both repos, strips `--bump-parity-pin` + parity steps from
`release.sh`/`release-xstack.sh`, removes the parity-drift rule from herobids `AGENTS.md`, and
records the pin-free end state (see roadmap "C6").

---

## 9. Checklist the next agent must run before any delete

- [ ] `git status` clean in both repos; note both SHAs in the ledger first.
- [ ] Read I1–I15 and the floor §3.1 / GP-H / GP-T before touching anything.
- [ ] Re-verify every consumer in §2 at execution time (trees move) — do not trust this table blind (I6).
- [ ] Rebuild domain before per-app `tsc` (roadmap gotcha 1). Watch the empty-barrel failure (gotcha 2).
- [ ] One manifest-touching change at a time (I15). Never edit one side of a still-mirrored file (I5).
- [ ] Record releases/pins per I12 in the ledger before running, and results after.