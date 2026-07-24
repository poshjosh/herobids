# Item 6 Investigation: Why the scanner runs only for mo-day

**Date:** 2026-07-24
**Status:** Findings complete — root cause identified

## TL;DR

All three agents **are** running their scan loops. The scanner discovers 20 candidates
for each. The root cause is a **casing mismatch**: the preset YAML files and the Zod schema
use uppercase `"4H"` / `"1H"` for swing/range intervals, but Binance requires lowercase
`"4h"` / `"1h"`. Every candle fetch for swing (4H) and range (1H) returns HTTP 400,
classified as `unsupported`. mo-day's `"15m"` works because `m` is naturally lowercase.

---

## 1. Are all three agents scheduled?

**YES.** Contrary to the evaluation report's claim that only `agent-actor-ce7f3bb2`
appears in worker logs, grep of the raw log file shows all three agent-actors:

```
agent-actor-ce7f3bb2  → mo-day (momentum, 15m)
agent-actor-bf766ce0  → swing  (4H)
agent-actor-72de91ec  → range  (1H)
```

All three complete their `"Technical phase complete"` log with `candidatesDiscovered: 20`:

| Timestamp | mo-day scored | swing scored | range scored |
|-----------|---------------|--------------|--------------|
| 06:34:37 | 18 | — | — |
| 06:35:31 | 13 | 0 | 0 |
| 06:36:31 | 18 | 0 | 0 |
| 06:37:31 | 13 | 0 | 0 |
| 06:38:31 | 18 | 0 | 0 |
| 06:39:31 | 13 | 0 | 0 |

swing and range discover candidates, enter the scan pipeline, and run `runTechnicalPhase`
to completion — they just score **zero** of the 20 discovered candidates.

---

## 2. Do they reach the scan pipeline?

**YES.** All three agents call `runTechnicalScan()` → `runTechnicalPhase()` →
`discoverCandidates()` → `fetchCandles()`. The pipeline runs end-to-end.

- `discoverCandidates()`: All three use the same `buildDiscoverCandidates` closure
  (same venue = `hyperliquid`, same `FilterConfig` with only venue/venueType, no
  volume/symbol filters). All three discover 20 candidates from Hyperliquid asset
  contexts.
- `pre-filter` (`normalizeOrderbookCandidates`): No filtering occurs — all 20 pass
  through (the function only maps provider symbols via `resolveBinanceSymbol`, which
  always returns a string).

---

## 3. What blocks swing and range?

**Candle fetch failures.** Distribution across the log window (~5 scans each):

| Agent | Interval | `unsupported` | `transient_failure` | Scored | Signals |
|-------|----------|---------------|---------------------|--------|---------|
| mo-day | `15m` | 10 | 68 | 13–18 | 8–11 |
| swing | `4H` | **95** | 5 | **0** | **0** |
| range | `1H` | **55** | 45 | **0** | **0** |

`unsupported` = `classifyCandleError()` matched `HTTP error: 400`. Symbols that fail
for swing/range include **BTC, ETH, SOL** — major assets that definitely exist on
Binance. mo-day's unsupported symbols are genuinely missing (HYPE, CASHCAT).

---

## 4. Root cause: Binance interval casing mismatch

### The bug chain

1. **Preset YAML** (`config/strategy-presets/{economy,standard,premium}.yaml`) defines:
   - `candleInterval: "4H"` for swing presets
   - `candleInterval: "1H"` for range presets
   - `candleInterval: "15m"` for momentum/day presets

2. **Zod schema** (`packages/domain/src/config/schema.ts:1920`):
   ```ts
   candleInterval: z.enum(['5m', '15m', '1H', '4H', '1D']).default('15m'),
   ```
   The enum accepts uppercase `H` — validation passes, no transform applied.

3. **No normalization anywhere in the fetch chain:**
   - `VenueCandleFetcher.fetchCandles()` passes `interval` straight through
   - `fetchBinanceCandles()` constructs the URL as-is:
     ```
     /api/v3/klines?symbol=BTCUSDT&interval=4H&limit=48
     ```
   - **Binance requires lowercase**: `1h`, `4h`, not `1H`, `4H`
   - Binance returns HTTP 400 Bad Request for uppercase H intervals

4. **`classifyCandleError()`** classifies HTTP 400 as `'unsupported'`, so the
   scanner treats these as permanent failures and adds them to the per-scan skip set.

5. **GeckoTerminal path is already case-safe** — `mapIntervalToTimeframe()` calls
   `interval.toLowerCase()` before checking `endsWith('h')`. Only the Binance path
   has the bug.

### Why `15m` works

`"15m"` uses a naturally lowercase `m` — it doesn't need normalization. The schema
default is also lowercase (`'15m'`), so only agents with explicitly-configured
intervals containing uppercase `H` are affected.

### Why `5m` would also work

The scalper preset uses `"5m"` — also lowercase `m`. Only `"1H"` and `"4H"` (and
hypothetically `"1D"`) have casing issues with Binance.

### Rate limiting is a compounding factor, not the cause

mo-day's scan completes first (06:34:37), consuming rate-limit tokens. swing and
range's scans start shortly after and face an already-depleted limiter. However, even
without rate limiting, ALL swing/range candle fetches would fail with HTTP 400 due
to the interval casing bug. Rate limiting just changes some failures from
`unsupported` (HTTP 400) to `transient_failure` (rate-limit rejection before the
HTTP call).

---

## 5. Fix location

The minimal fix is to lowercase the interval in `fetchBinanceCandles()` (or in
`VenueCandleFetcher.fetchCandles()` for the Binance path), e.g.:

```ts
// In fetchBinanceCandles():
const interval = (options?.interval ?? '1h').toLowerCase();
```

This is a one-line change that:
- Fixes swing, range, and any future preset using uppercase intervals
- Is backward-compatible (already-lowercase intervals are unchanged)
- Has no performance impact
- Doesn't require schema or preset YAML changes

A complementary fix (lower priority): change the schema enum to lowercase
`['5m', '15m', '1h', '4h', '1d']` and add a `.toLowerCase()` transform so
new configs are stored correctly from the start. Existing uppercase configs
in the DB would also need a migration or the runtime normalization above.

---

## 6. Corroborating evidence from other eval data

- **DB:** Only mo-day (`ce7f3bb2`) has decisions; swing and range have zero.
- **Redis scanner fingerprint:** Only mo-day has entries (`agent:scanner:fingerprint:ce7f3bb2`).
  swing and range have no fingerprints because the scan never reaches the fingerprint
  computation step (it's after scoring, which is zero).
- **Agent container logs:** swing and range show `"timer tick without wake signal — skipping
  LLM dispatch"` — correct behavior given that the scanner produces no signals → no wakes.
- **`agent_scan_metrics`:** Item 5 (just deployed) would now show `scan_health: 'data_path_failure'`
  for swing/range, confirming scans ran but produced no candidates.
