## Prompt 1

Check if this has been implemented: docs/features/pending/003-agent-scanner-data-wiring/000-problem-statement.md

## Response 1

Not as written.

The pending spec in 000-problem-statement.md has been partially implemented, and then effectively superseded by a split design. The production code now wires scanner discovery and candle fetching for orderbook venues, so the original root cause is fixed for Hyperliquid and Bybit. But the full “all 4 venues” design from that pending doc is not implemented.

What is implemented:

Production now passes scanner discovery and candle fetch functions into the agent actor in index.ts:1044 and index.ts:1045.
The technical scan loop starts when those deps are present, with the guard and startup log in agent-trading-actor.ts:1502 and agent-trading-actor.ts:1513.
There is a real Bybit ticker implementation at bybit-tickers.ts:50, using the linear tickers endpoint at bybit-tickers.ts:55.
That provider is registered in provider-registry.ts:74 and provider-registry.ts:367, with config present in default.yaml:218.
Candidate discovery is implemented for Hyperliquid and Bybit only in scanner-candidate-discovery.ts:16, scanner-candidate-discovery.ts:19, scanner-candidate-discovery.ts:28, and scanner-candidate-discovery.ts:45.
There are tests covering the new orderbook discovery and candle fetch wiring in scanner-candidate-discovery.test.ts:74, scanner-candidate-discovery.test.ts:151, scanner-candle-fetcher.test.ts:43, and bybit-tickers.test.ts:33.
What is not implemented from the pending doc:

Swap venues are still excluded in the production scanner entrypoint. Non-orderbook bindings return no candidates in index.ts:335.
The shared scanner candle contract is still orderbook-only in scan-engine.ts:19, scan-engine.ts:20, and scan-engine.ts:29.
The current scanner candle fetcher is explicitly built with no GeckoTerminal config and an orderbook mode in scanner-candle-fetcher.ts:21, scanner-candle-fetcher.ts:23, and scanner-candle-fetcher.ts:24.
The repo has a later split plan that defers Jupiter and 1inch scanner support to a DEX-specific Part 2 in 001-plan.md:1, 001-plan.md:32, 001-plan.md:70, and 002-plan.md:1.
Short version: if you mean “was the missing production wiring fixed at all?”, yes for Hyperliquid and Bybit. If you mean “does the code now match the pending all-venues scanner design?”, no, not yet.

Natural next steps:

I can map exactly which staging agents are now covered by the current orderbook-only implementation versus still idle because they are bound to Jupiter or 1inch.
I can review the Part 2 DEX plan against the current code and point out the remaining implementation gaps.

## Prompt 2

What do we do next?

## Response 2

Next is to start Part 2 at the contract boundary, not in provider wiring.

Extend the shared scanner identity types in technical-phase.ts and scan-engine.ts:19. Right now the scanner target is still orderbook-only, so DEX support cannot be threaded safely until those types can carry network, poolAddress, exact pricing identity, and swap execution identity.

Replace symbol-only swap parsing and validation in agent-trading-actor.ts and agent-intake-resolver.ts. This is the core safety gap the plan is trying to close: scanner-generated DEX signals need exact address-qualified pairs, not bare BASE/QUOTE.

Extend discovery and candle routing for swap venues in scanner-candidate-discovery.ts, scanner-candle-fetcher.ts, and index.ts:335. That current branch still returns empty for swap bindings, so Jupiter and 1inch scanners are effectively disabled.

Preserve exact DEX pricing identity through scan completion and hybrid sizing in complete-technical-scan.ts, runtime-composition.ts, and hybrid-agent-evaluator.ts.

Then run the focused worker tests listed in the plan, especially discovery, candle fetcher, technical phase, intake resolver, and actor tests.

If you want the most pragmatic first move, Phase 1 is the right next step: change the scanner contracts first, because the rest of the DEX work depends on those types no longer being orderbook-only.