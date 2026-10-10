# Investigation prompt: remaining parity-manifest entries

Hand this document to an agent (or run it yourself) to investigate the manifest
entries that Decision Brief B
(`docs/features/2026/10/10/001-eliminate-parity-check/decisions/B-parity-ownership.md`)
could not resolve — each currently has either no recommendation or only an unverified
"likely" guess. Output: a recommendation per entry, with reasons and the evidence
checked, so the findings can be folded back into Brief B (or a new brief) for
ratification.

## Background (read first)

- Goal: eliminate `scripts/parity-drift-manifest.json` and
  `scripts/check-parity-drift.mjs` entirely — herobids and traderton should stop
  needing a byte-identical mirror check between them.
- Read `docs/features/2026/10/10/001-eliminate-parity-check/decisions/B-parity-ownership.md`
  first. It explains the 5 possible dispositions for any mirrored file (shared
  package, codegen, runtime/boundary call, delete-as-dead-code, feature relocation),
  and already resolved 3 of the ~12 remaining groups. Do not re-litigate those.
- Read `docs/tech/architecture/adrs/2026/09/011-split-trading-authority-by-responsibility.md`
  and
  `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B2-duplicated-authority.md`
  for why the duplication exists at all.
- Precedent for how to investigate: the preset-catalog YAML entry (now resolved) was
  decided by actually grepping traderton for real call sites and finding **zero**
  — the files were dead weight copied verbatim during extraction and never
  revisited. Do the same thing here: do not infer ownership from `AGENTS.md`
  statements like "packages/domain has zero deps" alone — verify actual call sites in
  both repos before recommending a direction. A file can be "owned" by one repo
  architecturally and still be dead weight or display-only in the other.

## Entries to investigate

For **each** entry below, in both `herobids` and `traderton`:
1. Find every real call site (not just type-only imports) — grep for usages, not just
   the file's own declarations.
2. Classify each repo's relationship to the file: (a) executes real logic against it,
   (b) uses it only for type-checking/compile-time shape with no runtime behavior
   depending on its content, or (c) does not use it at all (dead).
3. Recommend one of the 5 dispositions from Brief B, with the specific evidence
   (file paths, function/call names) that justifies it.
4. Flag any entry whose content is actual **behavioral logic** (not just type
   declarations) running independently in both repos — that's a different kind of
   problem than a type mirror (see note on `tick-gates-session-hours` below).

### Group 1 — type/contract layer
- `watch-types` — herobids: `apps/worker/src/watch-types.ts`; traderton:
  `packages/worker/src/watch-types.ts`.
- `scan-types` — herobids: `apps/worker/src/scan-types.ts` (region starting at
  `export type CandleFetchStatus`); traderton: `packages/worker/src/technical-phase.ts`
  (same region, ending at `export interface TechnicalPhaseDeps`).
- `tick-gates-session-hours` — herobids: `apps/worker/src/tick-gates.ts` (region
  `const SESSION_LOCAL_HOURS` through `const HOURS_IN_WEEK`); traderton:
  `packages/worker/src/tick-gates.ts` (same region, ending at
  `export function computePriceBucket`). **This region is gating logic, not a type
  declaration** — determine whether herobids' worker still independently executes
  this gating in production, or only needs the types/constants to interpret
  traderton's output. If herobids still executes it, decide whether it should
  (architecturally, should traderton be the sole executor now, with herobids just
  consuming a decision?) in addition to how to de-duplicate the code itself.

### Group 2 — domain ports (zero-dep interfaces, per AGENTS.md)
All at `packages/domain/src/ports/` in both repos:
- `domain-ports-candle-fetcher` (`candle-fetcher.ts`)
- `domain-ports-economic-calendar` (`economic-calendar.ts`)
- `domain-ports-mark-source` (`mark-source.ts`)
- `domain-ports-sentiment` (`sentiment.ts`)
- `domain-ports-strategy` (`strategy.ts`)
- `domain-ports-subscription` (`subscription.ts`)
- `domain-ports-swap-venue` (`swap-venue.ts`)
- `domain-ports-token-safety` (`token-safety.ts`)
- `domain-ports-venue` (`venue.ts`)

### Group 3 — domain values and shared primitives
All at `packages/domain/src/` in both repos:
- `domain-values-ids` (`values/ids.ts`)
- `domain-values-index` (`values/index.ts`)
- `domain-values-instrument` (`values/instrument.ts`)
- `domain-values-money` (`values/money.ts`)
- `domain-result` (`result.ts`)
- `domain-pagination` (`pagination.ts`)

### Group 4 — domain trading types
All at `packages/domain/src/trading/` in both repos:
- `domain-trading-actor-health` (`actor-health.ts`)
- `domain-trading-execution-capability` (`execution-capability.ts`)
- `domain-trading-mode-rank` (`mode-rank.ts`)
- `domain-trading-trading-protocol` (`trading-protocol.ts`, region starting at
  `export const WatchThresholdWakeContextSchema`) — note this region is **Zod
  schemas** (runtime validators), not pure types; flag whether codegen (option 2 in
  Brief B) fits better than a plain shared package here.
- `domain-trading-venue-capability` (`venue-capability.ts`)

### Group 5 — domain data/assessment types (check overlap with the 2026-10-04 plans first)
- `domain-agent-risk-contract` (`packages/domain/src/agent-risk-contract.ts`)
- `domain-cost-profile` (`packages/domain/src/cost-profile.ts`)
- `domain-market-assessment` (`packages/domain/src/market-assessment.ts`)
- `domain-models-decision` (`packages/domain/src/models/decision.ts`)

Before investigating these four, re-read
`traderton/docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md` and
`herobids/docs/features/2026/10/04/002-preset-assessment-on-traderton/001-plan.md`.
`market-assessment.ts` and `decision.ts` may already be slated for relocation or
retirement as part of that plan (e.g. the traderton plan explicitly says
`PresetScorecardEntry` already lives in `@traderton/domain` `market-assessment.ts`,
and herobids plan step H5 deletes much of the herobids-side assessment machinery).
Do not recommend a package/codegen mechanism for content that's about to be deleted
by an already-planned move — recommend "superseded, confirm on completion of H5" the
same way Brief B already did for the preset catalog, if that's what the evidence
shows. `agent-risk-contract.ts` and `cost-profile.ts` likely are not covered by that
plan — verify independently.

## Deliverable

Produce one document (suggested location:
`docs/features/2026/10/10/001-eliminate-parity-check/investigation-findings.md`) with:
- A table: entry id | real owner (verified, not guessed) | recommended disposition
  (one of the 5 options) | one-line reason | evidence (file:line or call-site list).
- A short section per Group flagging anything surprising (e.g. a file dead in one repo
  like the preset YAML was, or logic that's actually still independently executed in
  both repos and needs an architectural call, not just a packaging fix).
- Explicit flags for any entry that turns out to be blocked on other in-flight work
  (same pattern as Group 5), so it isn't recommended for immediate action.

This findings document feeds back into Decision Brief B (or a new follow-up brief) for
ratification — it should not itself declare a final decision, only a recommendation
with evidence, consistent with how B1/B2/B-parity-ownership are structured in this
project.
