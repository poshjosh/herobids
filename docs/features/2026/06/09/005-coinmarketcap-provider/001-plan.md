# CoinMarketCap Provider Plan

Add CoinMarketCap as an opt-in discovery and enrichment provider for cross-chain market data. This plan also establishes the shared paid-provider availability policy that later providers such as Birdeye must follow.

## Background

The repo already has the CoinMarketCap config block, provider name, and discovery merge plumbing. What is missing is the CMC client, the registry wiring with separate discovery and enrichment rate limits, the post-merge enrichment pass, and a clean provider-availability contract for optional paid providers.

## Scope

### In scope

- `packages/market-data/src/coinmarketcap.ts` — new file
- `packages/market-data/src/types.ts` — extend `DiscoveredToken` with CMC enrichment fields and `DiscoveryConfig` with optional CMC config
- `packages/market-data/src/discovery.ts` — wire CMC discovery fan-out and enrichment pass
- `packages/market-data/src/provider-registry.ts` — add optional CMC entry and cache wiring
- `packages/domain/src/config/schema.ts` — enforce the paid-provider availability policy at startup
- `packages/market-data/src/index.ts` — export new CMC symbols
- Unit tests for the new client and the updated discovery/registry flow

### Out of scope

- Birdeye discovery
- CMC security-detail per-token GET calls
- Any changes to execution, strategy, or worker tick logic

## Constraints

### CMC enrichment is a second pass, not discovery fan-out

The batch-query endpoint enriches already discovered tokens. It must run after fan-out merge, not alongside it, and it should be capped to one call per `discoverTokens()` invocation per network slice.

### CMC is opt-in

If `config.coinMarketCap.enabled` is false or the config is absent, no CMC calls should be made and discovery must continue normally.

### Provider availability policy must be explicit

CoinMarketCap is the first paid provider to land, so this plan must establish the shared behavior for optional credentialed providers:

- If a provider is absent from config or `enabled` is false, skip it.
- If a provider is explicitly enabled but its API key is missing, fail fast with a loud config error.
- If a provider is correctly configured but unavailable at runtime, do not let it block other providers.

### Unsupported networks should not throw

If a network is not supported by CMC, the discovery functions should return an empty list rather than failing the whole run.

## Plan

1. Establish the shared provider-availability policy.
   Files: `packages/domain/src/config/schema.ts`, `packages/market-data/src/provider-registry.ts`, `packages/market-data/src/discovery.ts`.
   Change: make optional paid providers behave consistently across the market-data stack: disabled or absent provider config is skipped, enabled-without-key fails at startup, and runtime provider failures do not abort the rest of discovery.
   Dependency: none.

2. Extend the shared market-data types for CMC output.
   Files: `packages/market-data/src/types.ts`.
   Change: add CoinMarketCap to the `source` union and add optional enrichment fields for market cap, FDV, holder count, CEX listings, and risk level.
   Dependency: step 1.

3. Create the CMC client.
   Files: `packages/market-data/src/coinmarketcap.ts`.
   Change: implement trending, new-token, and batch-enrichment functions; map CMC response records into `DiscoveredToken` values; respect separate discovery and enrichment rate limiters; and skip unsupported networks cleanly.
   Dependency: steps 1 and 2.

4. Wire CMC into discovery.
   Files: `packages/market-data/src/discovery.ts`.
   Change: add CMC discovery to the fan-out phase, then run a sequential enrichment pass after merge/filter/sort so the final result includes CMC metadata where available. Discovery must remain fail-soft when CMC rejects at runtime and at least one other provider returns data.
   Dependency: steps 1 through 3.

5. Wire CMC into the registry.
   Files: `packages/market-data/src/provider-registry.ts`, `packages/market-data/src/index.ts`.
   Change: create separate rate limiters for discovery and enrichment, add the optional CMC registry entry, skip the provider entirely when disabled, and keep cache TTL derivation aligned with enabled providers.
   Dependency: steps 1 through 4.

6. Add focused tests.
   Files: `packages/market-data/src/coinmarketcap.ts`, `packages/market-data/src/discovery.ts`, `packages/market-data/src/provider-registry.ts`, `apps/worker/src/config.test.ts`.
   Change: cover discovery response mapping, enrichment merging, unsupported-network handling, disabled-provider skipping, enabled-without-key rejection, and runtime failure isolation.
   Dependency: steps 1 through 5.

## Test Strategy

- Unit tests for the CMC client discovery and enrichment mappings.
- Registry/discovery tests for the second-pass enrichment path, disabled-provider skipping, and runtime failure isolation.
- Config tests for enabled-without-key rejection.
- Validation command: `pnpm lint`

## Exit Criteria

- CMC discovery runs only when explicitly enabled.
- Disabled or absent CMC config is skipped without affecting other providers.
- Enabled CMC with a missing API key fails fast with a clear startup error.
- CMC enrichment runs after merge, not in the discovery fan-out.
- Unsupported networks return `[]` rather than failing.
- CMC runtime failures do not block discovery results from other providers.
- `pnpm lint` passes with coverage for the new CMC path.