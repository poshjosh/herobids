# C1 — `@traderton/contracts` package carve-out plan

Exact export list per shape group, package layout, build graph, test strategy, starting
version, the narrowed wake envelope, and the revised C1.1–C4 row list for Track C.
Written 2026-10-10 (C1.0). This is the planning doc for the wire-DTO contract package
ratified as Brief B decision 5 and mechanised in
[`decisions/wire-dto-package-mechanics.md`](../decisions/wire-dto-package-mechanics.md).

**Authority:** traderton. **Approach:** additive first — the package is built as a copy;
the mirrored originals stay untouched and pinned until herobids swaps (C3), a herobids tag
exists (G3), and only then traderton dedupes (C4). Editing a mirrored traderton file earlier
would turn traderton CI red (invariant I3).

## 1. Package layout and name

`packages/contracts` in traderton, name `@traderton/contracts`, version **`0.1.0`** (the
first publish; G2 tags `@traderton/contracts@0.1.0`, independent of the root `0.1.3`
version). Zero runtime deps; `zod@^3.25.0` only (already the workspace's pinned line).

```text
packages/contracts/
  package.json        # name @traderton/contracts, private:false, exports "." barrel + "./trading" + "./assessment"
  tsconfig.json       # extends ../../tsconfig.base.json; outDir dist; rootDir src
  src/
    index.ts          # export * from watch/scan/wake/regime/risk + type-only re-exports
    trading/
      watch.ts        # WatchEntry, WatchEntrySchema, WatchInstrumentIdentity, WatchCoverageLink
      watch-purpose.ts# WATCH_PURPOSE_VALUES, WatchPurposeEnum, WatchPurpose (moved from trading-protocol)
      scan-state.ts   # CandleFetchStatus, SymbolFetchOutcome, PositionIndicatorUpdate
      pricing-identity.ts # HybridPricingIdentity (moved from scanner-types)
      wake.ts         # WakePriority, AgentWakePayload base + ScannerWakeContext (the narrowed envelope)
      risk-overrides.ts # AgentRiskOverrides, AgentRiskOverridesSchema
    assessment/
      regime.ts       # RegimeResult, RegimeResultSchema (type + Zod copy; canonical stays @traderton/market-data)
      evidence.ts     # EvidenceValue<T>, EvidenceValueSchema<T>, VolatilityEvidence, VolatilityEvidenceSchema
  __tests__/          # round-trip contract fixtures per schema (see §4)
```

Add `packages/contracts` to `pnpm-workspace.yaml` `packages:` (already `packages/*`) and to
`tsconfig.json` `references`. No manifest-listed source file changes in C1.x, so no pin bump.

## 2. Exact export list per shape group (with transitive deps)

Transitive dependencies are what force a file to move into the package ahead of the
shape that uses it. Each shape is **copied** (not moved) in C1.x; the originals stay until C4.

| Shape group | Exports copied | Transitive deps (also copied) | Source (traderton) | Notes |
|---|---|---|---|---|
| **Watch** | `WatchEntry`, `WatchEntrySchema`, `WatchInstrumentIdentity`, `WatchCoverageLink` | `WatchPurposeEnum`, `WatchPurpose`, `WATCH_PURPOSE_VALUES` | `packages/worker/src/watch-types.ts` + `packages/domain/src/trading/trading-protocol.ts:10-12` | `parseWatch`/`toRuntimeActiveWatch` ship **only as type+Zod**, not the runtime helpers — they import a `logger` (worker infra) and herobids' `RuntimeActiveWatch` (worker-local). See §5. |
| **Scan state** | `CandleFetchStatus`, `SymbolFetchOutcome`, `PositionIndicatorUpdate` | `HybridPricingIdentity` | `packages/worker/src/technical-phase.ts:30-56` + `packages/domain/src/scanner-types.ts:10-15` | These are plain field types (no Zod today). `TechnicalScanState` itself **stays** (it imports `RegimeResult`, `ScoredSignal`, `PositionIndicatorUpdate`; herobids composes its own `TechnicalScanState`). |
| **Wake envelope** (narrowed) | `WakePriority`, `WakePrioritySchema`, `AgentWakePayload` (base fields only), `ScannerWakeContext`, `ScannerWakeContextSchema` | `MarketAssessmentIdentity`, `MarketAssessmentIdentitySchema` (used by the `assessment_review` variant) | `packages/domain/src/trading/trading-protocol.ts:148-170` + `packages/domain/src/market-assessment.ts:37-73` | See §6 for the narrowed envelope. |
| **Regime & volatility** | `RegimeResult`, `RegimeResultSchema`, `EvidenceValue<T>`, `EvidenceValueSchema<T>`, `VolatilityEvidence`, `VolatilityEvidenceSchema` | none (all self-contained Zod/native) | `packages/domain/src/market-assessment.ts:836-941` + `packages/market-data/src/types.ts:150-166` | **Do not copy** `LiquidityEvidence`/`BreadthEvidence`/the rest of `market-assessment.ts` — those stay with the blocked set (I10/R10/H5). |
| **Risk overrides** | `AgentRiskOverrides`, `AgentRiskOverridesSchema` | `AgentRiskField` (type only, read by the schema? No — `AgentRiskOverridesSchema` is self-contained; field-level `AgentRiskField` is NOT copied) | `packages/domain/src/agent-risk-contract.ts:48-56` | Only the **persisted overrides** shape (the wire value), not the resolution math (`resolveRiskField`, `resolveAgentRiskContract`) — that stays boundary-owned (ADR 011 / C2.2). |

**Deliberately out of scope (not the wire-DTO set / blocked):**
`MarketAssessmentIdentity`, `ScannerCandleTarget`, `SwapExecutionIdentity`,
`LiquidityEvidence`, `BreadthEvidence`, `PriceCandle`, `RegimeResult` at its canonical
`@traderton/market-data` home — these remain in the Track-D blocked set (I10/R10) or are
only copied as a transitive dependency where explicitly listed above. `EconomicEvent` is
**type-only / not copied**: herobids keeps its own tolerant 7-field view (disposition 6);
traderton's authoritative type stays put.

## 3. A note on `RegimeResult`'s dual home

`RegimeResult` exists twice in traderton: the canonical `packages/market-data/src/types.ts:150`
(re-exported from `@traderton/market-data`) and a structurally-identical copy in
`packages/domain/src/market-assessment.ts:836` (verified identical 2026-10-10). The package
carries its own `RegimeResult` + `RegimeResultSchema` **copy** (type + Zod) so `@traderton/contracts`
has no runtime dependency on `@traderton/market-data`; the canonical source stays in
`market-data`. Herobids' current import sites of `RegimeResult`/`VolatilityEvidence`/
`EvidenceValue` (from `@herobids/domain`, i.e. its `market-assessment.ts` mirror) are:
`market-intelligence/platform-assessor.ts`, `assessment-ports.ts`, `evidence-adapters.ts`,
`runtime-composition.ts`, `tick-gates.ts`, `venue-intelligence.ts` — these re-point to the
package in C3.5 **without** editing the still-mirrored `market-assessment.ts` itself (I5).

## 4. Test strategy

Per shape group: **round-trip contract fixtures** (`packages/contracts/__tests__/`) that
`z.object().parse()` a representative valid payload and assert the discriminated-union
behaviour — e.g. a watch with `purpose`, a `ScannerWakeContext` for each of
`signal_scoring` / `preset_review` / `assessment_review`, and `EvidenceValue<T>` in both
`available` and `unavailable` states. No I/O, no worker/domain imports — `zod` only. These
are the contract tests the roadmap's C3.3/C3.4 rows mention moving out of the consuming
repos.

## 5. Runtime helpers: schemas + types only, no `parseWatch`

`parseWatch` and `toRuntimeActiveWatch` stay out of the package: they import a worker-local
`logger` and (herobids side) the worker-local `RuntimeActiveWatch`. Herobids keeps its own
`parseWatch` in `agent-watch-view.ts` (C3.2 deletes only the mirrored `watch-types.ts` type
file, rewiring `agent-watch-view.ts` to import `WatchEntry`/`WatchEntrySchema` from the
package). The package ships **schema + type only** — the thin runtime validator question the
mechanics doc left open resolves to: no runtime SDK; the Zod schemas are the validator
surface.

## 6. The narrowed wake envelope (`Brief B` O4)

The envelope the package owns is **producer-facing only**: `ScannerWakeContext` (the one wake
traderton emits) + the shared base fields. Herobids **keeps its own** `WatchThresholdWakeContext`,
`DiscoveryDeltaWakeContext`, `RegimeChangeWakeContext`, `ReminderWakeContext` and composes the
full discriminated union locally (C3.4). This matches the finding that `trading-protocol`'s
ownership is inverted from the manifest's assumption (herobids produces 4 of 5 wake kinds and
is the only repo that `.parse`s them). The package's `wake.ts` therefore exports:

- `WakePrioritySchema` / `WakePriority`
- `ScannerWakeContextSchema` / `ScannerWakeContext`
- `MarketAssessmentIdentitySchema` / `MarketAssessmentIdentity` (the transitive dep of the
  `assessment_review` variant) as a re-export for types
- the **base** wake fields (`wakeId`, `reason`, `eventIds`, `priority`, `requestedAt`,
  `notBefore`) as a type+`z.object` that herobids reuses when it re-composes its own envelope

It does **not** export `AgentWakePayloadSchema` as a closed 5-way union (that union is
herobids-composed). The manifest entry `domain-trading-trading-protocol` is dropped only in
C3.4 (after herobids switches the `scanner` variant at its boundary-parse sites to the
package), matching the current asymmetric `region` on that entry.

## 7. Starting version and publish mechanics

- Version `0.1.0` for the package; every traderton release that touches contract shapes
  publishes a new package version (the C2.0 plan details the mapping).
- `publishConfig.registry = "https://npm.pkg.github.com"`, scoped to `@traderton`, exact-pin
  in herobids (`"@traderton/contracts": "0.1.0"`, no `^`/`~`).
- Workspace consumers (traderton's own `worker`/`boundary`, then herobids) use `workspace:*`
  / the published version respectively.

## 8. Revised C1.1–C4 row list (writes back into the roadmap)

| Row | Repo | Action | Manifest entry affected |
|---|---|---|---|
| C1.1 | traderton | `packages/contracts` skeleton (barrel, build, lint, test wiring; empty) | none |
| C1.2 | traderton | Copy Watch group (`watch.ts`, `watch-purpose.ts`) + round-trip tests | none (copy) |
| C1.3 | traderton | Copy Scan-state group (`scan-state.ts`, `pricing-identity.ts`) + tests | none (copy) |
| C1.4 | traderton | Copy narrowed Wake envelope (`wake.ts`) + `assessment/repo` identity dep + tests | none (copy) |
| C1.5 | traderton | Copy Regime & volatility group (`regime.ts`, `evidence.ts`) + tests | none (copy) |
| C1.6 | traderton | Copy Risk-overrides group (`risk-overrides.ts`) + tests | none (copy) |
| C2.0/C2.1 | traderton | Plan + implement publish workflow, dry run | none |
| G2 | traderton | First publish `@traderton/contracts@0.1.0` | none |
| C3.0 | herobids | Plan install auth (`.npmrc`, CI, Docker); **stop if O6 needs a secret** | none |
| C3.1 | herobids | Wire exact-pin dep + a clean `pnpm install` and Docker build | none |
| C3.2 | herobids | Swap watch imports → package; delete `apps/worker/src/watch-types.ts` | drop `watch-types` |
| C3.3 | herobids | Swap scan-state imports → package; delete `apps/worker/src/scan-types.ts` | drop `scan-types` (`domain-scanner-types` stays to D2) |
| C3.4 | herobids | Compose wake union from package base + local contexts; re-point scanner parse | drop `domain-trading-trading-protocol` |
| C3.5 | herobids | Re-point regime/volatility imports → package (don't edit `market-assessment.ts`) | `domain-market-assessment` stays to D2 |
| C3.6 | herobids | Re-point `AgentRiskOverridesSchema` → package; delete `agent-risk-contract.ts` | drop `domain-agent-risk-contract` (requires B3.2 ✓) |
| G3 | herobids | Tag the C3 entry removals | — |
| C4 | traderton | Import from the package (workspace), delete originals, dedupe, bump pin | none (originals now deduped) |
| C5 | herobids | Automate package version-pin bump in `release-xstack.sh` | none |

## 9. Contingencies / gaps

- **`TechnicalScanState` and `ScoredSignal`** are **not** package members: `ScoredSignal`
  lives in `@traderton/strategy` and `TechnicalScanState` is a worker composition. The
  `scan-types` entry (herbids's `apps/worker/src/scan-types.ts`) only ever mirrored the three
  plain field types, which is what moves (C1.3/C3.3).
- If the O6 install-auth answer requires a **new** PAT/secret, that is a heavyweight stop at
  C3.0, not here.
- Preset/`market-assessment`/`scanner-types`/`PriceCandle` H5-blocked items are untouched by
  this track (I10/R10).