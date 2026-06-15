# Plan: Admin Perp Venue Observability Panel

## Goal

Add a separate admin panel for perpetual-venue observability focused on
Hyperliquid and Bybit.

The panel should answer a narrow operator question set quickly:

1. are the perp venue intelligence feeds healthy and fresh
2. is Hyperliquid returning usable perp market context
3. is Bybit returning usable crowding data for the symbols we care about
4. are the shared provider budgets for these venues being exhausted or
   degraded
5. are stream-backed orderbook venues operating normally or obviously
   degraded

This is an admin observability feature, not a trader workstation and not a
strategy analytics console.

## Why A Separate Panel

The current admin market-data section is intentionally about discovery and
regime health. That boundary was deliberate in the v1 admin dashboard plan.

Perp venue status should be separated because it deals with a different asset
class, different sources of truth, and different operational questions:

1. discovery answers "what tokens are being found and are discovery providers
   healthy"
2. perp observability answers "are our execution-adjacent perp intelligence
   paths healthy and what market context are they currently seeing"

Keeping these concerns separate preserves the current v1 dashboard boundary and
avoids turning the discovery card into an overloaded market console.

## Product Principles

1. keep this read-heavy and operationally safe
2. prefer existing market-data provider surfaces before adding new storage or
   new domain models
3. distinguish venue status from trading performance
4. make freshness explicit on every snapshot
5. show operator-useful summaries, not raw market-data dumps
6. do not imply portfolio PnL, user exposure, or strategy correctness from
   venue telemetry alone
7. keep symbol scope operator-configurable rather than hard-coded

## Non-Goals

This feature does not attempt to provide:

1. user or agent PnL analytics
2. position inventory by user or venue account
3. realized or unrealized performance attribution
4. full orderbook visualization
5. live trade execution controls
6. automated venue failover policy
7. full stream-debug tooling for every actor session

## Current-State Baseline

The repo already has useful building blocks:

1. the admin dashboard has a market-data section and existing admin routes for
   discovery and provider budgets
2. Hyperliquid intelligence is already implemented via asset contexts with
   funding, annualized funding, open interest, mark or mid or oracle price,
   mark-oracle spread, 24h volume, and 24h price change
3. Bybit crowding data is already implemented via long or short ratio fetches
4. provider counters already exist for success, failure, freshness mode,
   waits, throttles, and last success time
5. Hyperliquid and Bybit already have execution-native public and private
   stream infrastructure in the venue layer

The main gap is not provider support. The gap is the lack of a dedicated,
persisted admin-facing snapshot for perp venue status and metrics.

## Operator Questions To Support

The first version of this panel should let an admin answer all of the
following without reading logs:

1. when did we last fetch Hyperliquid intelligence successfully
2. when did we last fetch Bybit crowding data successfully
3. are those results fresh, cached, stale, or missing
4. which tracked symbols currently show extreme funding or crowding
5. is Hyperliquid showing unusual mark-oracle divergence
6. are Hyperliquid or Bybit provider budgets being throttled
7. are the public or private streams obviously disconnected or flapping

## Proposed Information Architecture

Add a new section to the admin dashboard below the existing market-data
provisioning section:

### 1. Venue Health Summary

One compact card per venue.

For Hyperliquid:

1. status badge: healthy, degraded, stale, unavailable
2. last successful intelligence fetch
3. freshness mode: fresh or cached
4. tracked symbol count
5. provider success and failure counts
6. rate-limit waits and throttles
7. public stream status
8. private stream status

For Bybit:

1. status badge: healthy, degraded, stale, unavailable
2. last successful crowding fetch
3. freshness mode: fresh or cached
4. tracked symbol count
5. provider success and failure counts
6. rate-limit waits and throttles
7. public stream status
8. private stream status

### 2. Hyperliquid Perp Snapshot

A symbol table for the tracked perp set.

Columns:

1. symbol
2. mark price
3. oracle price
4. mark-oracle spread percent
5. funding rate
6. annualized funding percent
7. open interest
8. 24h volume USD
9. 24h price change percent
10. snapshot timestamp

### 3. Bybit Crowding Snapshot

A symbol table for the same tracked set where Bybit data exists.

Columns:

1. symbol
2. buy ratio
3. sell ratio
4. long-short ratio
5. period
6. sample timestamp
7. snapshot timestamp

### 4. Cross-Venue Warnings

An alert strip or card for operator-visible anomalies.

Initial warning candidates:

1. Hyperliquid mark-oracle spread above threshold
2. missing Bybit crowding sample for a tracked symbol
3. venue snapshot older than allowed freshness window
4. provider throttle count rising in the recent window
5. stream state disconnected or reconnecting

This should remain a status surface, not a decision engine.

## Scope For V1 Of This Panel

### Included

1. Hyperliquid intelligence snapshot publication
2. Bybit crowding snapshot publication for a configured symbol set
3. admin API route for perp venue overview
4. admin UI panel rendering summary cards and symbol tables
5. reuse of existing provider counters for Hyperliquid and Bybit
6. explicit freshness and last-success timestamps
7. minimal stream-health snapshot if a low-risk source exists
8. clear empty or degraded states when data is missing

### Explicitly Deferred

1. full orderbook depth display
2. execution fill history or recent orders in the same panel
3. per-user or per-agent venue exposure
4. cross-venue arbitrage analytics
5. historical charting inside the admin dashboard
6. custom symbol selection from the UI
7. alert acknowledgement workflows
8. auto-remediation or venue failover actions

## Data Model And Snapshot Contract

Use Redis-published snapshots, following the same pattern as discovery and
regime state.

### Redis keys

Suggested keys:

1. `market-intel:perps:meta`
2. `market-intel:perps:hyperliquid`
3. `market-intel:perps:bybit`
4. `market-intel:perps:last-error`
5. `market-intel:perps:stream-status`

### Snapshot shape

`market-intel:perps:meta`:

1. `snapshotId`
2. `capturedAt`
3. `symbols`
4. `freshness`
5. `nextPollDueAt`
6. `leaderWorkerId`

`market-intel:perps:hyperliquid`:

1. snapshot envelope fields
2. `assets: HyperliquidAssetContext[]`
3. `source: { ok, freshness, requestClass }`

`market-intel:perps:bybit`:

1. snapshot envelope fields
2. `signalsBySymbol: Record<string, BybitCrowdingSignal[]>`
3. `period`
4. `source: { ok, freshness, requestClass }`

`market-intel:perps:stream-status`:

1. venue name
2. public stream state
3. private stream state
4. last event timestamp if available
5. reconnect count if available
6. degraded reason if known

## Configuration

This must be operator config, not user config.

Add a dedicated perp-intelligence block under `marketIntelligence` rather than
overloading `benchmarkSymbols` or discovery config.

Suggested shape:

```yaml
marketIntelligence:
  perps:
    enabled: true
    pollMs: 30000
    maxAgeMs: 120000
    symbols:
      - BTC
      - ETH
      - SOL
    bybit:
      period: 1h
      limit: 1
    warnings:
      maxMarkOracleSpreadPct: 1.5
      maxFundingAbsPctAnnualized: 100
      minLongShortRatio: 0.7
      maxLongShortRatio: 1.5
```

Notes:

1. all thresholds should live in config, not in UI code
2. symbol scope should be explicit because the provider costs and admin signal
   quality depend on the tracked set
3. the defaults should be conservative and small

## Backend Design

### Worker

Extend the market-intelligence coordinator with a third loop for perp venue
intelligence.

Responsibilities:

1. fetch Hyperliquid asset contexts through the provider registry
2. filter down to the configured symbol set
3. fetch Bybit long-short ratios for the configured symbol set
4. record provider success, failure, freshness, waits, and throttles using the
   existing provider-counters helpers
5. publish normalized Redis snapshots
6. publish a `last-error` snapshot on failure

Important design choice:

Use the existing leader-election pattern so only one worker publishes the perp
snapshot at a time.

### API

Add a new route rather than bloating the current discovery overview route.

Suggested route:

1. `GET /admin/market-data/perps`

Response shape should include:

1. meta snapshot
2. Hyperliquid summary and per-symbol rows
3. Bybit summary and per-symbol rows
4. stream status snapshot if available
5. last error snapshot

The existing `/admin/market-data/providers` route should remain the source for
budget and counter rows. The new panel can either consume both endpoints or the
new endpoint can embed only the venue-specific counters it needs.

### Stream Status

This is the main unknown.

If a safe, shared worker-level stream health surface already exists, reuse it.
If not, implement a minimal aggregated snapshot rather than scraping logs.

Acceptable v1 stream fields:

1. connected boolean or state enum
2. last observed event at
3. reconnect count
4. using polling fallback boolean

If those fields are not available without invasive changes, ship the first
version of the panel without stream status and mark that subsection as a small
follow-up.

## UI Design

Add a new admin section, not a modal and not a new top-level page.

Suggested section title:

`Perp Venue Observability`

Suggested layout:

1. top row with one summary card per venue
2. warning strip below summary cards
3. Hyperliquid table
4. Bybit table
5. optional compact stream-health card

UI requirements:

1. every venue card shows freshness clearly
2. null or missing values render explicitly as unavailable, not zero
3. warnings should be rule-based and explain the triggering metric
4. avoid trader-style chart chrome; this is an operator console

## Symbol Scope Strategy

Use a fixed operator-configured tracked set for the first version.

Why:

1. it keeps provider cost bounded
2. it avoids unstable tables driven by whatever assets happen to be hottest
3. it lets the admin compare the same core symbols over time
4. it maps naturally onto Hyperliquid and Bybit shared perp coverage

Suggested initial symbols:

1. BTC
2. ETH
3. SOL

Optional later expansion:

1. add a few more operator-selected symbols
2. derive from current active agent watchlists only after a deliberate product
   decision

## Status Model

Keep venue status simple and deterministic.

Suggested rollup rules:

1. `healthy` when the latest snapshot is fresh and provider fetch succeeded
2. `degraded` when data is cached, partially missing, or warnings exceed
   thresholds
3. `stale` when snapshot age exceeds max age
4. `unavailable` when no valid snapshot exists

## Testing Plan

### Unit tests

1. Hyperliquid snapshot mapping and symbol filtering
2. Bybit snapshot aggregation by symbol
3. venue status rollup logic
4. warning generation rules
5. admin API response mapping for null, stale, and error states

### Route tests

1. `GET /admin/market-data/perps` returns empty-safe payload when Redis keys are
   absent
2. returns parsed snapshots when Redis contains valid JSON
3. ignores malformed JSON without crashing the admin route

### Worker tests

1. perp loop publishes Redis snapshots on success
2. records Hyperliquid and Bybit provider counters correctly
3. marks stale or unavailable correctly on failure
4. respects configured symbols and poll intervals

### UI tests

1. summary cards render healthy, degraded, stale, and unavailable states
2. Hyperliquid table renders metric columns with formatted null handling
3. Bybit table renders crowding fields and timestamps
4. warning strip renders threshold breaches

## Implementation Order

### Phase 1: Worker snapshot publication

1. extend config schema and default config for `marketIntelligence.perps`
2. add coordinator loop and Redis snapshot writes
3. record Hyperliquid and Bybit provider counters during this loop

### Phase 2: Admin API

1. add `GET /admin/market-data/perps`
2. define client-side types for the new payload
3. keep the route tolerant of missing or malformed Redis entries

### Phase 3: Admin UI

1. add a new React Query fetch for the perp route
2. render the separate admin section
3. add warning and empty-state handling

### Phase 4: Follow-up instrumentation

1. wire stream-health snapshot if low-risk hooks exist
2. add richer warning thresholds if needed

## Risks And Tradeoffs

1. stream-health status may not yet have a safe shared aggregation surface,
   which makes that slice more expensive than the provider snapshot work
2. Bybit crowding is symbol and period specific, so careless defaults could
   create misleading comparisons
3. a larger symbol set increases rate usage and UI noise quickly
4. showing venue metrics without freshness can create false confidence, so
   freshness must be first-class in the payload and UI

## Open Questions

1. should stream health be required for v1 of this panel or explicitly deferred
   to a follow-up
2. should Bybit symbols use `BTC`-style canonical names in config and map to
   venue-specific symbols internally, or should config store venue-specific
   names such as `BTCUSDT`
3. should warning thresholds be purely operator-configurable, or should the UI
   have fixed display heuristics for color only

## Recommended Next Step

Implement this as a new admin dashboard section backed by a new
`/admin/market-data/perps` route and a worker-published Redis snapshot. That
keeps the discovery dashboard stable, reuses the existing market-intelligence
architecture, and adds only one new observability contract instead of several
ad hoc APIs.