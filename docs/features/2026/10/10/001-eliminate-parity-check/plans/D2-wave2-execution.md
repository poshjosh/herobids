# D2 Wave 2 — execution plan (post-ratification)

**Milestone:** M-D (Track D), Wave 2. **Status:** dispositions ratified 2026-10-12
(D2-a=1, D2-b=1, D2-c=1, D2-d=3). This is the concrete step list the §7 skeleton
deferred on. Read [`D2-herobids-drops-last-manifest-entries.md`](D2-herobids-drops-last-manifest-entries.md)
and [`../decisions/D2-wave2-last-eight-entries.md`](../decisions/D2-wave2-last-eight-entries.md)
first.

## 0. Dispositions (ratified)

| Row | Entries | Disposition |
|---|---|---|
| D2-a | `strategy-preset-economy/-premium/-standard`, `domain-config-presets-loader`, `domain-config-presets` | **Option 1** — new traderton read tool returns full `PresetEntry`; herobids re-points its preset call sites to it; herobids keeps `applyPresetToAgent`/`computePresetBehaviorVersion`/`agentStyleToPresetStyle`; only the YAML data source moves |
| D2-b | `domain-scanner-types` | **Option 1** — add `ScannerCandleTarget`, `SwapExecutionIdentity`, `scannerTargetKey` to `@poshjosh/contracts` |
| D2-c | `domain-ports-candle-fetcher` (residual `PriceCandle`) | **Option 1** — add `PriceCandle` to `@poshjosh/contracts` |
| D2-d | `domain-config-strategy-parameters` | **Option 3** — keep herobids-local; reclassify/narrow the entry to a genuinely-shared sub-region |

## 1. Finding recorded at execution time (2026-10-12)

**Sync/async mismatch in D2-a.** The herobids preset call sites are **synchronous**:

- `resolveAgentStrategyPreset` (`agents/strategy-preset-resolver.ts`) — sync, called from
  `resolveUnifiedConfig` (`agent-create-normalization.ts:132`) and `routes/agents.ts:1384`.
- `deriveProfileScanConfig` (`agents/profile-scan-config.ts`) — sync, called from ~10
  sites (`agents.ts:791,1747`, `chat.ts:1470`, `connections.ts:479`,
  `agent-config-service.ts:104`, `agent-go-live-service.ts:313`,
  `agent-interactivity.ts:313`, `blueprints.ts:2323`, `backfill-profile-scan-config.ts:58`).
- `resolvePresetTechnical` (`profile-scan-config.ts:146`) — sync, inside the above.

A boundary read is **async** (`boundary.invoke(...)` → `Promise`). Making these sync
functions async would ripple through the whole API layer. **Resolution (lightweight,
matches existing precedent):** populate an **in-process preset cache at API startup**
(one async fetch of the full catalog over the boundary), and keep `getPreset`/`listPresets`
synchronous by reading from that cache. This mirrors `loadOperatorRiskDefaults`
(`traderton-operator-defaults.ts`), which already caches a boundary read in-process.
Consequence (inherent to Option 1, already ratified): preset resolution now depends on
the boundary being reachable at startup — fail-closed, not fail-open.

## 2. Step list (ordered; herobids-first per I3)

### Phase 1 — contracts additions (traderton, additive; no pin bump)

1. **D2-b:** add `ScannerCandleTarget`, `SwapExecutionIdentity`, `scannerTargetKey` to a
   new `packages/contracts/src/trading/scanner-identity.ts`; re-export from
   `trading/index.ts` + root `index.ts`. `HybridPricingIdentity` already lives in
   `trading/pricing-identity.ts`.
2. **D2-c:** add `PriceCandle` to a new `packages/contracts/src/trading/price-candle.ts`;
   re-export.
3. Add round-trip fixtures to `packages/contracts/src/__tests__/contracts.test.ts`.
4. Bump `packages/contracts/package.json` version (0.1.0 → 0.2.0).
5. GP-C: `pnpm --filter @poshjosh/contracts run build` + `test` green; full traderton
   build + suite green. **No manifest-listed file changed → no pin bump.**

### Phase 2 — publish contracts (G-row)

6. `pnpm publish --filter @poshjosh/contracts --no-git-checks` (dry-run first per C2.0).
   Record version + time in the ledger.

### Phase 3 — herobids consumes contracts (D2-b, D2-c)

7. Bump herobids' exact pin of `@poshjosh/contracts` (0.1.0 → 0.2.0) in
   `packages/domain`, `apps/api`, `apps/worker` package.json + `pnpm-lock.yaml`.
8. **D2-b:** re-point `apps/worker/src/runtime-composition.ts` imports
   (`HybridPricingIdentity`, `SwapExecutionIdentity`) to `@poshjosh/contracts`; delete
   `packages/domain/src/scanner-types.ts`; prune `domain/index.ts` barrel; drop
   `domain-scanner-types` entry + `REQUIRED_*` id (I1) + retarget drift test (I2).
9. **D2-c:** re-point `apps/worker/src/tick-gates.ts` `PriceCandle` import to
   `@poshjosh/contracts`; delete `packages/domain/src/ports/candle-fetcher.ts`; prune
   `ports/index.ts`; drop `domain-ports-candle-fetcher` entry + id + retarget test.
10. GP-H: domain build → lint → per-app tsc → web typecheck → full clean-env suite →
    both herobids recipes.

### Phase 4 — release herobids (G-row)

11. `scripts/shell/ops/release.sh <tag>` (e.g. `v0.6.12`). Record tag + pin target.

### Phase 5 — traderton dedupe (D2-b, D2-c)

12. Re-point traderton's `scanner-types.ts` / `candle-fetcher.ts` consumers to
    `@poshjosh/contracts` where the shape moved; keep traderton's live `CandleFetcher`
    interface + any non-contract residue. Bump the sibling pin to the Phase-4 tag
    (`release.sh --bump-parity-pin <tag>`). GP-T.

### Phase 6 — D2-a (traderton read tool → herobids re-point)

13. **Traderton:** add a `get_strategy_presets` read tool (owner-scoped, no venue) that
    returns the full `PresetEntry` catalog (all three tiers, or a requested tier). Wire
    it into `presetAssessmentTools` (or `tradingProfileTools`) + the registry. GP-T.
14. **Herobids:** add a startup preset-cache loader (async fetch of the full catalog,
    in-process cache); re-point `presets-loader.ts`'s `getPreset`/`listPresets` to the
    cache; delete the 3 YAML files; drop `strategy-preset-*` + `domain-config-presets-loader`
    entries + ids + retarget test. `presets.ts` (derivation) stays; narrow/reclassify
    `domain-config-presets` to the genuinely-shared sub-region (or drop if none). GP-H.
15. Release herobids; traderton bump pin. GP-T.

### Phase 7 — D2-d (strategy-parameters)

16. Keep herobids `strategy-parameters.ts` local. Reclassify/narrow the
    `domain-config-strategy-parameters` entry to the genuinely-shared sub-region
    (re-verified from `config/schema.ts` consumers at execution time), or drop it if the
    shared region is empty. GP-H.

### Phase 8 — C6 (finish line)

17. When the manifest has zero entries, STOP and report; do not auto-start C6.

## 3. Open implementation details (decided at execution, lightweight)

- Exact contracts file names (`scanner-identity.ts`, `price-candle.ts`) — match the
  existing `trading/*.ts` naming.
- Whether `scannerTargetKey` (a pure function) ships in contracts — yes; the package
  already ships `EvidenceValueSchema` (a function), so a pure key-derivation helper is
  within the "schemas + types" charter's spirit.
- `domain-config-presets` (`presets.ts`) final disposition under D2-a Option 1: herobids
  keeps the derivation logic; the entry is narrowed to the genuinely-shared sub-region
  (the `PresetEntrySchema`/`PresetEntry`/`StyleKey`/`isStyleKey`/`agentStyleToPresetStyle`
  block) or dropped if herobids' copy diverges enough that no shared region remains.