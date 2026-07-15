# Price Service And Watch/Monitor Tools Plan

Add a small, internal price service abstraction first, then build watch/monitor tools on top of it. This keeps execution pricing separate from valuation and monitoring use cases, while preserving swap-quote pricing for actual trade execution.

## Background

OpenAIdom already has three relevant pricing surfaces:

- venue-native mark and oracle data used in runtime context for trading decisions
- CoinGecko-backed oracle mark fallback in `OracleMarkSource`
- market-data discovery and venue-intelligence blocks injected into the worker prompt

What is missing is a dedicated price service that can serve non-execution price requests consistently across valuation, watch thresholds, and discovery enrichment, plus the watch/monitor tools that depend on it.

## Goals

- Add a small price service abstraction with multiple implementations.
- Use that service for portfolio valuation, watch thresholds, and discovery enrichment.
- Keep swap-quote pricing for actual trade execution.
- Expose a narrow agent-facing price tool only if the agent needs ad hoc lookup.

## Scope

### In scope

- Price service interface and implementations for execution, oracle, and cached/stale fallback behavior
- Source-selection policy that prefers execution price first, oracle second, and stale cached data last
- A narrow, chain-aware price lookup tool for agent use when needed
- Watch/monitor tools that register token watches and use the price service for threshold checks
- Valuation and discovery enrichment flows that reuse the same price service

### Out of scope

- Changing swap execution semantics
- Replacing existing venue intelligence or discovery tooling
- Adding broad prompt-time market data dumps
- Supporting every chain with the same price source set on day one

## Constraints

### Keep execution pricing separate from monitoring pricing

Live trade sizing and execution should continue to rely on venue mark or the latest executable quote. The new price service is for non-execution uses: valuation, pre-screening, discovery refresh, and watch triggers.

### Treat oracle pricing as fallback, not truth

The current oracle source is CoinGecko-backed and should be treated as a fallback or benchmark. It is useful for stable context and valuation, but not as a substitute for a live executable price.

### Keep the agent-facing tool narrow and chain-aware

The internal price service can be broad, but the exposed tool should take an explicit chain, validate token format for that chain, and return a small, predictable payload with source and freshness metadata.

### Keep runtime context compact

Venue intelligence should remain summarized in runtime context, not expanded into raw price feeds. Only high-signal, reusable pricing summaries belong in prompt context.

## Plan

1. Define the internal price service abstraction.
   Files: `packages/market-data/src/*` or the closest existing market-data layer; `packages/domain/src/*` only if a shared type belongs in the domain contract.
   Change: add a small service interface for price lookup with source metadata, freshness, and fallback behavior. Include implementations for venue execution price, oracle mark, and cached/stale fallback.
   Dependency: none.

2. Establish source priority and fallback policy.
   Files: price service implementation and tests.
   Change: make the selection order explicit: execution price first, oracle second, cached/stale last. Use this policy for valuation and monitoring flows, but keep execution quotes isolated for actual trade entry and exit.
   Dependency: step 1.

3. Add the agent-facing price tool wrapper.
   Files: worker tool registry and the new price-tool module.
   Change: expose a narrow, chain-aware lookup tool that returns current price, source, timestamp/freshness, and any failure reason. Keep the wrapper small so the internal service can remain richer without exposing a wide surface to the model.
   Dependency: steps 1 and 2.

4. Build watch/monitor tools on top of the price service.
   Files: worker tool registry, watch storage / scheduling code, and supporting state modules.
   Change: add tools for creating, listing, and removing watches; evaluate watched tokens against threshold prices; and emit wake-up events when thresholds are crossed. Use the shared price service for threshold checks rather than duplicating source logic inside the watch layer.
   Dependency: steps 1 through 3.

5. Reuse the price service for portfolio valuation and discovery enrichment.
   Files: runtime context assembly, valuation helpers, discovery/enrichment flow, and any market-data integration points.
   Change: keep valuation and discovery refresh logic on the same pricing path so token prices do not drift between tools and runtime context. For perps, continue to inject venue-native mark and funding data into the runtime context rather than calling a separate tool repeatedly.
   Dependency: steps 1 and 2.

6. Add focused tests.
   Files: new price-service tests, watch-tool tests, and any updated runtime-context tests.
   Change: cover source selection, chain validation, threshold triggering, stale fallback behavior, and the distinction between execution pricing and monitoring pricing.
   Dependency: steps 1 through 5.

## Recommended Source Priority

- Live trade execution: venue mark or latest executable quote first
- Portfolio valuation: oracle or mark fallback next
- Watchlists and discovery enrichment: discovery source first, then low-cost price lookup, then cached/stale fallback
- Runtime context: keep venue-native mark and funding data summarized and fresh enough for the next tick

## Test Strategy

- Unit tests for source selection and fallback order
- Tool tests for chain-aware price lookup and watch lifecycle operations
- Runtime-context tests to confirm pricing summaries stay compact and do not become raw data dumps
- Validation command: `pnpm lint`

## Exit Criteria

- A dedicated price service exists and is used by valuation, watch, and discovery flows.
- Execution pricing remains separate from monitoring pricing.
- The agent-facing price tool is narrow, chain-aware, and returns a predictable response.
- Watch tools can register, evaluate, and clear thresholds using the shared pricing layer.
- `pnpm lint` passes.