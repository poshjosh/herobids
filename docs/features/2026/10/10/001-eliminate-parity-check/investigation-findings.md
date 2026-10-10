# Investigation findings: remaining parity-manifest entries

- **Status:** RECOMMENDATIONS ONLY — nothing here is a ratified decision. Feeds back into
  `decisions/B-parity-ownership.md` (or a follow-up brief) for ratification.
- **Prompt:** `investigation-prompt.md` (same folder).
- **Date:** 2026-10-10.
- **Verification update (2026-10-10):** the dead-copy claims below came from grep alone and one of them (the traderton preset YAMLs, which this document does not cover) was retracted. All others were re-verified by trial deletion in scratch clones; see the roadmap's "Verification of the dead-copy claims".
- **Method:** for every entry, grep for real call sites in **both** repos (non-test, non-`dist`,
  non-`_deferred*`), then classify each repo's relationship as
  (a) executes real logic against it, (b) compile-time shape only, (c) dead.
  Test files and quarantined `_deferred-*` directories do not count as consumers.
  Greps were symbol-level (`rg -w`) over `.ts/.tsx` in `apps/`, `packages/`, `scripts/`, `tests/`.

## Dispositions used

Brief B's five: **(1)** shared package, **(2)** codegen, **(3)** runtime/boundary call,
**(4)** delete the copy, **(5)** feature relocation. One shape the evidence forced that is not
in Brief B's list, flagged for ratification:

- **(6, proposed) retire the obligation.** The code is generic, has no wire exposure, and is
  legitimately used by both repos. Neither a package nor a check is justified; each repo owns its
  copy and the manifest entry is dropped. Used only for `domain-result` and `domain-values-money`.

## Headline results

1. **Herobids has no consumer for 8 of the 9 `domain-ports-*` files.** Its `packages/engine`,
   `strategy`, `venues`, `market-data` no longer exist as tracked source (only untracked
   `dist/`, `node_modules/` remain), and the ports were only ever consumed by them. The mirror
   is dead weight on the herobids side, the same pattern as the preset YAML.
2. **`tick-gates-session-hours` is behavioural logic, and only herobids runs it.** Traderton's
   `tick-gates.ts` / `tick-gate-state.ts` are imported only by tests (one quarantined). It is also
   already stale: herobids gained `hasUserMessage`, `hasReminderWake` and `msUntilNextAllowedHour`
   (commits `014fe735`, `e77473c6`); traderton's copy has none and has not been touched since
   `578180f`. The pinned region is narrow enough that the check never caught this.
3. **The wire-DTO set is the only part that genuinely needs a mechanism:** `watch-types`,
   `scan-types`, the wake region of `trading-protocol`, `RegimeResult`/`VolatilityEvidence`,
   `EconomicEvent`, `HybridPricingIdentity`, `AgentRiskOverridesSchema`. Everything else is
   delete / boundary / retire.
4. **Two entries run behavioural logic independently in both repos** (flagged, not just a
   packaging problem): `execution-capability` + `mode-rank` (both repos execute them), and
   `agent-risk-contract` (herobids still resolves it, contradicting ADR 011 / C2.2).
5. **`trading-protocol`'s ownership is inverted from the manifest's assumption.** Traderton emits
   only `source: 'scanner'` wakes; herobids produces the watch / discovery / regime / reminder
   wakes itself and is the only repo that runs the Zod schemas.

## Master table

Legend: owner = repo that executes the real logic (verified). hb = herobids, tt = traderton.
Paths are repo-relative; line numbers refer to the current working trees.

| Entry id | Real owner | hb / tt relationship | Recommended disposition | Reason | Blocked? |
|---|---|---|---|---|---|
| `watch-types` | tt (producer) | hb (a, runtime Zod parse of boundary data) / tt (a) | (1) or (2): contract package | tt owns watch state; hb re-validates `list_watches` output | no |
| `scan-types` | tt (`technical-phase.ts`) | hb (b, unvalidated cast) / tt (a) | (1) or (2): contract package | Notification payload, not a tool result, so (3) cannot cover it | no |
| `tick-gates-session-hours` | **hb** | hb (a) / tt (c, tests only) | (4) delete tt copy | LLM-tick cadence is an hb agent-runtime concern; tt copy is dead and stale | no |
| `domain-ports-candle-fetcher` | tt | hb (c for `CandleFetcher`; `PriceCandle` type residue) / tt (a) | (4) delete hb copy | `CandleFetcher` has zero hb refs | `PriceCandle` residue waits on H5 |
| `domain-ports-economic-calendar` | tt (provider) | hb (b, 7-field render) / tt (a) | (6) hb keeps a local 7-field view type; delete hb copy | hb does not validate events; renderer reads 7 fields | no |
| `domain-ports-mark-source` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-ports-sentiment` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-ports-strategy` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-ports-subscription` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-ports-swap-venue` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-ports-token-safety` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-ports-venue` | tt | hb (c) / tt (a) | (4) delete hb copy | zero hb refs | no |
| `domain-values-ids` | tt | hb (c outside the mirrored cluster) / tt (a) | (4) delete hb copy | only hb consumers are `ports/venue`, `models/decision`, `values/instrument` | follows those |
| `domain-values-index` | barrel | follows members | follows members | `export *` of ids, money, instrument | follows members |
| `domain-values-instrument` | nobody | hb (c) / tt (c) | (4) delete both | zero importers of `Instrument` in either repo | no |
| `domain-values-money` | tt | hb (a, 1 file) / tt (a, 51 files) | (6) retire obligation | 19 lines over `decimal.js`; hb uses `price`, `quantity`, `Decimal` in 3 files | no |
| `domain-result` | both, independently | hb (a, 58 files) / tt (a, 38 files) | (6) retire obligation | 26-line generic type, never on the wire | no |
| `domain-pagination` | nobody | hb (c, one test) / tt (c) | (4) delete both | `PaginatedResponse` has no prod importer in either repo | no |
| `domain-trading-actor-health` | nobody (orphaned) | hb reads key / tt (c) | (4) delete tt copy; hb needs a product call (see Group 4) | `ActorHealthPublisher` is never instantiated in either repo | product call |
| `domain-trading-execution-capability` | tt (boundary enforces) | hb (a, API pre-validation) / tt (a) | (3) boundary; hb drops local check | **Behavioural logic duplicated** | decision needed |
| `domain-trading-mode-rank` | tt (boundary enforces) | hb (a, tool pre-check) / tt (a) | (3) boundary; hb drops local check | **Behavioural logic duplicated** | decision needed |
| `domain-trading-trading-protocol` (wake region) | **hb** for 4 of 5 wake kinds | hb (a, Zod runs) / tt (b, types only, scanner wake) | Split: (4) delete unused schemas from tt; (1)/(2) only for the envelope + `ScannerWakeContext` | tt never calls `.parse` on any of them | no |
| `domain-trading-venue-capability` | tt | hb (c; one orphaned test fixture) / tt (a) | (4) delete hb copy | no hb prod consumer | no |
| `domain-agent-risk-contract` | tt | hb (a, display only, empty profile) / tt (a) | (3) boundary for the math; `AgentRiskOverridesSchema` joins the contract set | contradicts ADR 011 / C2.2 | tied to Brief B `agent-risk-defaults` |
| `domain-cost-profile` | **hb** | hb (a) / tt (c) | (4) delete tt copy | zero tt refs | no |
| `domain-market-assessment` | moving to tt | hb (a, assessor + `RegimeResult`) / tt (c for ~55 of ~60 exports) | (5) superseded; confirm on H5 | see Group 5 | **blocked on H5** |
| `domain-models-decision` | tt | hb (c for `Decision`; `ActorType` in 1 file) / tt (a, 12 files) | (4) delete hb copy | retarget one `ActorType` import | no |
| `domain-scanner-types` (in manifest, not in the prompt) | tt | hb (b, `HybridPricingIdentity` in `TechnicalScanState`; rest dead after H5) / tt (a) | contract set (type) + (4) rest | extra entry found; see Group 5 | partly H5 |

## Group 1 — type / contract layer

### `watch-types`
- **tt (a):** `packages/worker/src/tools/watch.ts:22,41-43,701,795` parses Redis watch records
  with `parseWatch` / `toRuntimeActiveWatch`. Traderton is the sole producer; `watch_token`,
  `list_watches`, `check_watches` all live there.
- **hb (a, wire validation only):** `apps/worker/src/agent-watch-view.ts:15-21`, called from
  `apps/worker/src/agent.ts:797-815` (`loadRawActiveWatches`). Herobids fetches `list_watches`
  over the boundary each tick, then runs the same Zod `parseWatch` over each entry and drops
  malformed ones. The local Redis fallback is already gone (A6 comment at `agent.ts:797`), and
  herobids' own `tools/watch.ts` no longer imports `watch-types`. The header comment in
  `watch-types.ts` ("Used by tools/watch.ts, monitor.ts") is stale.
- **Disposition:** the schema is a wire contract with traderton as producer. (1) or (2).
  Note the `WatchPurposeEnum` it depends on lives in `trading-protocol.ts`
  (`WATCH_PURPOSE_VALUES`), so the two have to move together.
- **Alternative worth testing:** if the traderton `list_watches` tool descriptor can carry an
  `outputSchema`, this is a (3) candidate. **Not verified** — the descriptor file referenced by
  the herobids plan (`config/external-backends/traderton.descriptor.json`) is not present in the
  working tree.

### `scan-types`
- **tt (a):** `packages/worker/src/technical-phase.ts:30-52` defines and produces
  `CandleFetchStatus`, `SymbolFetchOutcome`, `PositionIndicatorUpdate`; consumed in
  `scan-types.ts`, `complete-technical-scan.ts`, `agent-trading-actor.ts`, `composition/*`.
- **hb (b):** `apps/worker/src/scan-types.ts` states "Types only — no trading behaviour".
  Delivery is `agents/actor-event-relay.ts:18` (`scan: z.record(z.unknown())`) then a cast at
  `:194` (`as unknown as TechnicalScanState`), and `runtime-composition.ts:2254`. Herobids logic
  (`hybrid-agent-evaluator.ts`, `hybrid-agent-prompt.ts`) reads fields, but the shape is never
  validated, so a producer-side change would break at runtime without a compile error.
- **Disposition:** (1) or (2). This is a relayed notification payload (`scan_completed`), not a
  tool result, so (3) does not apply. Codegen would first require converting these plain
  interfaces to Zod, so (1) is the cheaper path for this entry.

### `tick-gates-session-hours` — the behavioural-logic question
- **Does herobids still execute the gating in production? Yes.**
  `apps/worker/src/agent.ts:2848` calls `shouldSkipTick`; `:2967` calls `msUntilNextAllowedHour`
  to clamp the next-tick interval. `shouldSkipTick` (hb `tick-gates.ts:428`) applies the session
  gate through `isWithinTradingHours` (`:138`).
- **Does traderton? No.** `packages/worker/src/tick-gates.ts` (`isWithinTradingHours` `:123`,
  `shouldSkipTick` `:375`) and `tick-gate-state.ts` are imported only by
  `tick-gate-state.test.ts`, `tick-message-types.test.ts` and the quarantined
  `_deferred-config/tick-gates.test.ts` (excluded from build and test run). Nothing in
  `agent-trading-actor.ts` or the boundary calls them. Traderton also has no `tradingHours`
  enforcement anywhere in `src`.
- **Should traderton be the sole executor?** The evidence says no. These gates decide whether
  to **spend an LLM tick** (context-hash skip, adaptive interval, active-hours skip), which is
  an agent-runtime cost concern in herobids. Traderton has no LLM tick loop. If the product
  wants "do not *trade* outside session hours" enforced on `submit_decision`, that is a **new
  traderton feature**, not a de-duplication, and should be specified separately.
- **Disposition:** (4) delete traderton's `tick-gates.ts`, `tick-gate-state.ts` and their three
  test files. Herobids is the only owner. Drift already exists (see Headline 2).
- **Side findings in herobids:** `calculateAtrPercent` (`tick-gates.ts:374`) has no non-test
  caller (the volatility reading is derived upstream per the `fetchVolatilityPct` doc comment),
  which is the only reason `tick-gates.ts` imports `PriceCandle`. It can be removed with the
  `PriceCandle` import.

## Group 2 — domain ports

All eight non-calendar ports (`mark-source`, `sentiment`, `strategy`, `subscription`,
`swap-venue`, `token-safety`, `venue`, and `CandleFetcher` itself) have **zero herobids
references** outside their own definitions and the domain barrel. This includes `scripts/`,
`tests/` and `apps/web`. A generic-name check (`Strategy`, `Subscription`, `Position`, `Ticker`,
`Mark`, `VenueOrder` imported from `@herobids/domain`) also found nothing. All are live in
traderton: engine executors, `packages/venues/*` adapters, `agent-trading-actor.ts`,
`trading-actor.ts`, `composition/create-trading-runtime.ts`.

| Port | tt consumers (examples) | hb consumers |
|---|---|---|
| candle-fetcher | `strategy/mechanical-strategy.ts`, `venues/candle-fetcher.ts`, `worker/trading-actor.ts` | none for `CandleFetcher`; `PriceCandle` type only (below) |
| mark-source | `engine/trading-cycle.ts`, `engine/instrument-executor.ts`, `venues/*-mark-source.ts` | none |
| sentiment | `strategy/mechanical-strategy.ts` | none |
| strategy | `strategy/*`, `engine/trading-cycle.ts`, `backtesting/*` | none |
| subscription | `venues/*-stream.ts`, `engine/stream-market-data-feed.ts` | none |
| swap-venue | `engine/swap-live-executor.ts`, `venues/jupiter-swap.ts`, `oneinch-swap.ts` | none |
| token-safety | `engine/decision-intake.ts`, `worker/token-safety-adapter.ts` | none |
| venue | `engine/live-executor.ts`, `engine/reconciliation/*`, `venues/hyperliquid.ts`, `bybit.ts` | none |
| economic-calendar | `market-data/economic-calendar.ts` (provider) | `EconomicEvent` type only |

Surprises:
- **`PriceCandle` residue in hb.** Exported from `ports/candle-fetcher.ts`. Herobids imports it
  in `tick-gates.ts` (dead `calculateAtrPercent` only), `market-intelligence/platform-assessor.ts`
  and `preset-scorecard-runner.ts` (both deleted by plan H5), and `domain/market-assessment.ts`
  (Group 5). So deleting hb's `candle-fetcher.ts` is partly blocked on H5, partly on removing
  one dead function.
- **economic-calendar.** Herobids reads the boundary `get_economic_calendar` result via
  `venue-intelligence.ts:43` (`parseEconomicCalendarBoundaryPayload`), which only filters to
  objects and explicitly does not validate fields. The renderer (`runtime-composition.ts:1393`)
  reads exactly 7 fields (`time`, `currency`, `event`, `impact`, `forecast`, `previous`,
  `sources`). A local 7-field view type next to the renderer replaces the mirror; the interface
  already behaves as a tolerant reader.
- Deleting the herobids files also means pruning `packages/domain/src/ports/index.ts` and
  deleting the orphaned `tests/fixtures/venue-capabilities.ts` (Group 4), which has no importer.

## Group 3 — domain values and primitives

- **`ids`:** in herobids the only consumers are `ports/venue.ts`, `models/decision.ts` and
  `values/instrument.ts` — all inside the cluster being deleted. `AgentId` and `SkillId` have no
  consumers in either repo. Traderton uses the branded ids across 19 files.
- **`instrument`:** the `Instrument` interface has no importer in either repo. Delete in both.
- **`index`:** `export *` barrel for `ids`, `money`, `instrument`; follows its members.
- **`money`:** traderton uses it in 51 files. Herobids uses `price`, `quantity` and `Decimal` in
  `apps/worker/src/hybrid-decision-sizing.ts:14`, plus `Decimal` in
  `apps/api/src/routes/capabilities/trading-ledger.ts` and `agent-config-helpers.ts`. It is a
  19-line wrapper over `decimal.js` with no wire exposure. Recommend (6): herobids takes a direct
  `decimal.js` dependency (it already depends on it through `packages/domain/package.json:31`)
  and stops mirroring.
- **`result`:** identical 26-line type; 58 herobids and 38 traderton importing files. The
  boundary has its own envelope (`traderton/packages/boundary/src/result.ts`); this type never
  crosses the wire. Recommend (6).
- **`pagination`:** 6 lines; the only reference in either repo is a herobids test
  (`packages/domain/src/__tests__/skill-catalog-types.test.ts`). Dead in production in both.
  Same pattern as the preset YAML.

## Group 4 — domain trading types

### `actor-health` — orphaned feature, not a mirror problem
Neither repo instantiates `ActorHealthPublisher` outside its own test file. Herobids' API
(`apps/api/src/routes/actor-health.ts`) reads `herobids:actor-health:{agent|bot}:{id}` from Redis,
so in practice every response takes the `source: 'static'` branch. Traderton's copy writes to a
`herobids:`-prefixed key (`actor-health.ts:23`) and its only route consumer is in quarantined
`_deferred-authoring/`. This is a copy-not-authored artifact.
- **Recommend:** (4) delete the traderton copy. For herobids, **a product call is needed**: either
  remove the route's runtime branch, or (5) relocate health publication to traderton and expose it
  through a boundary read (the bot route already calls `get_owner_bot_status` this way).
  Do not package a type for a feature nobody writes.

### `execution-capability` and `mode-rank` — behavioural logic in both repos
- **tt (a, authoritative):** `packages/worker/src/composition/drive-target.ts:300` runs
  `validateExecutionCapability` and throws a dedicated `execution_capability.<code>` error;
  `:330` and `:606` run `checkModeEscalation`; also `tools/bots.ts:965,1185,1217`.
- **hb (a, pre-validation):** `apps/api/src/routes/bots.ts:339`, `routes/agents.ts:1276`,
  `routes/capabilities/trading.ts:1286` (API write-time reject), plus
  `apps/worker/src/tools/bots.ts:260` (mode escalation in the tool; its own comment says the
  broker re-checks, i.e. three layers).
- **Dependencies to note:** `execution-capability.ts` imports `SWAP_VENUES` / `ORDERBOOK_VENUES`
  from `config/schema.ts`, so a shared package would drag the venue catalogs along.
- **Recommend:** (3). The boundary already enforces both rules with typed, namespaced error codes,
  so herobids can map the error instead of re-implementing the policy table (the same pattern the
  herobids plan H2 uses for preset-policy and risk ceilings). If offline form validation is a hard
  product requirement (B2's stated virtue), fall back to (1). That is the one place this
  recommendation conflicts with B2's "offline validation" rationale and needs a decision.

### `trading-protocol` (region from `WatchThresholdWakeContextSchema` to EOF)
- **tt:** none of the `*Schema` exports in this region has a production caller; Zod is never run
  there. Only the inferred types are used: `AgentWakePayload`
  (`composition/consumer-notifier.ts`, `agent-trading-actor.ts`, `complete-technical-scan.ts`) and
  `TradingSessionName` (only the dead `tick-gates.ts`). The only wake traderton emits is
  `source: 'scanner'` (`complete-technical-scan.ts:287`).
- **hb (a):** runs the schemas through `agent-protocol.ts` (`AgentWakePayloadSchema` is also used by
  `agents/actor-event-relay.ts`). Herobids **produces** the watch-threshold, discovery-delta and
  regime-change wakes itself: `apps/worker/src/index.ts:1066` wires `createMarketMonitor`, whose
  `monitor.ts` builds those contexts. `TRADING_SESSION_NAMES` / `TradingSessionNameSchema` feed
  hb's `config/schema.ts` and the web UI (`RuntimePolicySection.tsx`, `style-mapping.ts`).
- **Codegen vs plain package?** Neither is needed for most of the region, because traderton does
  not execute it. Recommend: herobids owns the full wake union and session names; traderton keeps
  only the envelope and `ScannerWakeContext`, pinned via the contract set (1)/(2); delete the
  rest from the traderton copy (4). Codegen (2) fits the envelope only if the contract set is
  built from Zod; if (1) is chosen this is moot.

### `venue-capability`
Herobids' only reference is `tests/fixtures/venue-capabilities.ts`, which has no importer.
Traderton uses it in `engine/live-executor.ts`, `planner.ts`, `order-state.ts`, `venues/bybit.ts`,
`hyperliquid.ts`. Recommend (4) delete the herobids copy and the orphaned fixture.

## Group 5 — data / assessment types

### `market-assessment` and `models/decision` — overlap with the 2026-10-04 plans
- **tt:** of ~60 exports, only `RegimeResult`, `EvidenceValue`, `VolatilityEvidence`
  (`market-data/*`, `worker/scan-types.ts`, `worker/tools/market-data.ts`) and three schemas in
  `tool-schemas.ts` / `trading-protocol.ts` have consumers. The rest is staged ahead of the
  traderton plan's S1-S3 (which says `PresetScorecardEntry` "already lives" there — it has zero
  consumers today).
- **hb:** the assessment machinery is entirely in `apps/worker/src/market-intelligence/*` (deleted
  by H5), `tools/change-strategy-preset.ts` (H1), `domain/review-pre-check.ts`, and the
  `tool-schemas.ts` entries (H1). Live non-assessment users: `RegimeResult` in
  `venue-intelligence.ts`, `tick-gates.ts`, `runtime-composition.ts`.
- **Recommend:** (5) superseded by the plan pair; confirm on H5. **Not recommended for immediate
  action.** Two gaps in the herobids plan to fix before executing it:
  1. H5 lists `apps/worker/src/market-intelligence/*` files but **never mentions
     `packages/domain/src/market-assessment.ts`**, `review-pre-check.ts`, or the
     `ports/assessment-*` / `ports/preset-transition.ts` files. They should be added explicitly,
     otherwise the manifest entry survives H5.
  2. `market-intelligence/monitor.ts` and `coordinator.ts` are not in H5's delete list and are
     still wired (`index.ts:1066`). They are the producer of hb's watch/discovery/regime wakes
     (see Group 4) and keep needing `RegimeResult`.
- **Residue after H5:** `RegimeResult` and `VolatilityEvidence` are tool-result shapes
  (`check_regime`, `get_volatility`). They join the wire-DTO set (Headline 3).

### `models/decision`
Traderton uses `Decision` across `engine/planner`, `strategy/*`, `boundary/contract.ts`,
`worker/*` (12 files). In herobids, `Decision` is imported only by the dead `ports/strategy.ts`;
`ActorType` only by `services/approval-service.ts`, and the same union already exists twice more
in herobids (`ActorTypeSchema` in `agent-protocol.ts:53`, `ExternalBackendActorType` in
`external-backend/contract.ts:12`). Recommend (4): delete the hb copy, retarget one import.

### `agent-risk-contract`
- **tt (a):** `worker/agent-risk-context.ts:81`, `worker/agent-risk-limits.ts:45`,
  `db/agent-trading-profile-repository.ts`, `boundary/agent-direct-actor-ensure.ts`.
- **hb:** `apps/api/src/routes/agent-config-helpers.ts:621-648`
  (`resolveAgentRiskContractForResponse`) is called at `agents.ts:929,1061,1997,2768` **always
  with `{}`** as the profile. It therefore resolves defaults-and-ceilings only, never the agent's
  real creator input or overrides, and is display-only. Separately,
  `agents/trading-profile-reconciliation-saga.ts:77` uses `AgentRiskOverridesSchema` to parse the
  boundary's profile response (a legitimate wire schema), and `domain/trading/tool-contract.ts:256-258`
  references the types.
- **This contradicts ADR 011 / C2.2** ("herobids does not enforce local copies; retire
  herobids risk-contract math"). The retirement is not finished.
- **Recommend:** (3) for the math: source the response from the boundary reads Brief B already
  names (`get_operator_defaults` / `get_risk_limits`), and delete `resolveAgentRiskContract` from
  hb. `AgentRiskOverridesSchema` moves to the wire-DTO set. Sequence with Brief B's
  `agent-risk-defaults` row, since both remove the same local-defaults dependency.

### `cost-profile`
Herobids uses it for LLM tick-thinking and cost presets (`agent.ts`, `tick-thinking.ts`,
`cost-profile.ts`, API `agent-config-helpers.ts`, `agent-evaluation-narrative-llm.ts`).
Traderton has **zero** references. Recommend (4): delete the traderton copy. Herobids is the sole
owner. No dependency on other work.

### `domain-scanner-types` (extra entry not in the prompt)
`HybridPricingIdentity` is part of the hb `TechnicalScanState` (types only, joins the contract
set). `ScannerCandleTarget` and `SwapExecutionIdentity` are used in hb only by
`market-intelligence/*` (H5), and `scannerTargetKey` is unused. Traderton is the real owner
(`strategy/scan-engine.ts`, `worker/technical-phase.ts`). The hb file's header comment still says
"Moved from `@herobids/strategy`", a package that no longer exists.

## Proposed wire-DTO contract set (the only irreducible mirror)

| Shape | Direction | Carrier | Mechanism that fits |
|---|---|---|---|
| `WatchEntry` / `WatchEntrySchema` | tt to hb | `list_watches` tool result | (3) if `outputSchema` is available (unverified), else (1)/(2) |
| `RegimeResult`, `VolatilityEvidence`, `EvidenceValue` | tt to hb | `check_regime`, `get_volatility` results | same as above |
| `EconomicEvent` | tt to hb | `get_economic_calendar` result | (6): hb-local tolerant view |
| `AgentRiskOverridesSchema` | tt to hb | trading-profile read | same as watch |
| `TechnicalScanState` field types (`scan-types`, `HybridPricingIdentity`) | tt to hb | `scan_completed` notification | (1) or (2) |
| `AgentWakePayload` envelope + `ScannerWakeContext` | tt to hb | `agent_wake` notification | (1) or (2) |

Notifications are not tool results, so runtime discovery cannot carry them. If the notification
shapes need a single mechanism anyway, one small traderton-owned `@traderton/contracts` package
(Zod + types, no other dependencies) with a version pin in herobids covers the whole table and
lets the tool-result rows ride along. Herobids currently has no `@traderton/*` dependency, so this
introduces the first one: that cost belongs in the ratification.

## Suggested sequencing (for ratification, not a decision)

1. **No dependencies, do-anytime deletes:** tt `tick-gates.ts` + `tick-gate-state.ts` + tests,
   tt `cost-profile.ts`, `pagination.ts` and `instrument.ts` (both), hb ports (7 files),
   hb `ids`, `venue-capability` + orphaned fixture, hb `decision.ts` (retarget `ActorType`).
   Each is removed together with its manifest entry. Check `ports/index.ts` and domain
   `index.ts` barrels.
2. **Decisions needed first:** `execution-capability` / `mode-rank` (offline validation vs
   boundary error mapping), `actor-health` (product call), `domain-agent-risk-contract`
   (together with Brief B `agent-risk-defaults`), and ratifying disposition (6).
3. **Blocked:** `market-assessment`, `domain-scanner-types` (partial), `candle-fetcher`
   (`PriceCandle` residue) — wait for H5 (and Wave E's herobids halves E1-H/E3-H; the traderton halves are done), after fixing the two plan
   gaps above.
4. **Contract set:** choose (1) vs (2) vs (3)-for-tool-results, then migrate `watch-types`,
   `scan-types`, the `trading-protocol` envelope, `RegimeResult`/`VolatilityEvidence` and
   `AgentRiskOverridesSchema`. Only after this can `check-parity-drift.mjs` and the manifest be
   removed entirely.

## Caveats

- Symbol-level `rg -w` cannot see dynamic or string-keyed use; deletion PRs should still run
  `pnpm lint` and the worker tsc (`pnpm exec tsc --noEmit -p apps/worker/tsconfig.json`), since
  the root lint does not check the worker.
- Generic names (`Result`, `Decision`, `ok`, `err`) were checked via import statements from the
  domain package or `./result`, not bare word matches.
- The `outputSchema` / descriptor question and the `{}`-profile display behaviour should be
  confirmed by the owning team before relying on them.
