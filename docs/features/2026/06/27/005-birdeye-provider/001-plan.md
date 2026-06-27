# Birdeye Provider Plan

Add Birdeye as an opt-in Solana market data provider with full Birdeye support for discovery, token overview, and OHLCV. This plan covers the Birdeye-specific client, wiring, and tests.

## Background

The repo already has the Birdeye config shape in `MarketDataConfig`, the `birdeye` provider name, and the shared market-data plumbing. What is missing is the Birdeye HTTP client, the registry wiring, and the Solana-only paths for discovery, token overview, and OHLCV.

## Scope

### In scope

- `packages/market-data/src/birdeye.ts` — new file
- `packages/market-data/src/types.ts` — extend `DiscoveredToken` source support and `DiscoveryConfig` with optional Birdeye config
- `packages/market-data/src/discovery.ts` — wire Birdeye discovery into provider fan-out
- `packages/market-data/src/provider-registry.ts` — add optional Birdeye discovery, overview, and OHLCV entries and cache wiring
- `packages/market-data/src/index.ts` — export new Birdeye symbols
- Unit tests for the new client and updated discovery/registry flow

### Out of scope

- CoinMarketCap discovery and enrichment
- Any changes to execution, strategy, or worker tick logic

## Constraints

### Birdeye returns HTTP 400 for rate limits, not 429

Birdeye uses HTTP 400 for both unsupported tokens and rate quota exhaustion. The client should treat 400s as warn-and-skip behavior, not as fatal errors.

### Birdeye is opt-in

If `config.birdeye.enabled` is false or the config is absent, no Birdeye calls should be made and discovery must continue normally.

### Birdeye follows the shared paid-provider policy

This plan assumes the provider-availability behavior established in the CoinMarketCap plan:

- Disabled or absent Birdeye config is skipped.
- Enabled Birdeye without an API key is a loud startup error.
- Runtime Birdeye failures do not block other providers from returning data.

### Birdeye is Solana-only

Only include Birdeye vectors when `solana` is present in the configured network list. Token overview and OHLCV are Birdeye capabilities for Solana tokens, not a limit on the broader trading mandate across DEX and CEX venues.

## Plan

1. Extend the shared market-data types for Birdeye output.
   Files: `packages/market-data/src/types.ts`.
   Change: add Birdeye to the `source` union and add optional Birdeye config on `DiscoveryConfig` so discovery can gate the provider cleanly. Reuse existing Solana token and candle types where possible rather than inventing Birdeye-specific output types in downstream consumers.
   Dependency: none.

2. Create the Birdeye client.
   Files: `packages/market-data/src/birdeye.ts`.
   Change: implement the trending-token fetcher, token overview fetcher, and OHLCV fetcher; map Birdeye response items into existing token and candle shapes; filter out incomplete entries; and honor the provider rate limiter and timeout.
   Dependency: step 1.

3. Wire Birdeye into discovery and the registry.
   Files: `packages/market-data/src/discovery.ts`, `packages/market-data/src/provider-registry.ts`, `packages/market-data/src/index.ts`.
   Change: add Birdeye discovery to the fan-out only when enabled and only for Solana; expose overview and OHLCV through the cache-backed registry; and keep disabled-config behavior fail-soft while preserving the loud enabled-without-key validation established by the shared provider policy.
   Dependency: steps 1 and 2.

4. Add focused tests.
   Files: `packages/market-data/src/birdeye.ts`, `packages/market-data/src/discovery.ts`, `packages/market-data/src/provider-registry.ts`.
   Change: cover discovery, overview, and OHLCV response mapping, 400 handling, Solana gating, and disabled-config behavior.
   Dependency: steps 1 through 3.

## Test Strategy

- Unit tests for the Birdeye client discovery, overview, and OHLCV mappings plus 400 handling.
- Registry/discovery tests for opt-in behavior, Solana-only activation, and runtime failure isolation.
- Validation command: `pnpm lint`

## Exit Criteria

- Birdeye discovery only runs when explicitly enabled.
- Disabled or absent Birdeye config is skipped without affecting other providers.
- Enabled Birdeye with a missing API key fails fast with a clear startup error.
- Birdeye discovery, overview, and OHLCV only run for Solana tokens or networks.
- HTTP 400 from Birdeye does not crash token discovery.
- Birdeye runtime failures do not block other providers from returning data.
- `pnpm lint` passes with coverage for the new Birdeye path.

## Outstanding Issues (Post-Implementation Code Review)

### [Item 3 - Registry] Birdeye registry methods exist even when disabled
**Severity: LOW.** Unlike CMC (which omits its methods when disabled), Birdeye's `tokenOverview` and `ohlcv` are always present on the registry. When disabled, the loader returns `null`/`[]`. This is a deliberate design choice — removing the property would require callers to use optional chaining everywhere. The current approach keeps the API surface stable regardless of config state. Revisit if callers need to distinguish "not configured" from "no data."

### [Item 2 - Client] OHLCV and overview use `requestClass: 'discovery'`
**Severity: LOW.** All Birdeye endpoints share a single `'discovery'` rate-limit budget. Birdeye has a global API-wide rate limit, so this is correct. If Birdeye later introduces per-endpoint rate limits, split into separate request classes.

### [Item 1 - Types] `fetchBirdeyeTrending` sets `priceUsd: 0`
**Severity: LOW.** The Birdeye trending endpoint doesn't return price. Downstream consumers (discovery merger, token safety) must handle zero prices gracefully. This is a data-quality concern rather than a code defect.