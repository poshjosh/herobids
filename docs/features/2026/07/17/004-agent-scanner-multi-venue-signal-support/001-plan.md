# 004 — Agent Scanner Multi-Venue Signal Support

**Status:** Planned  
**Created:** 2026-07-17  
**Depends on:** [002-hybrid-agent-redesign](../../06/22/002-hybrid-agent-redesign/001-plan.md) (implemented), [002-hybrid-usd-to-base-size-conversion](../002-hybrid-usd-to-base-size-conversion/001-plan.md) (implemented, but currently Hyperliquid-centric in its scan identity assumptions)

## Problem

We want agents to receive scanner-generated trading signals for **all supported
trading venues**, not just Hyperliquid perps.

Today that is not true.

The current agent scanner path is still effectively hard-wired to one venue
shape:

- `apps/worker/src/index.ts` `discoverCandidates()` always reads
  `sharedMarketDataRegistry.hyperliquid.assetContexts()`
- `apps/worker/src/index.ts` scanner candle fetches are wired as
  orderbook/Binance-only (`VenueCandleFetcher(..., null, 'orderbook')`)
- `apps/worker/src/technical-phase.ts` candidate and fetch contracts are
  symbol-only (`symbol: string`, `instrumentId: string`), so exact DEX identity
  cannot survive the scan pipeline
- `packages/strategy/src/scan-engine.ts` `CandidateContext` / `ScoredSignal`
  have no venue/network/address identity fields
- `apps/worker/src/complete-technical-scan.ts` hardcodes every pricing identity
  to `{ kind: 'perps', chain: 'hyperliquid' }`
- `packages/market-data/src/price-service.ts` only has execution-mark logic for
  Hyperliquid; Bybit orderbook signals would not have a venue-correct hybrid
  USD-sizing price source
- swap venues currently require `BASE/QUOTE`-style trade instruments at intake,
  but scanner/discovery identity is token/pool based; there is no explicit,
  end-to-end contract that turns a DEX discovery result into a precise,
  executable swap instrument without guessing

This means the system can currently do the following:

- hybrid/scanner_gated agents on Hyperliquid: yes
- bot strategies on swap venues: yes, because bots use their own per-bot candle
  fetch path rather than the agent scanner pipeline
- hybrid/scanner_gated agents on Bybit/Jupiter/1inch: no, not end-to-end

## Goal

Allow any hybrid agent with a valid active trading binding to receive technical
scanner signals for the venue it is actually bound to, across the full set of
currently supported trading venues:

- Hyperliquid
- Bybit
- Jupiter
- 1inch

That includes:

- venue-correct candidate discovery
- venue-correct candle fetching for signal generation
- exact identity preservation for swap assets
- venue-correct hybrid USD-to-base sizing before submission
- venue-correct executable `instrumentId` values for scanner-generated
  submissions

## Non-Goals

- Do not redesign bot strategy execution. Bots already use a separate path and
  are not the problem being solved here.
- Do not make one agent trade across multiple active bindings in a single
  session. This plan assumes the current one-active-trading-binding model.
- Do not redesign the public `submit_decision` tool schema for manual agent
  turns.
- Do not switch the entire strategy layer to venue-native OHLCV sources for
  orderbook venues. This plan preserves the current orderbook candle policy and
  only makes it venue-complete.
- Do not attempt cross-venue arbitrage, pair trading, or shared multi-venue
  portfolio reasoning.

## Supported Scope

This plan defines support for the following agent scanner combinations:

| Venue | Venue type | Scanner candidate source | Candle source | Hybrid sizing source |
|---|---|---|---|---|
| Hyperliquid | `orderbook` | Hyperliquid asset contexts | existing orderbook candle path | Hyperliquid execution mark via `priceService` |
| Bybit | `orderbook` | new Bybit tickers provider | existing orderbook candle path | new Bybit execution ticker/mark path via `priceService` |
| Jupiter | `swap` | shared discovery pipeline (`solana`) | GeckoTerminal pools | DexScreener/price-service using exact chain + address |
| 1inch | `swap` | shared discovery pipeline (binding/operator-resolved EVM network) | GeckoTerminal pools | DexScreener/price-service using exact chain + address |

## Key Decision

### “All supported venues” means venue completeness across the platform, not one agent scanning all venues at once

The scanner must honor the agent’s active trading binding and `technical.filters`
instead of assuming Hyperliquid. A Jupiter-bound agent scans Jupiter-relevant
DEX assets. A Bybit-bound agent scans Bybit-relevant perp instruments. The
system does **not** merge multiple venue universes into one scan for a single
agent session in this phase.

That keeps the implementation aligned with the current execution model:

- one active trading grant
- one active venue account
- one actor execution context

## Design

### 1. Introduce an explicit scanner identity model

The current `symbol + instrumentId` model is not sufficient.

We need one candidate object that carries all three identities that the system
actually uses:

1. **Display identity** — what the prompt and logs show
2. **Execution identity** — what gets submitted to decision intake
3. **Market-data identity** — what the scanner uses for candles and what the
   hybrid path uses for repricing

Add the following explicit types.

#### In `apps/worker/src/technical-phase.ts`

```ts
export interface ScannerCandleTarget {
  venueType: 'orderbook' | 'swap';
  providerSymbol?: string;
  network?: string;
  poolAddress?: string;
}

export interface SwapExecutionIdentity {
  network: string;
  baseSymbol: string;
  baseAddress: string;
  quoteSymbol: string;
  quoteAddress: string;
}

export interface DiscoveredInstrument {
  venue: string;
  venueType: 'orderbook' | 'swap';
  symbol: string;
  instrumentId: string;
  candleTarget: ScannerCandleTarget;
  pricingIdentity: {
    kind: 'perps' | 'dex';
    symbol: string;
    chain?: string;
    address?: string;
  };
  swapExecutionIdentity?: SwapExecutionIdentity;
  volume24hUsd?: number;
  liquidityUsd?: number;
  priceChange24hPct?: number;
}
```

#### In `packages/strategy/src/scan-engine.ts`

```ts
export interface CandidateContext {
  symbol: string;
  instrumentId: string;
  candles: PriceCandle[];
  venue?: string;
  venueType?: 'orderbook' | 'swap';
  candleTarget?: ScannerCandleTarget;
  pricingIdentity?: HybridPricingIdentity;
  swapExecutionIdentity?: SwapExecutionIdentity;
  meta?: {
    volume24hUsd?: number;
    liquidityUsd?: number;
    priceChange24hPct?: number;
  };
}

export interface ScoredSignal {
  symbol: string;
  instrumentId: string;
  venue?: string;
  venueType?: 'orderbook' | 'swap';
  pricingIdentity?: HybridPricingIdentity;
  swapExecutionIdentity?: SwapExecutionIdentity;
  confidence: number;
  reasons: string[];
  intent: 'go_long' | 'go_short';
  indicators: { ... }
}
```

Rule:

- `symbol` stays human-readable
- `instrumentId` must be execution-correct
- `pricingIdentity` must always be exact enough for hybrid sizing
- `candleTarget` must always be exact enough to fetch the intended OHLCV series

### 2. Standardize scanner-generated swap instrument IDs as exact address-qualified pairs

The swap execution path cannot safely rely on bare ticker symbols when the
scanner itself already knows exact token identity.

Scanner-generated swap signals must therefore use an internal, exact,
address-qualified `instrumentId` format:

```text
<BASE_SYMBOL>:<BASE_ASSET_ID>/<QUOTE_SYMBOL>:<QUOTE_ASSET_ID>
```

Examples:

- Jupiter: `BONK:DezXAZ8z7PnrnRJjz3wXBoRgixCa6eZJ6B9w3vJ8X4x/USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- 1inch Base: `WETH:0x4200000000000000000000000000000000000006/USDC:0x833589fCD6eDb6C08f4c7C32D4f71b54bdA02913`

Why this is required:

- same-symbol fakes exist on the same network
- `priceService` for DEX repricing already needs exact chain + address
- swap execution adapters ultimately quote against exact asset IDs, not human
  tickers
- legacy plain `BASE/QUOTE` strings do not carry enough identity to guarantee
  scanner correctness

This is an internal scanner/runtime format. The prompt can still display
`BONK/USDC` while carrying the exact `instrumentId` internally.

### 3. Extend swap instrument parsing to support exact quote-side identity too

Current swap parsing only extracts the base-side `:address` suffix.

That is not sufficient for scanner-generated swap signals because the quote side
must also be explicit.

Update the parsing contract in:

- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/agents/agent-intake-resolver.ts`
- `apps/worker/src/resolve-swap-assets.ts` or a new dedicated parser module

Required behavior:

- accept `BASE/QUOTE`
- accept `BASE:BASE_ID/QUOTE`
- accept `BASE:BASE_ID/QUOTE:QUOTE_ID`
- when `:QUOTE_ID` is present, preserve it all the way through to execution

Suggested helper:

```ts
export interface ParsedSwapInstrument {
  displayBaseSymbol: string;
  displayQuoteSymbol: string;
  baseAssetId: string;
  quoteAssetId: string;
}

export function parseSwapInstrumentId(
  instrumentId: string,
  defaultQuoteAssetId?: string,
): ParsedSwapInstrument | null;
```

Rules:

- scanner-generated decisions must always use the fully-qualified form
- legacy manual agent tool calls may still use `BASE/QUOTE`, but that is not the
  scanner contract
- if the scanner lacks enough identity to produce a fully-qualified swap
  `instrumentId`, it must skip the candidate rather than guess

### 4. Replace symbol-only swap validation with venue-aware trade-instrument validation

Current symbol validation is not sufficient for swap venues.

Today:

- Jupiter cache warmup stores token **addresses** from the token list
- the agent execution path validates the full incoming `instrumentId` as though
  it were a single raw symbol string

That is incompatible with pair-style swap instruments and would reject valid
scanner-generated swap signals.

Add a new helper, for example in `apps/worker/src/venue-instrument-cache.ts` or
in a new `apps/worker/src/validate-trade-instrument.ts`:

```ts
export function validateTradeInstrument(params: {
  venue: string;
  venueType: 'orderbook' | 'swap';
  instrumentId: string;
  instrumentCache?: VenueInstrumentCache;
}): { ok: true } | { ok: false; code: string; message: string };
```

Rules:

- orderbook venues: reuse existing cache validation
- Jupiter: parse the swap pair, validate base and quote asset IDs individually
  against the Jupiter token cache
- 1inch: parse the swap pair and validate structural correctness plus resolved
  network; do not hard-block on the current curated address list because that
  list is intentionally incomplete

Replace raw `instrumentCache.hasSymbol(...)` checks in:

- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/agents/agent-intake-resolver.ts`

### 5. Add venue-complete candidate discovery

The scanner currently ignores `filters.venue` and `filters.venueType` in
practice. That must stop.

Extract scanner discovery from `apps/worker/src/index.ts` into a dedicated,
testable module:

```ts
export async function discoverScannerCandidates(params: {
  registry: ProviderRegistry;
  filters: FilterConfig;
  bindingVenue: string;
  bindingVenueType: 'orderbook' | 'swap';
  swapNetwork?: string;
  swapQuoteAsset?: { symbol: string; assetId: string };
  maxCandidates: number;
}): Promise<DiscoveredInstrument[]>;
```

#### Venue-specific discovery rules

##### Hyperliquid

Source:

- `registry.hyperliquid.assetContexts()`

Mapping:

- `symbol`: base ticker, e.g. `BTC`
- `instrumentId`: existing Hyperliquid execution instrument form already used by
  the agent path
- `candleTarget.providerSymbol`: base ticker / existing orderbook candle symbol
- `pricingIdentity`: `{ kind: 'perps', symbol: <asset>, chain: 'hyperliquid' }`

##### Bybit

Source:

- **new** `registry.bybit.tickers()` provider, backed by Bybit linear tickers

Mapping:

- `symbol`: human-readable base ticker or pair display
- `instrumentId`: the actual tradable venue instrument the execution path uses
  (must match the instrument repository / adapter contract, not an invented
  approximation)
- `candleTarget.providerSymbol`: orderbook candle symbol
- `pricingIdentity`: `{ kind: 'perps', symbol: <venue symbol or resolved base>, chain: 'bybit' }`

Important:

- do **not** invent a Bybit `instrumentId` string ad hoc in the scanner
- resolve it through the same canonical venue symbol contract used elsewhere
  (instrument table / adapter market metadata)

##### Jupiter

Source:

- `registry.discovery.discover({ networks: ['solana'], ... })`

Required candidate fields:

- `symbol`: `<BASE_SYMBOL>/<QUOTE_SYMBOL>` for prompt display
- `instrumentId`: address-qualified pair format
- `candleTarget`: `{ venueType: 'swap', network: 'solana', poolAddress: <token.poolAddress> }`
- `pricingIdentity`: `{ kind: 'dex', symbol: <base symbol>, chain: 'solana', address: <base token address> }`
- `swapExecutionIdentity`: `{ network: 'solana', baseSymbol, baseAddress, quoteSymbol, quoteAddress }`

Hard requirement:

- if discovery did not yield `poolAddress` or exact base token address, skip the
  candidate

##### 1inch

Source:

- `registry.discovery.discover({ networks: [resolvedSwapNetwork], ... })`

Required candidate fields are the same as Jupiter, except network is the active
  binding / operator-resolved 1inch network.

Hard requirement:

- if `resolveSwapNetwork(...)` returns `undefined`, the scanner for that agent
  must fail closed at startup rather than silently downgrade to a wrong network

### 6. Introduce explicit swap quote-asset policy for scanner-generated DEX signals

One discovered DEX token can appear in many pools and quote pairs. The scanner
must map each entry signal to exactly one executable pair.

Do **not** guess the quote side from whatever pool happened to rank highest.

Add operator config for scanner quote-asset policy, for example under
`marketData.scanner.swapQuoteAssets`:

```yaml
marketData:
  scanner:
    swapQuoteAssets:
      solana:
        symbol: USDC
        assetId: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
      base:
        symbol: USDC
        assetId: 0x833589fCD6eDb6C08f4c7C32D4f71b54bdA02913
      arbitrum:
        symbol: USDC
        assetId: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
      optimism:
        symbol: USDC
        assetId: 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85
      ethereum:
        symbol: USDC
        assetId: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
      polygon:
        symbol: USDC
        assetId: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
```

Scanner rule:

- every DEX entry candidate is normalized to the configured canonical quote
  asset for its network
- if the operator has not configured a quote asset for a supported swap network,
  scanner startup for that venue must fail loudly

This is operator policy, not per-agent config.

### 7. Change the technical scan candle contract from raw symbol strings to explicit candle targets

Current contract:

```ts
fetchCandles(symbol: string, interval: string, limit: number)
```

This is not enough for DEX scanning because the same symbol can exist on many
chains and many pools.

Change `TechnicalPhaseDeps` in `apps/worker/src/technical-phase.ts` to:

```ts
fetchCandles(target: ScannerCandleTarget, interval: string, limit: number): Promise<PriceCandle[]>;
```

Then update `runTechnicalPhase()`:

- entry candidates use `candidate.candleTarget`
- open-position exit evaluation resolves a `ScannerCandleTarget` from the open
  position’s instrument identity

#### Exit-scan rule for swap positions

For swap positions, exit scanning is only safe when the open position’s
`instrumentId` can be parsed back into an exact address-qualified pair and the
network is known from the actor binding.

If not, skip exit scanning for that position and log a structured warning.

No compatibility fallback is required here.

### 8. Route scanner candles by venue type

Add a dedicated scanner candle router instead of reusing the current
Hyperliquid-only worker helper.

Suggested module:

```ts
export function createScannerCandleFetcher(params: {
  binanceConfig: BinanceCandlesConfig;
  geckoTerminalConfig: GeckoTerminalConfig;
  scannerRateLimiter: TokenBucketRateLimiter;
}): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>;
```

Rules:

- orderbook targets -> existing orderbook candle path
- swap targets -> GeckoTerminal using `network + poolAddress`
- if a swap target lacks `network` or `poolAddress`, fail closed

Do not rely on string-length heuristics to infer pool-vs-symbol in the agent
scanner path. The target object must already tell the fetcher what it is.

### 9. Extend `priceService` to support Bybit orderbook signals

The current `priceService` only has execution-mark logic for Hyperliquid.

That is insufficient once Bybit scanner signals are introduced because hybrid
USD-to-base sizing must be venue-correct.

#### Required changes

##### `packages/market-data/src/bybit-tickers.ts` (new)

Add a typed provider for Bybit linear tickers.

Suggested return type:

```ts
export interface BybitTicker {
  symbol: string;
  markPrice: number | null;
  lastPrice: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
}
```

##### `packages/market-data/src/provider-registry.ts`

Add:

```ts
bybit: {
  tickers(): ...
  longShortRatio(...): ...
}
```

##### `packages/market-data/src/price-service.ts`

Add a `resolveBybitTarget()` branch and update source selection:

- `hyperliquid` -> execution mark -> oracle -> cache
- `bybit` -> bybit ticker/mark -> cache
- DEX networks -> DexScreener -> cache

Rules:

- Bybit scanner-generated `pricingIdentity.chain` must be `'bybit'`
- hybrid sizing for Bybit must reject stale ticker results the same way the DEX
  sizing path rejects stale prices

### 10. Preserve exact pricing identity through scan completion

Stop synthesizing pricing identity in `apps/worker/src/complete-technical-scan.ts`.

Instead:

- read `signal.pricingIdentity` from `TechnicalPhaseResult.signals`
- build `TechnicalScanState.pricingIdentities[instrumentId]` from the actual
  signal data
- if a `go_long` signal lacks `pricingIdentity`, do not publish it into the
  completed scan state

This preserves the exact identity determined during candidate discovery and
avoids re-derivation drift.

### 11. Keep the prompt human-readable while keeping execution exact

The hybrid prompt should continue to show clean symbols, not address dumps.

Rule:

- `signal.symbol` is prompt-facing and human-readable, e.g. `BONK/USDC`
- `signal.instrumentId` is internal and exact, e.g.
  `BONK:<mint>/USDC:<mint>`
- `runHybridEvaluator()` may continue resolving LLM responses by `symbol`, then
  submitting the matched signal’s exact `instrumentId`

That means the LLM does not need to emit long address-qualified strings in its
response.

## Implementation

### Phase 1 — Shared types and exact swap instrument parsing

#### Files

| File | Action |
|---|---|
| `apps/worker/src/technical-phase.ts` | Extend `DiscoveredInstrument` and `TechnicalPhaseDeps.fetchCandles` contract |
| `packages/strategy/src/scan-engine.ts` | Extend `CandidateContext` / `ScoredSignal` with venue-aware identity fields |
| `apps/worker/src/agent-trading-actor.ts` | Replace ad hoc swap parsing with explicit parser supporting quote-side asset IDs |
| `apps/worker/src/agents/agent-intake-resolver.ts` | Parse exact swap instrument identity consistently |
| `apps/worker/src/resolve-swap-assets.ts` or new parser file | Add `parseSwapInstrumentId()` |

#### Acceptance criteria

- scanner-generated swap instrument IDs can carry both base and quote asset IDs
- the execution path can parse them without guessing
- no raw scanner logic depends on bare `symbol: string` for swap identity

### Phase 2 — Venue-complete market-data providers

#### Files

| File | Action |
|---|---|
| `packages/market-data/src/bybit-tickers.ts` (new) | Implement linear tickers provider |
| `packages/market-data/src/provider-registry.ts` | Add `bybit.tickers()` and config wiring |
| `packages/market-data/src/types.ts` | Add `BybitTicker` types / config additions as needed |
| `packages/market-data/src/price-service.ts` | Add Bybit execution-price resolution |
| `config/default.yaml` | Add Bybit ticker config and scanner swap-quote config |
| `apps/worker/src/config.ts` / schema files as needed | Wire operator config into the resolved config object |

#### Acceptance criteria

- provider registry can fetch Bybit tickers with rate limiting and cache policy
- `priceService.resolvePriceTarget(..., 'bybit', ...)` works
- operator config fully describes swap quote assets per supported network

### Phase 3 — Extract scanner discovery and candle routing into explicit modules

#### Files

| File | Action |
|---|---|
| `apps/worker/src/index.ts` | Remove inline Hyperliquid-only `discoverCandidates` / `fetchCandles` scanner helpers |
| `apps/worker/src/scanner-candidate-discovery.ts` (new) | Implement venue-aware discovery |
| `apps/worker/src/scanner-candle-fetcher.ts` (new) | Implement venue-aware candle routing from `ScannerCandleTarget` |
| `apps/worker/src/agent-trading-actor.ts` | Use the new helpers via injected deps |

#### Discovery behavior by venue

- Hyperliquid -> asset contexts
- Bybit -> new tickers provider
- Jupiter -> discovery pipeline on `solana`
- 1inch -> discovery pipeline on resolved EVM network

#### Acceptance criteria

- scanner discovery respects `filters.venue` and `filters.venueType`
- swap candidate discovery emits exact execution/pricing/candle identity
- orderbook and swap candle targets are fetched by the correct provider path

### Phase 4 — Fix trade-instrument validation for swap venues

#### Files

| File | Action |
|---|---|
| `apps/worker/src/venue-instrument-cache.ts` or new helper | Add venue-aware `validateTradeInstrument()` |
| `apps/worker/src/agent-trading-actor.ts` | Replace raw `instrumentCache.hasSymbol()` check |
| `apps/worker/src/agents/agent-intake-resolver.ts` | Replace raw `instrumentCache.hasSymbol()` check |

#### Acceptance criteria

- Jupiter scanner-generated address-qualified pairs are accepted
- 1inch scanner-generated address-qualified pairs are structurally validated and
  not rejected because of the intentionally incomplete curated token list
- orderbook validation remains unchanged

### Phase 5 — Preserve exact scan identity into hybrid evaluation and sizing

#### Files

| File | Action |
|---|---|
| `apps/worker/src/complete-technical-scan.ts` | Stop hardcoding Hyperliquid pricing identity |
| `apps/worker/src/runtime-composition.ts` | Ensure `TechnicalScanState.pricingIdentities` remains the scanner-resolved source of truth |
| `apps/worker/src/hybrid-agent-evaluator.ts` | Continue passing exact `pricingIdentity` from the matched signal |
| `apps/worker/src/hybrid-decision-sizing.ts` | Accept Bybit and DEX identities without Hyperliquid-only assumptions |

#### Acceptance criteria

- Hyperliquid, Bybit, Jupiter, and 1inch scanner signals all carry exact hybrid
  pricing identity to submission time
- no scanner-completed signal gets a synthetic fallback pricing identity

### Phase 6 — Tests and verification

#### New / updated tests

| File | Coverage |
|---|---|
| `packages/market-data/src/bybit-tickers.test.ts` | Bybit ticker provider parsing, rate limiting, cache behavior |
| `packages/market-data/src/price-service.test.ts` | Bybit price resolution; DEX exact-address repricing remains correct |
| `apps/worker/src/scanner-candidate-discovery.test.ts` | venue-aware discovery across all 4 venues |
| `apps/worker/src/scanner-candle-fetcher.test.ts` | orderbook vs swap candle routing |
| `apps/worker/src/technical-phase.test.ts` | swap candidates with explicit `ScannerCandleTarget`; address-qualified swap `instrumentId`s |
| `apps/worker/src/complete-technical-scan.test.ts` | DEX and Bybit pricing identities preserved into scan state |
| `apps/worker/src/hybrid-agent-evaluator.test.ts` | symbol-based resolution still submits exact address-qualified swap `instrumentId` plus pricing identity |
| `apps/worker/src/agent-trading-actor.test.ts` | exact swap instrument parsing, validation, and intake deps |
| `apps/worker/src/agents/agent-intake-resolver.test.ts` | swap validation path and parsed asset IDs |

#### Required executable validation

- targeted vitest runs for the files above
- `pnpm lint`
- `pnpm test`

### Phase 7 — Documentation

#### Files

| File | Action |
|---|---|
| `docs/tech/architecture/market-data.md` | Update scanner consumer section to describe venue-complete agent scanning |
| `CHANGELOG.md` | Record multi-venue scanner support |
| relevant agent runtime docs | Clarify that hybrid/scanner_gated agents now receive signals for all supported bound venues |

## Concrete file list

This is the minimum file set the implementation should expect to touch.

| File | Why |
|---|---|
| `apps/worker/src/index.ts` | remove inline Hyperliquid-only scanner wiring; inject new helpers/config |
| `apps/worker/src/technical-phase.ts` | extend candidate/fetch contracts and phase logic |
| `apps/worker/src/complete-technical-scan.ts` | preserve actual pricing identity |
| `apps/worker/src/runtime-composition.ts` | scan-state identity shape |
| `apps/worker/src/agent-trading-actor.ts` | swap instrument parsing/validation path |
| `apps/worker/src/agents/agent-intake-resolver.ts` | same validation/parsing in fallback intake path |
| `apps/worker/src/resolve-swap-assets.ts` or new parser file | exact swap instrument parser |
| `apps/worker/src/scanner-candidate-discovery.ts` (new) | venue-aware candidate discovery |
| `apps/worker/src/scanner-candle-fetcher.ts` (new) | venue-aware candle routing |
| `apps/worker/src/venue-instrument-cache.ts` or new validator file | venue-aware trade-instrument validation |
| `packages/strategy/src/scan-engine.ts` | venue-aware scan signal shape |
| `packages/market-data/src/bybit-tickers.ts` (new) | Bybit discovery + pricing support |
| `packages/market-data/src/provider-registry.ts` | new provider surface |
| `packages/market-data/src/price-service.ts` | Bybit execution-price branch |
| `packages/market-data/src/types.ts` | provider/config types |
| `config/default.yaml` | scanner quote-asset config + Bybit ticker config |

## Failure policy

This implementation must fail loudly instead of silently degrading.

Rules:

- if the agent binding venue/network cannot be resolved, do not run the scanner
- if a swap candidate lacks exact base token address or pool address, skip it
- if a scanner-generated swap signal lacks a fully-qualified `instrumentId`, do
  not submit it
- if Bybit execution-price lookup is unavailable, do not size Bybit hybrid
  entries off a DEX oracle fallback
- if exact identity cannot be preserved through scan completion, reject the
  signal rather than synthesizing a best guess

## Verification matrix

| Scenario | Expected result |
|---|---|
| Hyperliquid-bound hybrid agent | scanner signals and hybrid submissions still work |
| Bybit-bound hybrid agent | scanner discovers Bybit candidates, hybrid sizing resolves Bybit execution price |
| Jupiter-bound hybrid agent | scanner emits DEX signals with exact Solana token + pool identity |
| 1inch-bound hybrid agent on Base | scanner emits DEX signals with exact Base token + pool identity |
| swap scanner candidate missing pool address | candidate skipped with warning |
| swap scanner signal missing exact quote asset ID | signal rejected before submission |
| Jupiter exact pair validation | accepted |
| orderbook validation regression | none |

## Checklist

- [ ] Extend scanner candidate and signal types to carry venue-aware identity
- [ ] Add exact swap instrument parser supporting both base and quote asset IDs
- [ ] Add venue-aware trade-instrument validation and replace raw symbol checks
- [ ] Implement Bybit tickers provider
- [ ] Extend `priceService` with Bybit execution-price resolution
- [ ] Add operator config for scanner swap quote assets
- [ ] Extract venue-aware scanner candidate discovery
- [ ] Extract venue-aware scanner candle routing
- [ ] Update technical phase to use `ScannerCandleTarget`
- [ ] Preserve exact pricing identity into completed technical scans
- [ ] Add and pass focused tests
- [ ] Update docs and changelog

## Out of scope follow-up

If we later want a single agent to scan and trade across multiple venues in one
session, that is a separate feature. It would require a multi-binding runtime
model, multi-venue execution resolution, and prompt/runtime changes beyond this
plan.