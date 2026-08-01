# 011 - Agent Scanner DEX Venue Completion

**Status:** Planned  
**Created:** 2026-08-01  
**Depends on:** [004 Part 1 - Orderbook Scanner Completion](../../07/17/004-agent-scanner-multi-venue-signal-support/001-plan.md) (implemented)

## Goal

Allow a hybrid or scanner-gated agent bound to Jupiter or 1inch to receive
technically scored DEX signals and submit them using an exact, address-qualified
swap pair.

The complete production path is:

```text
binding -> network and quote policy -> pool discovery -> OHLCV -> scoring
-> completed scan -> hybrid prompt -> exact decision intake -> swap execution
```

The display symbol remains readable, for example `BONK/USDC`. Every internal
execution, pricing, and candle identity is exact and address-qualified.

## Scope Decisions

These decisions resolve the open questions in the prior scanner plans.

| Question | Decision | Rationale |
|---|---|---|
| Which swap venues ship first? | Jupiter on Solana and 1inch on Base. | Both have canonical USDC data in `config/default.yaml`; Base is the configured 1inch deployment. Other 1inch networks remain disabled until their canonical quote assets and operational support are added. |
| What determines the scan network? | The active trading binding. Jupiter always resolves to `solana`; 1inch resolves through `resolveSwapNetwork`. | An agent must never discover an asset on a different network than it can execute. `technical.filters.networks` is a narrowing assertion only and must include the binding network when supplied. |
| Where does quote-asset choice live? | `technical.filters.quoteAssetSymbol`, defaulting to `USDC`, is agent instance config. The valid choices are the operator-owned `marketData.tokenSafety.canonicalTokens[network]` keys. | Quote preference is an agent trading preference, while the allowed tokens and addresses are deployment policy. This preserves the configuration-layer boundary. |
| What is a scanner-generated swap instrument ID? | `BASE_SYMBOL:BASE_ADDRESS/QUOTE_SYMBOL:QUOTE_ADDRESS`. | Both venue adapters execute token addresses, and both addresses must survive the pipeline to avoid same-symbol ambiguity. |
| How are 1inch tokens validated? | Validate the exact-pair structure, the resolved supported network, and the canonical quote address. Do not require the base address in the curated cache. | 1inch can trade legitimate Base assets beyond the curated list. |
| How are candles fetched? | An explicit `ScannerCandleTarget` union routes orderbook targets to Binance and swap targets to GeckoTerminal by `network + poolAddress`. | No string-length or symbol-format heuristic is acceptable for execution-adjacent identity. |
| How is swap scanning enabled/disabled operationally? | A new operator flag `agentRuntime.scanner.swap.enabled` (default `false`), with an optional per-venue map `agentRuntime.scanner.swap.venues.{jupiter,1inch}`. When disabled, swap bindings keep returning no candidates exactly as today. | Landing Phase 3 removes the current `return []` gate, which would otherwise turn on *every* swap-bound agent at once with no rollback short of a code revert. The flag is the operator kill-switch and per-venue rollout control. |
| Does the exact `BASE:ADDR/QUOTE:ADDR` ID need a schema change? | No. Verified: `instrumentId` is `z.string().min(1)` (no format constraint) at every boundary — the public tool schema `SubmitDecisionParamsSchema`, the wire schema `DecisionSubmitPayloadSchema` (safeParse'd at the message broker for both the LLM and scanner/hybrid paths), and the branded `InstrumentId` cast in the handler (compile-time only). The engine never re-parses the string. | The `submit_decision` schema already accepts colon/address-qualified IDs end-to-end. The real format gate is downstream in the actor intake (`swap.instrument_format` check + `instrumentCache.hasSymbol`), which Phase 2 replaces. |

## Non-Goals

- Multi-binding or cross-venue scanning by one agent.
- 1inch support outside Base in this release.
- Changing the public `submit_decision` schema. This is not merely a policy
  choice — it is verified safe: the exact scanner ID already passes every Zod
  boundary unchanged (see the schema-acceptance Scope Decision above). Phase 5
  adds a regression guard so this stays true.
- Changing manual plain `BASE/QUOTE` agent calls. They remain supported as a
  legacy path; scanner-generated decisions always use exact pairs.
- New dependencies or database migrations. The single new operator config flag
  (`agentRuntime.scanner.swap.enabled`) is not a migration.

## Required Invariants

1. A DEX candidate with no exact base address, canonical quote address, or pool
   address is skipped and journaled; it is never guessed.
2. A scanner uses only the binding's network and venue type.
3. Runtime maps that fetch, score, or persist candidates are keyed by the exact
   `instrumentId`, never the display symbol. Two tokens with the same ticker
   must not collide.
4. The pool identity is atomic: `poolAddress`, base token, and quote token come
   from the same discovered pool. Merge logic must not combine the address from
   one provider record with token sides from another.
5. A completed DEX signal must have exact `HybridPricingIdentity` or be removed
   before it can create a wake.
6. Every recurring scan reschedules after an error. Unsupported/malformed DEX
   candidates are observable as explicit scan outcomes, not silent empty scans.
7. Swap scanning is off unless `agentRuntime.scanner.swap.enabled` (and, when
   present, the per-venue flag) is true. Disabling the flag returns the system
   to today's no-swap-candidates behaviour with no code change.
8. Every skip, rejection, and empty/failed discovery emits a named, queryable
   event so a reviewer can distinguish "nothing qualified" from "provider
   failed" from "identity incoherent". Reserved event names:
   `scanner.swap_exit_unresolved`, `scanner.swap_candidate_skipped` (with a
   `reason` field: `missing_base_address` | `missing_quote_address` |
   `missing_pool_address` | `non_canonical_quote` | `incoherent_pool`),
   `scanner.swap_discovery_empty`, `scanner.swap_discovery_error`, and
   `scanner.incomplete_swap_identity`.

## Design

### Identity Types

Extend the shared scanner contracts with discriminated unions. Place the shared
identity definitions in `@herobids/domain`, which both the worker app and
`@herobids/strategy` already depend on (dependency direction:
`domain ← strategy ← apps/worker`). `HybridPricingIdentity` and
`SwapExecutionIdentity` belong there. The worker already imports
`ScannerCandleTarget` from `@herobids/strategy` today; move it (and the shared
swap identity types) to `@herobids/domain` and re-export from `@herobids/strategy`
if convenient, so no package gains a new dependency and no circular edge is
created. Do not define execution identity in the worker app.

```ts
export type ScannerCandleTarget =
  | { venueType: 'orderbook'; providerSymbol: string }
  | { venueType: 'swap'; network: string; poolAddress: string };

export interface SwapExecutionIdentity {
  network: string;
  baseSymbol: string;
  baseAddress: string;
  quoteSymbol: string;
  quoteAddress: string;
}

export interface SwapDiscoveredInstrument {
  venue: 'jupiter' | '1inch';
  venueType: 'swap';
  symbol: string;
  instrumentId: string;
  candleTarget: { venueType: 'swap'; network: string; poolAddress: string };
  pricingIdentity: {
    kind: 'dex';
    symbol: string;
    chain: string;
    address: string;
  };
  swapExecutionIdentity: SwapExecutionIdentity;
  volume24hUsd?: number;
  liquidityUsd?: number;
  priceChange24hPct?: number;
}
```

`DiscoveredInstrument`, `CandidateContext`, and `ScoredSignal` carry this
identity unchanged. `symbol` remains display-only.

### Atomic Pool Discovery Data

`DiscoveredToken` (in `packages/market-data/src/types.ts`) currently retains
`poolAddress` but not the quote token, and the merge process can select
individual fields from different source records. A coherent pool shape already
exists in the same file: `DiscoveredPool` (`poolAddress`, `network`,
`baseToken`, `quoteToken`, `priceUsd`, `volume24hUsd`, `liquidityUsd`). Reuse
it rather than defining a parallel shape. Add a single optional, atomic field
to `DiscoveredToken`:

```ts
// Reuses the existing DiscoveredPool interface; do NOT introduce a new type.
pool?: Pick<
  DiscoveredPool,
  'poolAddress' | 'network' | 'baseToken' | 'quoteToken'
>;
```

GeckoTerminal discovery populates this object atomically. Discovery merging
selects an *entire* `pool` object from one record; it never independently
merges pool address, base token, and quote token. Existing consumers that need
only a pool address read `pool?.poolAddress` during the transition, after which
the loose top-level `poolAddress` field is removed.

### Scan Keys and Exit Safety

`technical-phase.ts` currently keys candle maps and candidate matching by
`symbol` (`candleTargetBySymbol` and `openInstrumentIds` are both built from
`p.symbol` today). Change this to a stable scan key:

- entry candidates use `candidate.instrumentId`;
- positions use `position.instrumentId` — see the migration guard below;
- `SymbolFetchOutcome` gains `instrumentId` while retaining `symbol` for logs;
- the candle circuit-breaker key is generated from the full candle target
  (`orderbook:<providerSymbol>` or `swap:<network>:<poolAddress>`), never from
  `target.providerSymbol` alone (a swap target has no `providerSymbol`).

**Position identity migration guard.** Open positions are the risk here: the
scan key must not silently fall back to `symbol` for swap positions, or the
same-ticker collision returns. Before this change, confirm that persisted
position records carry a populated `instrumentId` (the direct-protection bug
report at `docs/bug-reports/2026/07/12/002-...` shows positions ending with
`instrumentId = null`). The rule is:

- orderbook positions may use `position.instrumentId ?? position.symbol`
  (their symbol *is* the exact venue identity);
- a swap position with a null/blank `instrumentId`, or an `instrumentId` that
  does not parse as an exact pair, is **not** scanned for exit. Skip it and
  emit `scanner.swap_exit_unresolved`. Never synthesize a candle target from a
  ticker.

## Implementation Phases

### Phase 0 - Lock Contracts and Test Fixtures [DONE]

**Files**

- `packages/domain/src/` (new/relocated shared identity types)
- `apps/worker/src/technical-phase.ts`
- `packages/strategy/src/scan-engine.ts`
- tests for all three modules

**Work**

1. Add the shared identity types (`ScannerCandleTarget` swap variant,
   `SwapExecutionIdentity`) to `@herobids/domain` and add swap variants to
   `DiscoveredInstrument`, `CandidateContext`, and `ScoredSignal`. Re-export
   from `@herobids/strategy` if convenient; create no new package dependency.
2. Add `SwapExecutionIdentity` and propagate it from candidate context to a
   scored signal.
3. Convert technical-phase maps, outcome records, and circuit-breaker keys to
   exact scan keys instead of symbols. The circuit-breaker key derives from the
   full candle target, not `target.providerSymbol`.
4. Implement the explicit skip-and-warning rule for unresolved legacy swap
   positions, and apply the position-identity migration guard (orderbook may
   fall back to `symbol`; swap must have an exact parsable `instrumentId`).

**Acceptance criteria**

- Two candidates with the same display symbol can fetch and score independently.
- A swap candidate can be represented without optional or inferred identity.
- A swap position with a null or non-exact `instrumentId` is skipped for exit
  scanning and emits `scanner.swap_exit_unresolved`; it never resolves to a
  ticker-derived candle target.
- Existing orderbook scanner tests pass unchanged in behaviour.

### Phase 1 - Preserve Pool Sides and Resolve Quote Policy [DONE]

**Files**

- `packages/market-data/src/types.ts`
- `packages/market-data/src/geckoterminal.ts`
- `packages/market-data/src/discovery.ts`
- `packages/domain/src/config/schema.ts`
- `apps/web/src/features/agents/technical-types.ts`
- `apps/web/src/features/agents/technical-config-helpers.ts`
- `apps/web/src/features/agents/TechnicalConfigSection.tsx`
- locale files and focused tests

**Work**

1. Preserve complete, atomic GeckoTerminal pool identity in discovery results
   by populating the `pool` object that reuses the existing `DiscoveredPool`
   shape (do not add a parallel type).
2. Add optional `technical.filters.quoteAssetSymbol`, default `USDC`. Existing
   persisted scanner configurations remain valid through the schema default.
3. Add the operator kill-switch to `config/schema.ts`:
   `agentRuntime.scanner.swap.enabled` (default `false`) and optional
   `agentRuntime.scanner.swap.venues.{jupiter,1inch}` per-venue booleans.
4. Resolve the effective quote asset in worker startup from
   `appConfig.marketData.tokenSafety.canonicalTokens[network]`.
5. Reject scanner startup for a swap-bound agent when its binding network is
   unresolved, the configured `filters.networks` excludes that network, or the
   selected quote key is absent from that network's canonical-token map. The
   rejection is a single, named, observable startup error — not a silent idle.
6. Add a swap-only quote-asset selector in the technical configuration UI. The
   API remains authoritative: UI options are a convenience, not validation.

**Operational note (canonicalTokens migration).** Today a misconfigured swap
agent sits idle; after item 5 it fails scanner startup loudly. Before landing
this phase, confirm `marketData.tokenSafety.canonicalTokens.solana` and
`.base` are populated in every deployment's operator config, so enabling the
feature does not convert idle agents into hard startup failures.

**Acceptance criteria**

- A Solana or Base pool exposes both exact token addresses after discovery via
  the reused `DiscoveredPool` shape.
- An agent can select only a canonical quote asset for its bound network.
- Current scanner-gated agents without a quote selection resolve to USDC.
- A swap agent whose network lacks canonical tokens fails startup with one
  named error, observable in logs.

### Phase 2 - Exact Swap Parsing and Intake Validation [DONE]

**Files**

- `apps/worker/src/resolve-swap-assets.ts` or new `swap-instrument-id.ts`
- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/agents/agent-intake-resolver.ts`
- `apps/worker/src/venue-instrument-cache.ts` or new validator module
- focused unit tests

**Work**

1. Add a single `parseSwapInstrumentId()` implementation that accepts:
   - `BASE/QUOTE`;
   - `BASE:BASE_ID/QUOTE`;
   - `BASE:BASE_ID/QUOTE:QUOTE_ID`.
2. Return display symbols and both asset IDs. Exact scanner IDs must contain
   both IDs; legacy forms can use only a configured canonical default quote.
3. Make `buildSwapDecisionMetadata()` use parsed `baseAsset` and `quoteAsset`;
   it must no longer drop `QUOTE_ID`.
4. Add `validateTradeInstrument()`:
   - orderbook reuses current cache checks;
   - Jupiter validates exact base and quote addresses against the ready Jupiter
     token cache;
   - 1inch validates exact EVM address syntax, resolved Base network, and the
     canonical quote address, without requiring the base in a curated cache.
   This supersedes the current `hasSymbol()` fail-open behaviour for 1inch:
   structural validation now fires where the uncached venue previously passed
   through. Do not reintroduce fail-open for 1inch.
5. Replace raw `instrumentCache.hasSymbol()` calls in both the actor
   (`agent-trading-actor.ts`) and the fallback intake path
   (`agent-intake-resolver.ts`) with `validateTradeInstrument()`.
6. Normalize the binding contract passed to `resolveSwapNetwork`. Decision:
   keep the resolver's existing `BindingLike.bindingProfile` field (it is
   already the contract in `resolve-swap-assets.ts`) and make all call sites
   pass `bindingProfile` consistently; do not introduce a second `profile`
   spelling. Add a regression test proving a binding-specific 1inch `chainId`
   overrides operator defaults.

**Acceptance criteria**

- `BONK:<mint>/USDC:<mint>` reaches Jupiter with both exact mints, and
  `buildSwapDecisionMetadata()` preserves the quote address (no `QUOTE_ID`
  drop).
- `WETH:<address>/USDC:<address>` reaches 1inch with both exact addresses.
- Malformed or wrong-network pairs are rejected before execution.
- Regression guard: `DecisionSubmitPayloadSchema` (and
  `SubmitDecisionParamsSchema`) accept the exact `BASE:ADDR/QUOTE:ADDR` ID
  unchanged, and the exact ID clears the `swap.instrument_format` check and the
  new `validateTradeInstrument()` — not the removed `hasSymbol()` path.

### Phase 3 - Swap Candidate Discovery and Candle Routing [DONE]

**Files**

- `apps/worker/src/scanner-candidate-discovery.ts`
- `apps/worker/src/scanner-candle-fetcher.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/technical-phase.ts`
- `config/default.yaml` (flag default)
- focused worker tests

**Work**

1. Extend `buildDiscoverCandidates()` for `venueType: 'swap'`; do not return an
   empty closure for the supported Jupiter and 1inch bindings. Gate this behind
   the operator flag: when `agentRuntime.scanner.swap.enabled` is false (or the
   per-venue flag is false), keep returning no candidates — identical to the
   current `return []` behaviour, so the change is a no-op until enabled.
2. Invoke `registry.discovery.discover()` with exactly the resolved binding
   network, then select pool-backed candidates whose pool quote token equals
   the resolved canonical quote address.
3. Apply existing minimum volume, minimum liquidity, symbol allowlist, and
   exclude-symbol filters. Deduplicate by `network:poolAddress`, sort
   deterministically, and cap with existing scanner capacity.
4. Emit the exact display, instrument, candle, pricing, and swap-execution
   identities. Skip candidates with missing or incoherent pool identity and
   emit `scanner.swap_candidate_skipped` with the specific `reason`.
5. Replace orderbook-only scanner candle routing with explicit target routing.
   The scanner candle fetcher must accept the `ScannerCandleTarget` union and
   construct `VenueCandleFetcher` with GeckoTerminal config for swap targets
   (it currently hard-codes `null` GeckoTerminal config and `'orderbook'`).
   Use cached provider-registry calls where practical: Binance for orderbook
   and GeckoTerminal candles for swap. Preserve the scanner-specific rate
   budget.
6. Extend candle error classification to distinguish a missing DEX pool from
   transient provider/rate-limit failures. Do not apply Binance-specific HTTP
   assumptions to GeckoTerminal errors. Empty discovery emits
   `scanner.swap_discovery_empty`; a provider failure emits
   `scanner.swap_discovery_error`.

**Acceptance criteria**

- With the flag off, swap bindings produce no candidates (byte-for-byte the
  current behaviour); with it on, Jupiter scans Solana pools and 1inch scans
  Base pools only.
- A non-USDC pool is not silently treated as a USDC execution pair.
- Swap OHLCV requests use the candidate's exact network and pool address.
- Empty or invalid discovery data yields explicit, named scanner health/journal
  events, not a silent empty scan.

### Phase 4 - Completion, Pricing, and Persistence [PENDING]

**Files**

- `apps/worker/src/complete-technical-scan.ts`
- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/hybrid-agent-evaluator.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/hybrid-decision-sizing.ts`
- focused tests

**Work**

1. Enforce that a swap `go_long` signal has exact `pricingIdentity` and
   `swapExecutionIdentity` before it enters completed scan state or emits a
   scanner wake.
2. Keep the hybrid prompt display-oriented; resolve LLM output by display
   symbol only to the matched signal's exact `instrumentId` and pricing
   identity.
3. Continue hybrid USD sizing with the scanner-resolved DEX `chain + address`.
   Reject stale or unavailable repricing instead of falling back to a bare
   ticker lookup.
4. Update persisted scanner candidate fields to record `instrumentKind: 'dex'`,
   network, base address, and exact raw candidate ID.
5. Replace the orderbook-only `SYMBOL-PERP` mark-coverage persistence filter.
   It must either price the scanner's exact DEX identity via `priceService`, or
   persist the observation without an incorrect CoinGecko symbol check.
   Candidate persistence must not suppress an otherwise executable DEX signal.

**Acceptance criteria**

- A scanner wake presents `BONK/USDC`, but submits the exact qualified pair.
- DEX sizing receives the selected token's exact Solana/Base identity.
- Persisted candidates do not mislabel DEX data as orderbook data.

### Phase 5 - Verification and Rollout [PENDING]

**Unit and integration coverage**

- atomic pool identity through GeckoTerminal mapping and discovery merge;
- canonical quote-policy resolution and invalid network/quote rejection;
- exact and legacy swap-pair parser behaviour;
- Jupiter and 1inch validation paths;
- symbol-collision isolation in technical phase;
- Jupiter and 1inch discovery filtering, deduplication, and exact identity;
- orderbook versus swap candle routing and provider-specific error outcomes;
- completed-scan rejection for identity-incomplete swap signals;
- hybrid evaluator submission of exact IDs and pricing identities;
- unresolved swap exit positions skip safely and visibly;
- schema regression guard: `DecisionSubmitPayloadSchema` and
  `SubmitDecisionParamsSchema` accept the exact `BASE:ADDR/QUOTE:ADDR` ID, and
  the ID clears `swap.instrument_format` + `validateTradeInstrument()`;
- operator flag off → swap bindings yield no candidates (unchanged behaviour);
  flag on → discovery runs.

**Commands**

```sh
pnpm --filter @herobids/market-data test
pnpm --filter @herobids/strategy test
pnpm --filter @herobids/worker test
pnpm lint
```

**Manual staging matrix**

| Scenario | Expected result |
|---|---|
| Jupiter-bound scanner-gated agent | Solana USDC-quoted pool candidates, GeckoTerminal candles, scanner wake, exact mint-pair submission |
| 1inch Base-bound scanner-gated agent | Base USDC-quoted pool candidates, GeckoTerminal candles, scanner wake, exact EVM-pair submission |
| 1inch binding with unsupported network | Agent scanner fails visibly before scan scheduling |
| Pool lacks base/quote/pool identity | Candidate is skipped and journaled |
| Duplicate display tickers | Separate candidates, candle results, and exact decisions |
| Legacy swap position lacks qualified pair | Exit scan skipped with warning; no guessed candle target |
| Operator flag `agentRuntime.scanner.swap.enabled=false` | Jupiter/1inch agents produce no scanner candidates (matches pre-feature behaviour) |
| Swap agent on network with no canonical tokens | Scanner startup fails with one named error before scheduling |

## Rollout Order

1. Land Phases 0 through 2 with all focused tests; DEX candidate discovery
   stays disabled (swap bindings still return no candidates).
2. Land Phase 3 with `agentRuntime.scanner.swap.enabled=false` (default). The
   code path exists but is dormant — no swap agent behaviour changes on deploy.
3. Enable Jupiter first via `agentRuntime.scanner.swap.venues.jupiter=true`
   (with `enabled=true`) and run the Jupiter staging matrix.
4. Enable 1inch (`agentRuntime.scanner.swap.venues.1inch=true`) only after the
   Base matrix passes.
5. Land Phase 4 and verify the end-to-end hybrid path in shadow mode before
   enabling scanner-gated trading. If any anomaly appears at any step, set the
   flag back to false — no code revert required.
6. Update the original pending scanner-data-wiring document and the July Part 2
   plan to point to this implementation plan, then record the change in the
   changelog.

## Definition of Done

- All four supported venues produce scanner data for agents bound to them.
- Jupiter and 1inch scanner-generated entries have exact execution, candle, and
  pricing identities from discovery through venue submission.
- No DEX identity is reconstructed from a bare ticker or inferred from a pool
  address heuristic.
- Swap scanner failures are observable via named events, fail safely, and do
  not stall the scan loop.
- Swap scanning is controlled by `agentRuntime.scanner.swap.enabled` (and the
  per-venue flags); disabling it restores pre-feature behaviour with no revert.
- The public `submit_decision` schema is unchanged and verified to accept the
  exact `BASE:ADDR/QUOTE:ADDR` ID; a regression test guards this.
- Targeted tests, worker tests, and `pnpm lint` pass.

---

## Outstanding Issues

### [Phase 0] MEDIUM-5 — Circuit breaker state silently resets on deploy
Breaker keys changed from `scanner:candle-breaker:{agentId}:{BTC}` to `scanner:candle-breaker:{agentId}:{orderbook:BTC}`. Old keys linger in Redis until TTL expiry. Breakers effectively reset on deploy — document in deploy notes.

### [Phase 0] LOW-2 — Redundant `venueType` spread in `normalizeScannerCandidates`
After early return for non-orderbook candidates, the spread `{ ...candidate.candleTarget, venueType: 'orderbook' as const }` re-declares `venueType` redundantly. Not harmful (helps TypeScript narrowing) but may confuse readers.

### [Phase 0] LOW-3 — `symbolsSelected` / `symbolOutcomes` naming in `TechnicalPhaseResult`
These fields now hold instrument IDs, not symbols. Renaming would be a breaking API change — defer to a future major version.

### [Phase 1] MEDIUM-3 — Hardcoded quote asset options in UI
The quote asset `<select>` hardcodes USDC/USDT options. The plan says options come from `canonicalTokens[network]` keys. Hardcoding works for initial release (Solana/Base have both) but won't show new canonical tokens. Defer to follow-up.

### [Phase 1] LOW-6 — Redundant `?? 'USDC'` after Zod default
`quoteAssetSymbol ?? 'USDC'` is redundant since Zod schema applies `.default('USDC')`. Harmless as defensive code, but an empty string would not be caught by `??`. Trust Zod default or switch to `||`.

### [Phase 2] MEDIUM-4 — `parseSwapInstrumentId` throws instead of returning Result
Per AGENTS.md, public APIs should return `Result<T, E>`. Currently throws `SwapInstrumentParseError`. Added `// TODO(Phase 5)` comment. All callers use try/catch. Convert in a future phase.

### [Phase 2] LOW-6 — Inconsistent `isVenueReady` check in `validateJupiterLegacy`
`validateJupiterExact` and `validateJupiterBaseQualified` check `isVenueReady('jupiter')` but `validateJupiterLegacy` only checks `isReady()`. Functionally equivalent (fail-open for degraded venues) but stylistically inconsistent.

### [Phase 2] LOW-7 — Missing 1inch-specific malformed instrument ID test
Malformed ID tests only cover `'jupiter'`. Add parallel `'1inch'` test.

### [Phase 2] LOW-8 — No direct unit tests for `buildSwapDecisionMetadata`
Tested only indirectly. Extract into testable pure function or add integration tests.

### [Phase 3] LOW-1 — Multiple `t.pool!` non-null assertions in discovery loop
After `poolBackedTokens.filter((t) => t.pool)`, the code uses `t.pool!` throughout. A cleaner pattern: extract `const pool = token.pool` with a defensive continue. Purely stylistic.

### [Phase 3] LOW-2 — IIFE for `swapQuoteAssetAddress` reduces readability
7-line inline IIFE in AgentTradingActor constructor. Extract to named helper function.

### [Phase 3] LOW-3 — `binanceConfig` passed to swap `VenueCandleFetcher` unnecessarily
Swap fetcher doesn't use binanceConfig. Verify if constructor requires it or if null can be passed.

### [Phase 3] LOW-4 — No unit test for HTTP 404 → `unsupported` classification
`classifyCandleError` now handles HTTP 404 as GeckoTerminal-specific. Add test.

### [Phase 3] LOW-5 — `minLiquidityUsd` double-applied
Applied at discovery source level AND post-identity filter. Defensive but redundant if discovery API supports it.

### [Phase 3] LOW-6 — YAML key `1inch` should be quoted
Numeric-starting key in YAML. Quote for safety: `'1inch': true`.

### [Phase 3] LOW-7 — Plan mark as DONE for Phase 2 (bookkeeping)
Unrelated to Phase 3 changes. Was from prior merge.