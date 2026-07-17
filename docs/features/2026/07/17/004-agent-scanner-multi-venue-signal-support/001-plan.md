# 004 — Agent Scanner Multi-Venue Signal Support Part 1: Orderbook Venue Completion

**Status:** Planned  
**Created:** 2026-07-17  
**Depends on:** [002-hybrid-agent-redesign](../../06/22/002-hybrid-agent-redesign/001-plan.md) (implemented), [002-hybrid-usd-to-base-size-conversion](../002-hybrid-usd-to-base-size-conversion/001-plan.md) (implemented)  
**Companion follow-up:** [002-plan.md](./002-plan.md)

## Problem

We want hybrid/scanner-gated agents to receive technical scanner signals for
all supported trading venues, but the current scanner path is still effectively
Hyperliquid-only.

For orderbook venues, the main missing piece is not swap identity complexity.
It is venue completeness:

- `apps/worker/src/index.ts` scanner candidate discovery is hard-wired to
  Hyperliquid asset contexts
- scanner candle fetch wiring assumes the existing orderbook path without a
  venue-complete discovery layer
- `apps/worker/src/complete-technical-scan.ts` synthesizes Hyperliquid pricing
  identity for every signal
- `packages/market-data/src/price-service.ts` has execution-aware pricing only
  for Hyperliquid, so Bybit scanner signals would not have a venue-correct
  hybrid USD-sizing source

This means the system can currently do the following:

- Hyperliquid-bound hybrid agents: yes
- Bybit-bound hybrid agents: no, not end-to-end
- swap venue bots: yes, via the separate bot strategy path
- swap venue hybrid agents: deferred to Part 2 because they require exact DEX
  execution identity and swap-aware validation

## Goal

Make the agent scanner venue-complete for orderbook venues in this phase:

- Hyperliquid
- Bybit

That includes:

- venue-aware candidate discovery for orderbook bindings
- venue-correct candle routing for orderbook scanner signals
- venue-correct hybrid USD-to-base sizing for Bybit signals
- preservation of discovered pricing identity through scan completion

## Why This Is Part 1

Orderbook venue support is a bounded extension of the existing scanner model.
Hyperliquid and Bybit both fit the same broad execution shape:

- one tradable venue instrument per signal
- existing orderbook candle policy can be reused
- hybrid sizing should use venue-native execution pricing

The DEX path is intentionally split into Part 2 because it requires:

- exact address-qualified execution identity
- quote-asset policy
- swap-aware trade-instrument validation
- pool-aware candle targets

Those requirements are real, but they are a larger cross-cutting change than
adding Bybit to the orderbook path.

## Non-Goals

- Do not add Jupiter or 1inch scanner support in this part.
- Do not redesign bot strategy execution.
- Do not change the public `submit_decision` schema.
- Do not redesign swap parsing or swap validation here, other than preserving
  current behavior and avoiding regressions.
- Do not make one agent scan multiple venues in one session.

## Supported Scope

This part defines support for the following combinations:

| Venue | Venue type | Candidate source | Candle source | Hybrid sizing source |
|---|---|---|---|---|
| Hyperliquid | `orderbook` | Hyperliquid asset contexts | existing orderbook candle path | Hyperliquid execution mark via `priceService` |
| Bybit | `orderbook` | new Bybit tickers provider | existing orderbook candle path | new Bybit execution ticker/mark path via `priceService` |

## Key Decision

### Part 1 introduces venue-aware orderbook scanning without taking on DEX identity yet

The scanner must honor the agent's active trading binding and
`technical.filters` instead of assuming Hyperliquid.

A Hyperliquid-bound agent scans Hyperliquid perp candidates.
A Bybit-bound agent scans Bybit perp candidates.

This part deliberately stops there. Swap venues are handled by Part 2.

## Design

### 1. Introduce explicit scanner identity for orderbook signals

The current scanner signal shape is too implicit. Even for orderbook venues, we
should stop deriving pricing identity late.

Add explicit orderbook-oriented identity fields.

#### In `apps/worker/src/technical-phase.ts`

```ts
export interface ScannerCandleTarget {
  venueType: 'orderbook';
  providerSymbol: string;
}

export interface DiscoveredInstrument {
  venue: string;
  venueType: 'orderbook';
  symbol: string;
  instrumentId: string;
  candleTarget: ScannerCandleTarget;
  pricingIdentity: {
    kind: 'perps';
    symbol: string;
    chain: 'hyperliquid' | 'bybit';
  };
  volume24hUsd?: number;
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
  venueType?: 'orderbook';
  candleTarget?: ScannerCandleTarget;
  pricingIdentity?: HybridPricingIdentity;
  meta?: {
    volume24hUsd?: number;
    priceChange24hPct?: number;
  };
}

export interface ScoredSignal {
  symbol: string;
  instrumentId: string;
  venue?: string;
  venueType?: 'orderbook';
  pricingIdentity?: HybridPricingIdentity;
  confidence: number;
  reasons: string[];
  intent: 'go_long' | 'go_short';
  indicators: { ... };
}
```

Rules:

- `symbol` stays human-readable
- `instrumentId` must be the actual tradable venue instrument
- `pricingIdentity` must be determined during discovery, not synthesized later
- `candleTarget` must tell the fetcher exactly which orderbook symbol to query

### 2. Add venue-complete orderbook candidate discovery

Extract scanner discovery from `apps/worker/src/index.ts` into a dedicated
module so it can branch by binding venue.

Suggested module:

```ts
export async function discoverScannerCandidates(params: {
  registry: ProviderRegistry;
  filters: FilterConfig;
  bindingVenue: 'hyperliquid' | 'bybit';
  bindingVenueType: 'orderbook';
  maxCandidates: number;
}): Promise<DiscoveredInstrument[]>;
```

#### Hyperliquid

Source:

- `registry.hyperliquid.assetContexts()`

Mapping:

- `symbol`: base ticker, e.g. `BTC`
- `instrumentId`: existing Hyperliquid execution instrument form already used
  by the agent path
- `candleTarget.providerSymbol`: existing orderbook candle symbol
- `pricingIdentity`: `{ kind: 'perps', symbol: <asset>, chain: 'hyperliquid' }`

#### Bybit

Source:

- new `registry.bybit.tickers()` provider backed by Bybit linear tickers

Mapping:

- `symbol`: human-readable base ticker or pair display
- `instrumentId`: the actual tradable venue instrument used by execution
- `candleTarget.providerSymbol`: orderbook candle symbol
- `pricingIdentity`: `{ kind: 'perps', symbol: <venue symbol or resolved base>, chain: 'bybit' }`

Hard rules:

- do not invent a Bybit instrument format ad hoc in the scanner
- resolve Bybit instruments through the same canonical contract used by the
  venue adapter and market metadata

### 3. Route orderbook scanner candles through an explicit helper

Extract the scanner candle fetch helper from `apps/worker/src/index.ts` into a
dedicated module.

Suggested module:

```ts
export function createScannerCandleFetcher(params: {
  binanceConfig: BinanceCandlesConfig;
  scannerRateLimiter: TokenBucketRateLimiter;
}): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>;
```

Rules:

- orderbook targets use the existing orderbook candle policy
- the target object, not a venue-global assumption, supplies the provider
  symbol
- no scanner code should assume Hyperliquid once the binding venue is Bybit

### 4. Extend `priceService` to support Bybit orderbook signals

The current `priceService` only has execution-aware logic for Hyperliquid.
That is insufficient once Bybit scanner signals are introduced because hybrid
USD-to-base sizing must stay venue-correct.

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
- `bybit` -> Bybit ticker/mark -> cache

Rules:

- Bybit scanner-generated `pricingIdentity.chain` must be `'bybit'`
- hybrid sizing for Bybit must reject stale ticker results instead of falling
  back to DexScreener

### 5. Preserve discovered pricing identity through scan completion

Stop hardcoding Hyperliquid pricing identity in
`apps/worker/src/complete-technical-scan.ts`.

Instead:

- read `signal.pricingIdentity` from `TechnicalPhaseResult.signals`
- build `TechnicalScanState.pricingIdentities[instrumentId]` from the actual
  signal data
- if an orderbook `go_long` signal lacks `pricingIdentity`, do not publish it
  into the completed scan state

This removes late re-derivation drift and makes Bybit hybrid sizing safe.

### 6. Keep the prompt human-readable

The hybrid prompt should continue to show clean symbols.

Rule:

- `signal.symbol` is prompt-facing and readable
- `signal.instrumentId` remains the exact execution instrument
- `runHybridEvaluator()` may continue resolving LLM responses by `symbol`, then
  submitting the matched signal's exact `instrumentId`

## Implementation

### Phase 1 — Shared orderbook identity and scan-state cleanup

| File | Action |
|---|---|
| `apps/worker/src/technical-phase.ts` | Extend `DiscoveredInstrument` and `TechnicalPhaseDeps.fetchCandles` for explicit orderbook targets |
| `packages/strategy/src/scan-engine.ts` | Extend `CandidateContext` / `ScoredSignal` with venue-aware orderbook identity |
| `apps/worker/src/complete-technical-scan.ts` | Stop hardcoding Hyperliquid pricing identity |
| `apps/worker/src/runtime-composition.ts` | Keep scanner-resolved pricing identity as the source of truth |

Acceptance criteria:

- orderbook scanner signals carry explicit `pricingIdentity`
- completed technical scans preserve the discovered identity
- Hyperliquid behavior does not regress

### Phase 2 — Bybit market-data provider and pricing path

| File | Action |
|---|---|
| `packages/market-data/src/bybit-tickers.ts` (new) | Implement linear tickers provider |
| `packages/market-data/src/provider-registry.ts` | Add `bybit.tickers()` and config wiring |
| `packages/market-data/src/types.ts` | Add `BybitTicker` types and any config surface needed |
| `packages/market-data/src/price-service.ts` | Add Bybit execution-price resolution |
| `config/default.yaml` | Add Bybit ticker config |
| config schema / resolved config files as needed | Wire operator config into the runtime |

Acceptance criteria:

- provider registry can fetch Bybit tickers with rate limiting and cache policy
- `priceService.resolvePriceTarget(..., 'bybit', ...)` works
- Bybit hybrid sizing fails closed when execution pricing is unavailable or
  stale

### Phase 3 — Orderbook scanner discovery and candle routing

| File | Action |
|---|---|
| `apps/worker/src/index.ts` | Remove inline Hyperliquid-only scanner helpers |
| `apps/worker/src/scanner-candidate-discovery.ts` (new) | Implement orderbook venue-aware discovery |
| `apps/worker/src/scanner-candle-fetcher.ts` (new) | Implement explicit orderbook candle routing |
| `apps/worker/src/agent-trading-actor.ts` | Use the new helpers via injected deps |

Acceptance criteria:

- scanner discovery respects the active orderbook binding venue
- Hyperliquid and Bybit candidates both flow through the same scanner contract
- candle fetching no longer assumes Hyperliquid

### Phase 4 — Tests and verification

| File | Coverage |
|---|---|
| `packages/market-data/src/bybit-tickers.test.ts` | Bybit ticker provider parsing, rate limiting, cache behavior |
| `packages/market-data/src/price-service.test.ts` | Bybit price resolution and stale rejection |
| `apps/worker/src/scanner-candidate-discovery.test.ts` | Hyperliquid and Bybit discovery |
| `apps/worker/src/scanner-candle-fetcher.test.ts` | explicit orderbook candle routing |
| `apps/worker/src/complete-technical-scan.test.ts` | Bybit pricing identities preserved into scan state |
| `apps/worker/src/hybrid-agent-evaluator.test.ts` | symbol-based resolution still submits exact orderbook instrument plus pricing identity |

Required executable validation:

- targeted vitest runs for the files above
- `pnpm lint`
- relevant worker tests

## Concrete file list

| File | Why |
|---|---|
| `apps/worker/src/index.ts` | remove inline Hyperliquid-only scanner wiring; inject new helpers |
| `apps/worker/src/technical-phase.ts` | extend candidate and candle contracts |
| `apps/worker/src/complete-technical-scan.ts` | preserve actual pricing identity |
| `apps/worker/src/runtime-composition.ts` | scan-state identity source of truth |
| `apps/worker/src/scanner-candidate-discovery.ts` (new) | orderbook venue-aware candidate discovery |
| `apps/worker/src/scanner-candle-fetcher.ts` (new) | explicit orderbook candle routing |
| `packages/strategy/src/scan-engine.ts` | venue-aware scan signal shape |
| `packages/market-data/src/bybit-tickers.ts` (new) | Bybit discovery and pricing support |
| `packages/market-data/src/provider-registry.ts` | new provider surface |
| `packages/market-data/src/price-service.ts` | Bybit execution-price branch |
| `packages/market-data/src/types.ts` | provider/config types |
| `config/default.yaml` | Bybit ticker config |

## Failure policy

This part must fail loudly instead of silently degrading.

Rules:

- if the active binding venue cannot be resolved, do not run the scanner
- if Bybit execution-price lookup is unavailable or stale, do not size Bybit
  hybrid entries from a generic oracle fallback
- if an orderbook scanner-generated signal lacks exact pricing identity, reject
  it instead of synthesizing a best guess

## Verification matrix

| Scenario | Expected result |
|---|---|
| Hyperliquid-bound hybrid agent | scanner signals and hybrid submissions still work |
| Bybit-bound hybrid agent | scanner discovers Bybit candidates and hybrid sizing resolves Bybit execution price |
| Bybit execution price unavailable | scanner signal is not sized or submitted |
| orderbook validation regression | none |

## Checklist

- [ ] Extend orderbook scanner candidate and signal types to carry venue-aware identity
- [ ] Implement Bybit tickers provider
- [ ] Extend `priceService` with Bybit execution-price resolution
- [ ] Extract venue-aware orderbook scanner candidate discovery
- [ ] Extract explicit orderbook scanner candle routing
- [ ] Preserve exact pricing identity into completed technical scans
- [ ] Add and pass focused tests
- [ ] Update docs and changelog

## Out-of-scope follow-up

Jupiter and 1inch scanner support are intentionally deferred to
[002-plan.md](./002-plan.md). That follow-up adds exact DEX execution identity,
quote-asset policy, swap-aware validation, and pool-aware candle routing.