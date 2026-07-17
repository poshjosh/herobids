# 004 — Agent Scanner Multi-Venue Signal Support Part 2: DEX Venue Completion

**Status:** Planned  
**Created:** 2026-07-17  
**Depends on:** [001-plan.md](./001-plan.md), [002-hybrid-agent-redesign](../../06/22/002-hybrid-agent-redesign/001-plan.md) (implemented), [002-hybrid-usd-to-base-size-conversion](../002-hybrid-usd-to-base-size-conversion/001-plan.md) (implemented)

## Problem

Part 1 makes the scanner venue-complete for orderbook venues. It does not solve
the DEX-specific identity problem.

For Jupiter and 1inch, the current scanner and intake contracts are not merely
missing a provider branch. They are missing exact execution identity.

Today:

- scanner/discovery identity is token and pool based
- trade intake still treats incoming swap instruments largely as `BASE/QUOTE`
  strings
- validation still assumes the incoming instrument can be checked as one raw
  symbol value
- candle fetching for swap scanning needs `network + poolAddress`, not only a
  symbol
- DEX hybrid pricing is only safe when chain and token address survive the
  pipeline exactly

Without these changes, scanner-generated DEX signals would either be ambiguous
or would require guessing. That is not acceptable for trading.

## Goal

Allow Jupiter-bound and 1inch-bound hybrid/scanner-gated agents to receive and
act on technical scanner signals with exact execution identity.

That includes:

- exact address-qualified swap instrument IDs
- swap-aware parsing and validation
- explicit quote-asset policy driven by canonical token allowlists
- pool-aware candle routing
- exact DEX pricing identity preserved into hybrid sizing and submission

## Why This Is Part 2

DEX support is not just another venue adapter branch.

It requires a stricter end-to-end contract across:

- discovery
- candidate identity
- candle fetch targets
- intake validation
- hybrid repricing

This is the real scope multiplier in the original combined plan, so it is split
out explicitly instead of hiding inside the orderbook rollout.

## Non-Goals

- Do not redesign bot strategy execution.
- Do not change the public `submit_decision` schema.
- Do not make manual agent turns emit address-qualified symbols in the prompt.
- Do not make one agent scan multiple venue bindings in the same session.
- Do not attempt cross-venue arbitrage or portfolio-level multi-venue scanning.

## Supported Scope

This part defines support for the following combinations:

| Venue | Venue type | Candidate source | Candle source | Hybrid sizing source |
|---|---|---|---|---|
| Jupiter | `swap` | shared discovery pipeline (`solana`) | GeckoTerminal pools | exact DEX pricing identity via `priceService` using chain + address |
| 1inch | `swap` | shared discovery pipeline (binding/operator-resolved EVM network) | GeckoTerminal pools | exact DEX pricing identity via `priceService` using chain + address |

## Key Decision

### DEX scanner signals must carry exact execution identity internally

The prompt may stay human-readable, but the runtime contract may not rely on
bare ticker symbols.

Scanner-generated DEX signals must therefore carry:

- display identity for the prompt
- execution identity for submission
- market-data identity for candles and repricing

If the scanner cannot construct those identities exactly, it must skip the
candidate instead of guessing.

## Design

### 1. Extend the scanner identity model for swaps

Part 1 adds explicit scanner identity for orderbook venues. This part extends
that model for swap venues.

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
  indicators: { ... };
}
```

Rules:

- `symbol` stays prompt-facing and readable
- `instrumentId` must be execution-correct
- `pricingIdentity` must be exact enough for hybrid sizing
- `candleTarget` must be exact enough to fetch the intended OHLCV series

### 2. Standardize scanner-generated swap instrument IDs as address-qualified pairs

Scanner-generated swap signals must use an internal exact format:

```text
<BASE_SYMBOL>:<BASE_ASSET_ID>/<QUOTE_SYMBOL>:<QUOTE_ASSET_ID>
```

Examples:

- Jupiter: `BONK:<solana-mint>/USDC:<solana-mint>`
- 1inch Base: `WETH:<base-token-address>/USDC:<base-token-address>`

Why this is required:

- same-symbol fakes exist on the same network
- DEX repricing already needs exact chain + address
- swap execution adapters quote exact asset IDs, not human tickers
- legacy plain `BASE/QUOTE` strings do not carry enough identity for scanner
  correctness

Rules:

- scanner-generated decisions must always use the fully-qualified form
- legacy manual agent calls may still use `BASE/QUOTE`, but that is not the
  scanner contract
- if the scanner lacks enough identity to produce a fully-qualified swap
  `instrumentId`, it must skip the candidate rather than guess

### 3. Extend swap instrument parsing to support exact quote-side identity

Update the parsing contract in:

- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/agents/agent-intake-resolver.ts`
- `apps/worker/src/resolve-swap-assets.ts` or a new dedicated parser module

Required behavior:

- accept `BASE/QUOTE`
- accept `BASE:BASE_ID/QUOTE`
- accept `BASE:BASE_ID/QUOTE:QUOTE_ID`
- when `:QUOTE_ID` is present, preserve it all the way through execution

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

### 4. Replace symbol-only swap validation with venue-aware trade-instrument validation

Current symbol validation is not sufficient for swap venues.

Add a new helper, for example in `apps/worker/src/venue-instrument-cache.ts`
or `apps/worker/src/validate-trade-instrument.ts`:

```ts
export function validateTradeInstrument(params: {
  venue: string;
  venueType: 'orderbook' | 'swap';
  instrumentId: string;
  instrumentCache?: VenueInstrumentCache;
}): { ok: true } | { ok: false; code: string; message: string };
```

Rules:

- orderbook venues reuse the existing cache validation
- Jupiter parses the pair and validates base and quote asset IDs individually
  against the Jupiter token cache
- 1inch parses the pair and validates structural correctness plus resolved
  network; do not hard-block on the current curated token address list because
  that list is intentionally incomplete

Replace raw `instrumentCache.hasSymbol(...)` checks in:

- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/agents/agent-intake-resolver.ts`

### 5. Add DEX candidate discovery on top of the shared scanner discovery module

Extend `discoverScannerCandidates(...)` from Part 1 to support swap bindings.

Suggested shape:

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

#### Jupiter

Source:

- `registry.discovery.discover({ networks: ['solana'], ... })`

Required candidate fields:

- `symbol`: `<BASE_SYMBOL>/<QUOTE_SYMBOL>` for prompt display
- `instrumentId`: address-qualified pair format
- `candleTarget`: `{ venueType: 'swap', network: 'solana', poolAddress: <token.poolAddress> }`
- `pricingIdentity`: `{ kind: 'dex', symbol: <base symbol>, chain: 'solana', address: <base token address> }`
- `swapExecutionIdentity`: `{ network: 'solana', baseSymbol, baseAddress, quoteSymbol, quoteAddress }`

Hard requirement:

- if discovery did not yield `poolAddress` or exact base token address, skip
  the candidate

#### 1inch

Source:

- `registry.discovery.discover({ networks: [resolvedSwapNetwork], ... })`

Required candidate fields are the same as Jupiter, except network is the
active binding or operator-resolved 1inch network.

Hard requirement:

- if `resolveSwapNetwork(...)` returns `undefined`, the scanner for that agent
  must fail closed at startup rather than silently downgrading to a wrong
  network

### 6. Introduce explicit swap quote-asset policy for scanner-generated DEX signals

One discovered DEX token can appear in many pools and quote pairs. The scanner
must map each entry signal to exactly one executable pair.

Do not guess the quote side from whatever pool ranked highest.

Use `marketData.tokenSafety.canonicalTokens.<network>` as the explicit
allowlist of supported quote assets. The scanner UI and runtime config should
select from those canonical keys, not from arbitrary token symbols.

Required runtime selection shape:

```yaml
agentRuntime:
  scannerQuoteAssets:
    solana: USDC
    base: USDC
    arbitrum: USDC
    optimism: USDC
    ethereum: USDC
    polygon: USDC
```

Scanner rules:

- every DEX entry candidate is normalized to the configured canonical quote
  asset key for its network
- the selected quote asset must exist inside
  `marketData.tokenSafety.canonicalTokens.<network>`
- default quote asset is USDC wherever the network has a canonical USDC entry
- the frontend should expose this as a scanner-gated preset option so the user
  can override the default while still staying inside the allowlist

### 7. Route swap scanner candles by network and pool address

Extend the scanner candle fetcher from Part 1.

Rules:

- orderbook targets continue using the existing orderbook candle path
- swap targets route to GeckoTerminal using `network + poolAddress`
- if a swap target lacks `network` or `poolAddress`, fail closed

Do not rely on string heuristics to infer pool-vs-symbol in the scanner path.
The target object must already tell the fetcher what it is.

#### Exit-scan rule for swap positions

For swap positions, exit scanning is only safe when the open position's
`instrumentId` can be parsed back into an exact address-qualified pair and the
network is known from the actor binding.

If not, skip exit scanning for that position and log a structured warning.

### 8. Preserve exact DEX pricing identity through scan completion and hybrid sizing

Part 1 removes the Hyperliquid hardcode. This part finishes the DEX side.

Rules:

- read `signal.pricingIdentity` from `TechnicalPhaseResult.signals`
- build `TechnicalScanState.pricingIdentities[instrumentId]` from the actual
  signal data
- if a DEX `go_long` signal lacks exact `pricingIdentity`, do not publish it
  into completed scan state
- hybrid sizing must continue using chain + address identity for DEX repricing
  and reject stale results

### 9. Keep the prompt human-readable while keeping execution exact

The hybrid prompt should continue to show clean symbols, not address dumps.

Rule:

- `signal.symbol` is prompt-facing and human-readable, e.g. `BONK/USDC`
- `signal.instrumentId` is internal and exact, e.g.
  `BONK:<mint>/USDC:<mint>`
- `runHybridEvaluator()` may continue resolving LLM responses by `symbol`, then
  submitting the matched signal's exact `instrumentId`

## Implementation

### Phase 1 — Extend shared scanner identity to carry exact DEX identity

| File | Action |
|---|---|
| `apps/worker/src/technical-phase.ts` | Extend `DiscoveredInstrument` and `TechnicalPhaseDeps.fetchCandles` contract for swap targets |
| `packages/strategy/src/scan-engine.ts` | Extend `CandidateContext` / `ScoredSignal` with swap identity fields |

Acceptance criteria:

- swap candidates can carry exact execution, candle, and pricing identity
- no scanner logic relies on bare symbol strings for DEX identity

### Phase 2 — Exact swap instrument parsing and validation

| File | Action |
|---|---|
| `apps/worker/src/agent-trading-actor.ts` | Replace ad hoc swap parsing with explicit parser supporting quote-side asset IDs |
| `apps/worker/src/agents/agent-intake-resolver.ts` | Parse and validate exact swap instrument identity consistently |
| `apps/worker/src/resolve-swap-assets.ts` or new parser file | Add `parseSwapInstrumentId()` |
| `apps/worker/src/venue-instrument-cache.ts` or new validator file | Add venue-aware `validateTradeInstrument()` |

Acceptance criteria:

- scanner-generated swap instrument IDs can carry both base and quote asset IDs
- Jupiter exact pairs are accepted
- 1inch exact pairs are structurally validated without being blocked by the
  intentionally incomplete curated token list

### Phase 3 — DEX discovery, quote-asset policy, and candle routing

| File | Action |
|---|---|
| `apps/worker/src/scanner-candidate-discovery.ts` | Extend venue-aware discovery for Jupiter and 1inch |
| `apps/worker/src/scanner-candle-fetcher.ts` | Route swap candles via GeckoTerminal |
| `config/default.yaml` | Use canonical token allowlist plus scanner quote-asset selection |
| config schema / resolved config files as needed | Wire scanner quote-asset selection into runtime |

Acceptance criteria:

- scanner discovery respects the active swap binding venue and network
- scanner-generated DEX candidates emit exact execution, pricing, and candle identity
- quote assets are selected from canonical token allowlists, defaulting to USDC

### Phase 4 — Preserve exact DEX scan identity into hybrid evaluation and sizing

| File | Action |
|---|---|
| `apps/worker/src/complete-technical-scan.ts` | Preserve DEX pricing identities into scan state |
| `apps/worker/src/runtime-composition.ts` | Ensure pricing identities remain scanner-resolved |
| `apps/worker/src/hybrid-agent-evaluator.ts` | Continue passing exact `pricingIdentity` from the matched signal |
| `apps/worker/src/hybrid-decision-sizing.ts` | Continue accepting exact DEX identities and rejecting stale repricing |

Acceptance criteria:

- Jupiter and 1inch scanner signals carry exact pricing identity to submission time
- no completed DEX scanner signal gets a synthetic fallback identity

### Phase 5 — Tests and verification

| File | Coverage |
|---|---|
| `apps/worker/src/scanner-candidate-discovery.test.ts` | Jupiter and 1inch discovery with exact identities |
| `apps/worker/src/scanner-candle-fetcher.test.ts` | orderbook vs swap candle routing |
| `apps/worker/src/technical-phase.test.ts` | swap candidates with explicit `ScannerCandleTarget`; address-qualified swap `instrumentId`s |
| `apps/worker/src/complete-technical-scan.test.ts` | DEX pricing identities preserved into scan state |
| `apps/worker/src/hybrid-agent-evaluator.test.ts` | symbol-based resolution still submits exact address-qualified swap `instrumentId` plus pricing identity |
| `apps/worker/src/agent-trading-actor.test.ts` | exact swap instrument parsing, validation, and intake deps |
| `apps/worker/src/agents/agent-intake-resolver.test.ts` | swap validation path and parsed asset IDs |

Required executable validation:

- targeted vitest runs for the files above
- `pnpm lint`
- relevant worker tests

## Concrete file list

| File | Why |
|---|---|
| `apps/worker/src/technical-phase.ts` | extend candidate and candle contracts for swap targets |
| `apps/worker/src/complete-technical-scan.ts` | preserve actual DEX pricing identity |
| `apps/worker/src/runtime-composition.ts` | scan-state identity source of truth |
| `apps/worker/src/agent-trading-actor.ts` | swap instrument parsing and validation path |
| `apps/worker/src/agents/agent-intake-resolver.ts` | same validation and parsing in fallback intake path |
| `apps/worker/src/resolve-swap-assets.ts` or new parser file | exact swap instrument parser |
| `apps/worker/src/scanner-candidate-discovery.ts` | swap venue-aware candidate discovery |
| `apps/worker/src/scanner-candle-fetcher.ts` | swap candle routing |
| `apps/worker/src/venue-instrument-cache.ts` or new validator file | venue-aware trade-instrument validation |
| `packages/strategy/src/scan-engine.ts` | venue-aware scan signal shape |
| `config/default.yaml` | canonical token allowlist driven quote-asset selection |

## Failure policy

This part must fail loudly instead of silently degrading.

Rules:

- if the agent binding venue or swap network cannot be resolved, do not run the scanner
- if a swap candidate lacks exact base token address or pool address, skip it
- if a scanner-generated swap signal lacks a fully-qualified `instrumentId`, do
  not submit it
- if exact identity cannot be preserved through scan completion, reject the
  signal rather than synthesizing a best guess

## Verification matrix

| Scenario | Expected result |
|---|---|
| Jupiter-bound hybrid agent | scanner emits DEX signals with exact Solana token and pool identity |
| 1inch-bound hybrid agent on Base | scanner emits DEX signals with exact Base token and pool identity |
| swap scanner candidate missing pool address | candidate skipped with warning |
| swap scanner signal missing exact quote asset ID | signal rejected before submission |
| Jupiter exact pair validation | accepted |
| 1inch exact pair validation | structurally accepted for supported network |

## Checklist

- [ ] Extend scanner candidate and signal types to carry swap-aware identity
- [ ] Add exact swap instrument parser supporting both base and quote asset IDs
- [ ] Add venue-aware trade-instrument validation and replace raw symbol checks
- [ ] Extend venue-aware scanner discovery for Jupiter and 1inch
- [ ] Extend explicit scanner candle routing for swap targets
- [ ] Add canonical-token-driven scanner quote-asset selection
- [ ] Preserve exact DEX pricing identity into completed technical scans
- [ ] Add and pass focused tests
- [ ] Update docs and changelog

## Out-of-scope follow-up

If we later want a single agent to scan and trade across multiple venues in one
session, that is a separate feature. It would require a multi-binding runtime
model, multi-venue execution resolution, and prompt/runtime changes beyond this
plan.