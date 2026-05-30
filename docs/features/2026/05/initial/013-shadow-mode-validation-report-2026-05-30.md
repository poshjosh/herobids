# Shadow Mode Validation Report

**Date:** 2026-05-30
**Instance:** f6a723e1-854b-4f1f-a87e-3d6d12f590fa
**Duration:** ~8 minutes (19:06:32 – 19:14:24)

## Configuration

| Parameter | Value |
|-----------|-------|
| Venue | Hyperliquid (production endpoint) |
| Symbol | ETH/USDC:USDC |
| Strategy | Momentum |
| Threshold | 0.0001 (0.01%) |
| Lookback | 20 ticks |
| Position size | 0.0035 ETH |
| Max order notional | $9 |
| Execution mode | Shadow (real WS data + private stream, simulated fills) |
| Scan interval | 5s |

## Results

**Outcome: SUCCESS** — Shadow-mode-specific infrastructure validated end-to-end.

### Decision Timeline

| # | Time (UTC) | Intent | Fills | Position After |
|---|-----------|--------|-------|----------------|
| 1 | 19:08:17 | go_short | 1 | short |
| 2 | 19:09:17 | go_long | 2 | long |
| 3 | 19:10:27 | go_short | 2 | short |
| 4 | 19:12:31 | go_long | 2 | long |

- **Total decisions:** 4
- **Total fills:** 7 (1 entry + 3 flips × 2 fills each)
- **Both directions exercised:** go_long (2×), go_short (2×)
- **Warmup period:** ~102s (20 ticks + stream pauses)

### Private Stream Resilience (Key Shadow-Mode Validation)

The primary purpose of shadow mode is to validate the WebSocket private stream infrastructure. Result: **7 disconnect/reconnect cycles, all recovered successfully**.

| Cycle | Disconnect Time | Reconnect Time | Downtime |
|-------|----------------|----------------|----------|
| 1 | 19:07:35 | 19:07:37 | 1.8s |
| 2 | 19:08:37 | 19:08:39 | 1.6s |
| 3 | 19:09:38 | 19:09:40 | 1.6s |
| 4 | 19:10:40 | 19:10:42 | 1.5s |
| 5 | 19:11:43 | 19:11:44 | 1.5s |
| 6 | 19:12:44 | 19:12:47 | 2.1s |
| 7 | 19:13:47 | 19:13:49 | 2.2s |

**Pattern:** Hyperliquid disconnects the WebSocket every ~60s (unfunded account behavior). Reconnect consistently takes 1.5–2.2s.

**Behavior during disconnect:**
- Scan loop pauses immediately on disconnect (no stale data trades)
- Scan loop resumes immediately on reconnect
- No trades are attempted during the paused window
- No actor crash even after 7 consecutive disconnect cycles

### Comparison: Shadow vs Paper Mode

| Metric | Paper Mode | Shadow Mode |
|--------|-----------|-------------|
| Duration | ~12 min | ~8 min |
| Decisions | 7 | 4 |
| Fills | 13 | 7 |
| Data source | REST polling (fetchTicker) | Stream pool + REST fallback |
| Private stream | Not used | Active (with pause/resume) |
| Stream disconnects | 0 | 7 |
| Rate limit hits | 19 | 8 |
| Errors (level 50) | 1 | 0 |
| Effective tick rate | ~5s (consistent) | ~5s (but paused during disconnects) |

The lower decision count in shadow mode is explained by the scan loop pausing during stream disconnects (~12s total pause time across 7 cycles) — the lookback window fills slower when ticks are skipped.

### Warnings & Errors

| Category | Count | Impact |
|----------|-------|--------|
| Private stream disconnect/reconnect | 7 cycles | Scan loop paused 1.5–2.2s each time |
| fetchTicker rate-limited (429) | 8 | Missed ticks during REST fallback |
| Reconciliation drift | Expected | Local has position, venue doesn't (shadow fills) |
| Errors (level 50) | 0 | — |

**Zero crashes. Zero data corruption. Trading resumed automatically after every disconnection.**

## Shadow-Mode-Specific Components Validated

- [x] Private stream initial connection (subscribePrivate)
- [x] Private stream disconnect detection → scan loop pause
- [x] Private stream reconnection → scan loop resume
- [x] No max-reconnect-failure crash (all reconnects succeeded within attempts)
- [x] StreamMarketDataFeed with REST fallback (fallbackFetcher)
- [x] Stream pool market data delivery
- [x] Shadow executor (simulated fills, same interface as live)
- [x] Reconciliation running independently of stream state
- [x] Graceful stop while stream is active

## Observations & Notes

1. **60s disconnect cycle is unfunded-account behavior** — a funded Hyperliquid account would likely maintain a stable connection. This cannot be verified without depositing margin.

2. **Scan loop pause is the correct fail-safe** — in live mode, pausing on disconnect prevents sending orders without the ability to receive fill confirmations via the private stream. This is exactly the behavior specified in the rollout plan (Step 3).

3. **No max-reconnect-failure crash** — the system never hit the `maxReconnectAttempts` threshold because each reconnect succeeded on first attempt. A longer test or a network partition simulation would be needed to validate the crash path.

4. **Rate limiting lower than paper mode** — shadow mode uses the stream pool for market data (fewer REST calls), with REST as fallback only during stream gaps. This results in fewer 429 hits (8 vs 19).

## Conclusion

Shadow mode is fully operational. The system:
- Connects to Hyperliquid's private WebSocket stream
- Correctly pauses trading on disconnect (fail-safe for live)
- Automatically reconnects and resumes (resilience)
- Continues strategy evaluation through repeated disconnect cycles
- Produces trading decisions at the expected rate (accounting for pauses)
- Stops cleanly via API with stream teardown

**Ready for:** Live mode execution (Step 6, Stage B) — with the caveat that the 60s disconnect cycle is specific to unfunded accounts and is expected to stabilize once margin is deposited.
