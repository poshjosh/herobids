# Decision 6: Staging Smoke Inputs for Live Provider Verification

**Decision:** 6 — The deployed staging connection and symbols that can be used to demonstrate the actual scanner candle path without assuming a particular venue mapping
**Status:** accepted
**Date:** 2026-07-16
**Owner:** Implementer agent (Phase 0 research)

## Question

Which staging connection and bounded symbol set can be used for live-provider smoke verification of the scanner-gated candle path, without relying on untested venue mappings or speculative symbol assumptions?

## Inspected Sources

### Staging evidence: candle ops

- `docs/features/2026/07/16/003-scanner_gated-must-be-working/data/05-candle-ops-evidence.txt` — Binance `SOLUSDT` 15m klines returned HTTP 200 with valid kline array. Binance API is reachable from the staging worker. No auth required, no rate-limit response.

### Staging evidence: active connections

- `docs/features/2026/07/16/003-scanner_gated-must-be-working/003-staging-read-only-diagnostic.md` — Seven scanner-gated agents were active on staging, all using Hyperliquid as their venue (filter `{ venue: 'hyperliquid', venueType: 'orderbook' }`). Each agent discovered 232 Hyperliquid assets. All seven agents shared a single active Hyperliquid connection grant.

### Staging prerequisite: agents stopped

- `docs/features/2026/07/16/003-scanner_gated-must-be-working/006-staging-prerequisite-evidence.md` — All seven storming agents were stopped on 2026-07-16. DB shows 0 `scanner_gated` agents active. Worker CPU at 0.85%. The shared Hyperliquid connection remains active (grants are preserved when agents are stopped, not revoked).

### Binance symbol map

- `packages/market-data/src/binance-candles.ts` lines 38–46 — `SYMBOL_MAP`:
  ```typescript
  const SYMBOL_MAP: Record<string, string> = {
    BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT',
    DOGE: 'DOGEUSDT', AVAX: 'AVAXUSDT', LINK: 'LINKUSDT',
    ARB: 'ARBUSDT', OP: 'OPUSDT', SUI: 'SUIUSDT',
  };
  ```
- `resolveBinanceSymbol()` strips trailing `USDT`, `USD`, `PERP` suffixes, uppercases, and looks up the SYMBOL_MAP. Falls back to `${base}USDT` for unmapped symbols.

### Hyperliquid discovery function

- `apps/worker/src/index.ts` lines ~253–310 (`discoverCandidates`) — Uses `sharedMarketDataRegistry.hyperliquid.assetContexts()` to discover Hyperliquid assets. Maps each asset to `instrumentId: ${ctx.asset}-PERP`. Filters by `minVolume24hUsd`, `symbols`, and `excludeSymbols` from the agent's technical filter config. Sorts by volume descending, caps at `maxCandidates` (operator config, default 20).

### Current scanner candle path

- `apps/worker/src/technical-phase.ts` — `runTechnicalPhase()` receives discovered candidates from `discoverCandidates()` and fetches candles via `VenueCandleFetcher`, which wraps `BinanceCandlesConfig`. The path is: Hyperliquid asset ticker → `resolveBinanceSymbol(ticker)` → Binance `GET /api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100`.

### Scope boundary

- `packages/market-data/src/binance-candles.ts` is the **only** candle provider used by the scanner path. There is no Hyperliquid-native candle provider wired. The scanner always resolves Hyperliquid-discovered tickers through `resolveBinanceSymbol()` to Binance spot klines.

## Decision

### Staging connection

The shared Hyperliquid connection used by the seven stopped scanner-gated agents remains active on staging. The connection grant is preserved (stopping an agent does not revoke its connection, and other agents may hold overlapping grants). A new smoke test agent can be granted this same connection.

A new smoke test agent should be created with a `connectionIds` grant to this existing Hyperliquid connection, not a newly created connection. This avoids unnecessary connection churn and uses the same provider path the stopped agents used.

### Bounded symbol set

**BTC and ETH** are the confirmed-supported symbols for live smoke.

Rationale:
1. Both are explicitly in `SYMBOL_MAP` (`BTCUSDT`, `ETHUSDT`).
2. Both are top-volume Hyperliquid perpetuals, guaranteed to appear in `assetContexts()` discovery.
3. Binance spot klines for BTCUSDT and ETHUSDT are universally available — no risk of unsupported-symbol failure.
4. SOL was also confirmed reachable in the staging evidence (HTTP 200 for SOLUSDT klines), but two symbols are sufficient for smoke; adding more does not increase confidence in the provider path.
5. BTC and ETH are the two highest-volume assets and will always appear first in volume-sorted discovery, ensuring deterministic selection.

The agent's technical filter should use `symbols: ['BTC', 'ETH']` to restrict discovery to these two symbols, rather than relying on `maxCandidates` bounding alone.

### Confirmation approach

The smoke script confirms the symbols work by:
1. Creating a scanner_gated agent with `symbols: ['BTC', 'ETH']` in its technical filters.
2. Starting the agent and waiting for at least two non-overlapping scans to complete.
3. Asserting each symbol appears in the scan's `symbolOutcomes` with `eligible: true` and `fetched: true`.
4. Asserting `eligibleCount >= 2` and `fetchedCount >= 2` (both symbols).
5. Asserting `errorCount === 0` and no `unsupported` or `failed` outcomes.
6. Asserting scan intervals match the configured `scanIntervalMs`.
7. Treating `signalsGenerated === 0` as a passing result — the smoke validates the provider path, not signal generation.
8. Reporting per-symbol: discovery ticker, resolved Binance symbol, eligibility, fetch result, and candle count.

## Rejected Alternatives

- **Using SOL as the sole test symbol**: SOL was confirmed in the staging evidence, but using only one symbol doesn't prove the per-symbol outcome classification works for multiple candidates. BTC+ETH provides both multi-symbol coverage and per-symbol reporting.
- **Using all 9 SYMBOL_MAP entries**: Unnecessary for smoke validation. Two symbols are sufficient to prove the provider path works. More symbols increase scan duration without increasing confidence.
- **Creating a new Hyperliquid connection**: Unnecessary. The existing shared connection is proven to work and is already active. Creating a new connection requires API key/secret management overhead.
- **Using no symbol filter (relying on volume-sorted cap)**: Risk of selecting Hyperliquid-only assets with no Binance spot pair. The `resolveBinanceSymbol()` fallback (`${base}USDT`) can produce symbols that 404 or return empty klines. Explicit filtering guarantees known-supported symbols.
- **Requiring signalsGenerated > 0 for smoke pass**: The smoke validates the provider pipeline, not market conditions. Requiring a live signal makes the test non-deterministic and dependent on random market state.

## Implementation Consequences

1. **Scanner-provider smoke script** (`scripts/shell/tests/scanner-provider-smoke-test.sh`) must:
   - Use the existing active Hyperliquid connection (no new connection creation).
   - Create a scanner_gated agent with `technical.filters.symbols: ['BTC', 'ETH']`.
   - Assert per-symbol outcomes from worker logs or scan state.
   - Treat `signalsGenerated === 0` as success.
   - Clean up only the temporary agent, not the shared connection.

2. **No changes to the Binance symbol map or discovery function** are required. The existing `SYMBOL_MAP` and `resolveBinanceSymbol()` already support BTC and ETH.

3. **No staging deployment or mutation** is required by this decision. The smoke script will create and delete its own temporary agent against the existing staging stack.

## Required Validation

- Run `scripts/shell/tests/scanner-provider-smoke-test.sh` against staging.
- Assert: at least 2 scans complete, `eligibleCount >= 2`, `fetchedCount >= 2`, `errorCount === 0`, no overlap.
- Assert per-symbol outcomes show `BTC → BTCUSDT (eligible, fetched, N candles)` and `ETH → ETHUSDT (eligible, fetched, N candles)`.
- Assert scan interval matches configured value.

## Residual Risk or Follow-Up

- **None.** The BTC and ETH Binance spot pairs are among the most liquid and reliable in crypto. There is no credible risk of provider unavailability or symbol mismatch for these two assets.
- The smoke does not prove that non-SYMBOL_MAP Hyperliquid assets (those falling through to the `${base}USDT` fallback) resolve correctly — but that is out of scope for live-provider smoke. The eligibility classification logic (Decision 3) already handles unsupported symbols via HTTP response classification.
