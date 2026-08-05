# 001 — Scanner-gated agents never reach the LLM: stale technical-scan data blocks the hybrid evaluator

- **Status:** OPEN
- **Severity:** HIGH
- **Date:** 2026-08-05
- **Discovered:** Agent evaluation session (2026-08-05) — two of three trading agents (`thyper`, `t1inch`) executed zero trades and never dispatched a single LLM call
- **Environment:** staging (Hetzner, `128.140.55.192`)
- **Affected agents:** `thyper` (`92973681-d4fc-40f2-8ded-424810655b7e`), `t1inch` (`66664f0b-d3bf-47ab-beb9-20ef3394b450`)

## Summary

Two scanner-gated (hybrid) trading agents on staging executed **zero trades** and **never dispatched a single LLM call** during the evaluation window (2026-08-05 03:51–07:03 UTC). The technical scanner produced real signals (e.g. `TAO-PERP go_short`, confidence 0.45), but the agent's **hybrid evaluator aborted with `stale_scan` on every run** before reaching the LLM.

**Two independent root causes are confirmed:**

1. **thyper — wake message consumed by the wrong consumer group (race condition).** The `agent.wake` message is published to the same `agent:outbound:<id>` stream that has two consumer groups. The `agent-market-wake` group (polled continuously) and the `agent-runtime` group (drained once per tick) race to consume the same wake message. When the wake group wins, the runtime group never sees it → `currentMarketWake` is null when the tick runs → "timer tick without wake signal" → the hybrid evaluator never routes to the LLM. This also causes the `agent-runtime` group to lag (149 for thyper), so `lastTechnicalScan` is stale → `stale_scan` abort.

2. **t1inch — base discovery suppressed by antistaleness.** The t1inch swap scanner (network `base`) calls `registry.discovery.discover({ networks: ['base'] })`, which returns **zero base tokens**. The discovery providers return base tokens when queried directly, but the **antistaleness cooldown (4h)** marks all base tokens as "stale" (recently seen) and they get sliced off when 47 solana tokens fill the 50-slot `maxResults` limit. Without candidates, no scanner wake is emitted, so t1inch never activates.

Historical data shows this is a **latent design weakness, not a recent code regression** — the scanner-gated path has traded successfully many times before (07/22, 07/23, 07/25, 07/29, 08/01, 08/03).

## Symptoms

### Agent-level (from agent container logs)

**`thyper` (`92973681-d4fc-40f2-8ded-424810655b7e`)** — `logs/agent.log`:
- **19** × `"Hybrid agent: routing to single-shot evaluator (scanner wake)"`
- **19** × `"Hybrid evaluator: technical scan data is stale — skipping"` with `errors: ["stale_scan"]`
- **0** × `"Hybrid evaluator complete"` with a successful LLM dispatch
- **0** decisions submitted

**`t1inch` (`66664f0b-d3bf-47ab-beb9-20ef3394b450`)** — `logs/agent.log`:
- **0** × `"Received market wake signal"` — the scanner produced **zero candidates** (`candidatesDiscovered: 0`, `scannerHealth: no_candidates`), so no scanner wake was ever emitted
- Every tick: `"Hybrid agent: timer tick without wake signal — skipping LLM dispatch"`

### Redis consumer-group lag (the smoking gun)

`XINFO GROUPS agent:outbound:<agentId>` at ~07:23 UTC:

| Agent | Group | entries-read | **lag** | last-delivered |
|---|---|---|---|---|
| thyper | `agent-market-wake` | 589 | **0** | current |
| thyper | `agent-runtime` | 440 | **149** | 07:11:40 |
| t1inch | `agent-market-wake` | 547 | **0** | current |
| t1inch | `agent-runtime` | 141 | **406** | 06:49:53 |
| tplaybook (working) | `agent-market-wake` | 123 | 0 | current |
| tplaybook (working) | `agent-runtime` | 101 | **22** | 07:10:49 |

The `agent-market-wake` group (polled continuously) stays current (lag 0), so **wake signals arrive on time**. But the `agent-runtime` group (drained once per tick) **falls behind** — lag 149 (thyper) and 406 (t1inch). The technical-scan state is delivered on the lagging `agent-runtime` group, so `lastTechnicalScan` is stale when the evaluator runs.

### Timing evidence (thyper agent log)

```
05:09:48 | Processing market wake signal
05:09:49 | Hybrid agent: routing to single-shot evaluator (scanner wake)
05:09:49 | Hybrid evaluator: technical scan data is stale — skipping scan_ts=2026-08-05T04:30:33.114Z
```

The scan timestamp (`04:30:33`) is ~39 minutes older than the evaluator run (`05:09:49`), far exceeding the 120s freshness window.

### Worker-level (from worker logs)

- The scanner runs every **60s** (`scanIntervalMs: 60000`) and publishes `agent.technical.scan_completed` messages. Confirmed **209** such messages for thyper and **210** for t1inch in their outbound streams.
- The scanner produced real signals for thyper (e.g. `TAO-PERP go_short` at 07:15:39, `scannerHealth: healthy_signals`).
- `Technical phase: candle fetch unsupported — skipping instrument` for HYPE-PERP, CASHCAT-PERP, FARTCOIN-PERP (HTTP 400 from `fetchBinanceCandles`).

## Root Cause Hypothesis

### Primary (CONFIRMED): Wake message consumed by the wrong consumer group → `currentMarketWake` null → stale scan

The mechanism (verified against source and Redis state):

1. **Two consumer groups on one stream.** Both the `agent.wake` message and the `agent.technical.scan_completed` message are published to the same `agent:outbound:<id>` stream (`apps/worker/src/agents/instance-event-publisher.ts:188-215`). Two groups read it:
   - `agent-market-wake` — polled continuously by `pollWakeSignals()` (`agent.ts:1390`), consumes `agent.wake` → triggers early tick.
   - `agent-runtime` — drained once per tick by `readOutboundMessages()` (`agent.ts:1358`), consumes ALL messages including `agent.wake` and `agent.technical.scan_completed`.

2. **Redis Streams delivers each message to only ONE group.** When the wake group consumes an `agent.wake` message, the runtime group does NOT receive it.

3. **The wake group wins the race.** The wake group polls continuously (`WAKE_SIGNAL_POLL_MS`), so it consumes `agent.wake` messages before the runtime group's per-tick read. When the early tick fires, `runTick()` calls `readOutboundMessages()` (runtime group), which does NOT see the wake → `currentMarketWake` stays null → "timer tick without wake signal" → LLM dispatch skipped.

4. **Downstream: consumer-group lag → stale scan.** Because the runtime group only reads once per tick (15 min) with `COUNT 10` (`outbound-message-reader.ts:25`), and the scanner produces ~1 message/min, the runtime group falls behind (lag 149 for thyper). The `agent.technical.scan_completed` messages (which update `lastTechnicalScan`) are stuck in the lagging group, so `lastTechnicalScan` is stale when the evaluator runs.

5. **The freshness gate aborts.** `isTechnicalScanFresh()` (`hybrid-agent-evaluator.ts:13`) rejects any scan older than `2 × scanIntervalMs` (120s). The stale scan → `stale_scan` error (`hybrid-agent-evaluator.ts:215-218`) → evaluator returns before the LLM call.

**Evidence of the race (08/05 thyper vs 07/25 scalper):**

| Metric | 08/05 thyper (broken) | 07/25 scalper (working) |
|---|---|---|
| Received market wake | 36 | 25 |
| Processing market wake | 19 | 23 |
| routing single-shot | 19 | 23 |
| timer tick no wake | **20** | **2** |

On 07/25, 92% of wakes reached the runtime group (23/25). On 08/05, only 53% did (19/36); 20 wakes were "lost" to the wake group.

### Why did wake-driven tick acceleration fail on 08/05? (CONFIRMED)

**The wake signals DID accelerate ticks — but the wake message was consumed by the wrong consumer group, so `currentMarketWake` was null when the tick ran.**

The evidence (08/05 thyper agent log):

| Metric | 08/05 thyper (broken) | 07/25 scalper (working) |
|---|---|---|
| Received market wake | 36 | 25 |
| Processing market wake | 19 | 23 |
| routing single-shot | 19 | 23 |
| timer tick no wake | **20** | **2** |

On 07/25 (working), **23 of 25 wakes (92%)** resulted in "Processing market wake" → routing to single-shot. On 08/05 (broken), only **19 of 36 wakes (53%)** resulted in "Processing market wake"; **20 ticks** said "timer tick without wake signal".

**The mechanism (verified against source):**

1. Both the `agent.wake` message and the `agent.technical.scan_completed` message are published to the **same** `agent:outbound:<id>` Redis stream (`apps/worker/src/agents/instance-event-publisher.ts:188-215`).
2. There are **two consumer groups** on that stream:
   - `agent-market-wake` — polled continuously by `pollWakeSignals()` (`agent.ts:1390`), consumes `agent.wake` messages → calls `requestWakeDrivenTick()` → schedules an early tick.
   - `agent-runtime` — drained once per tick by `readOutboundMessages()` (`agent.ts:1358`), consumes ALL messages including `agent.wake` and `agent.technical.scan_completed`.
3. **Redis Streams consumer groups deliver each message to only ONE group.** When `pollWakeSignals` (wake group) consumes an `agent.wake` message, the `agent-runtime` group does NOT receive it.
4. When the early tick fires, `runTick()` calls `readOutboundMessages()` (agent-runtime group). It does NOT see the `agent.wake` message (already consumed by the wake group), so `currentMarketWake` stays null → "timer tick without wake signal" → LLM dispatch skipped.
5. On 08/05, the wake group consumed the wake messages faster than the agent-runtime group could read them (the wake group polls continuously, the runtime group reads once per tick), so most wakes were "lost" to the runtime group.

**Why this differs from 07/25 (working):** On 07/25, the wake messages were consumed by the `agent-runtime` group (via `readOutboundMessages`) before the wake group's `pollWakeSignals` could consume them — so `currentMarketWake` was set when the tick ran. On 08/05, the wake group won the race, consuming the wake messages first, so the runtime group never saw them.

**This is a race condition between the two consumer groups** on the same stream. The wake group's continuous polling (`WAKE_SIGNAL_POLL_MS`) races with the runtime group's per-tick read. When the wake group wins, the wake is "lost" to the runtime group, and the tick runs without `currentMarketWake`.

### Secondary: t1inch scanner produces zero candidates (CONFIRMED — independent failure)

`t1inch`'s scanner produced **zero candidates** (`candidatesDiscovered: 0`, `scannerHealth: no_candidates`, reason "No candidates discovered — check venue binding and filters"). Without candidates, no scanner wake is emitted, so the agent never activates. This is a **separate issue** from the consumer-group lag — even if the lag were fixed, t1inch would remain idle until its scanner finds candidates. This same pattern was seen on 07/22 and 07/23 for the `swing` and `range` agents.

**Root cause (confirmed):** The t1inch swap scanner is configured for **1inch on network `base`** (worker log: `Swap scanner configuration validated`, `network: "base"`, `quoteAssetSymbol: "USDC"`). The swap scanner calls `registry.discovery.discover({ networks: ['base'] })`, which returns **zero base tokens**. Evidence:

- Worker log: `"Swap scanner discovery returned no tokens"` (`scanner.swap_discovery_empty`) every 60s.
- Redis `market-intel:discovery:latest` → **47 tokens, all solana, 0 base**.
- Redis `market-intel:discovery:by-network:base` → `tokens: []`.
- Redis `market-intel:discovery:meta` → `networkCounts: {"solana": 47}`.

**Why base tokens are missing from the discovery snapshot:** The discovery providers (geckoterminal/dexscreener) DO return base tokens when queried directly (verified: geckoterminal `base/pools` returns 20 pools with liquidity in the millions). However, the **antistaleness cooldown** (`antistalenessCooldownHours: 4`, `config/default.yaml:353`) suppresses base tokens from the snapshot. The `RedisDiscoverySeenTracker.applyAntiStaleness()` (`packages/market-data/src/discovery-seen-tracker.ts:44-70`) moves recently-seen tokens to the end of the list, and `discoverTokens()` then slices to `maxResults` (50) (`packages/market-data/src/discovery.ts:210`). Since base tokens are continuously re-discovered and re-marked-seen (seen:base zset has 186 entries at 70 timestamps over 13 hours), they are always within the 4-hour cooldown → always "stale" → moved to the end → sliced off when 47 solana tokens fill the 50-slot limit.

**Impact:** The t1inch swap scanner never receives base candidates, so it never emits a scanner wake, so the agent never activates. This is a **separate, independent bug** from the consumer-group lag.

## Evidence References

### Eval data (primary)

All paths relative to repo root. The full evaluation report is at `.ignore/eval/2026/08/05/REPORT.md`.

| Path | Content |
|---|---|
| `.ignore/eval/2026/08/05/REPORT.md` | Full evaluation report (analysis, §3.9 historical review) |
| `.ignore/eval/2026/08/05/redis/consumer-groups.txt` | **Redis `XINFO GROUPS` lag evidence (root cause)** |
| `.ignore/eval/2026/08/05/92973681-d4fc-40f2-8ded-424810655b7e/01/logs/agent.log` | thyper agent log (19 stale_scan, 19 routing) |
| `.ignore/eval/2026/08/05/92973681-d4fc-40f2-8ded-424810655b7e/01/bundle.json` | thyper export bundle |
| `.ignore/eval/2026/08/05/66664f0b-d3bf-47ab-beb9-20ef3394b450/01/logs/agent.log` | t1inch agent log (0 wakes, 0 candidates) |
| `.ignore/eval/2026/08/05/66664f0b-d3bf-47ab-beb9-20ef3394b450/01/bundle.json` | t1inch export bundle |
| `.ignore/eval/2026/08/05/logs/worker.log` | Worker log (scan loop, candle 400s) |
| `.ignore/eval/2026/08/05/db/scan_candidates.json` | Scanner candidates (thyper only) |
| `.ignore/eval/2026/08/05/db/agent_messages.json` | Agent messages |
| `.ignore/eval/2026/08/05/db/agent_sessions.json` | Agent runtime sessions |

### Historical eval data (for regression analysis)

| Path | Relevance |
|---|---|
| `.ignore/eval/2026/07/22/mo-day/01/logs/agent-mo-day-tail-1000.log` | mo-day (scanner_gated, ~1-min wake ticks) — 109 routing, 6 stale_scan, **traded 382 decisions** |
| `.ignore/eval/2026/07/22/REPORT.md` | Confirms mo-day traded via hybrid evaluator; swing/range idle (0 wakes) |
| `.ignore/eval/2026/07/23/mo-day/01/logs/agent.log` | mo-day (scanner_gated, ~1-min wake ticks) — 21 routing, 0 stale_scan, **traded 776 decisions** |
| `.ignore/eval/2026/07/23/REPORT.md` | Confirms `scanIntervalMs=60000` wake loop; swing/range idle (0 scan candidates) |
| `.ignore/eval/2026/07/25/3f5198f1-.../01/logs/agent.log` | scalper (scanner_gated, ~1-min wake ticks) — 23 routing, **0 stale_scan**, **traded 1,495 decisions** |
| `.ignore/eval/2026/07/25/050624ae-.../01/logs/agent.log` | cont (scanner_gated, ~1–4 min ticks) — 19 routing, 32 stale_scan (partial), traded |
| `.ignore/eval/2026/07/25/REPORT.md` | Confirms scalper hybrid evaluator worked; rate-limit bottlenecks |
| `.ignore/eval/2026/07/29/REPORT.md` | 6 agents traded 1,187 fills on staging; strategy preset reviews functioning |
| `.ignore/eval/2026/08/01/REPORT.md` | 6 agents traded ~3,400+ on staging; wake system operational |
| `.ignore/eval/2026/08/03/a4803509-.../001/logs/agent.log` | thyper (scanner_gated, local dev, ~1-min tick) — **11 trades**, evaluator reached LLM |
| `.ignore/eval/2026/08/04/9444b6e1-.../01/logs/agent.log` | thyper (scanner_gated, staging, 15-min tick) — 0 stale_scan, 81 hard-limited |
| `.ignore/eval/2026/08/04/9444b6e1-.../03/redis/key-dump.txt` | Redis `agent:billing:notified` = hard_limited (explains 08/04 outcome) |

### Source code references

| File | Lines | Relevance |
|---|---|---|
| `apps/worker/src/hybrid-agent-evaluator.ts` | 13, 64, 210, 215–218 | `isTechnicalScanFresh()` (2× scanIntervalMs window); `stale_scan` abort |
| `apps/worker/src/agents/outbound-message-reader.ts` | 3, 25–26 | `OUTBOUND_READ_BLOCK_MS=1500`; `COUNT 10` per read |
| `apps/worker/src/agent.ts` | 1358, 1374, 1906–1907, 1962–1988, 2141, 2302, 2431, 2521–2539, 2781 | Outbound read, wake-driven tick scheduling, hybrid routing |
| `apps/worker/src/agent-wake-scheduler.ts` | 10–18, 40–73 | `getWakeRescheduleDelay`, `resolveNextTickDelay` (wake acceleration logic) |
| `apps/worker/src/complete-technical-scan.ts` | 158–273 | Scan completion, `onTechnicalScanComplete` forwarding, wake emission |
| `apps/worker/src/agents/instance-event-publisher.ts` | 93 | `emitTechnicalScanCompleted` |
| `apps/worker/src/runtime-composition.ts` | 2011–2021 | `agent.technical.scan_completed` ingestion → `recordTechnicalScan` |
| `apps/worker/src/swap-candidate-discovery.ts` | 80–120 | Swap scanner discovery → `scanner.swap_discovery_empty` when 0 tokens |
| `apps/worker/src/market-intelligence/coordinator.ts` | 200–240 | `refreshDiscovery` → `providerRegistry.discovery.discover({ networks })` |
| `packages/market-data/src/discovery.ts` | 120–230 | `discoverTokens` — network fan-out, antistaleness reorder, `slice(0, maxResults)` |
| `packages/market-data/src/discovery-seen-tracker.ts` | 44–70 | `applyAntiStaleness` — moves recently-seen tokens to end |
| `packages/market-data/src/provider-registry.ts` | 397–430 | `discovery.discover` — cache key, `discoverTokens` wiring |
| `config/default.yaml` | 353, 725–733 | `antistalenessCooldownHours: 4`; `marketIntelligence.networks: [solana, base]` |
| `config/staging.yaml` | 23 | `tickIntervalMs: 900000` (15 min) |
| `config/default.yaml` | 492–494 | `wake.minIntervalMs: 15000`, `wake.pollMs: 1000` |

## Investigation Guide (for the investigating agent)

The root causes are now **confirmed** (see §Root Cause Hypothesis). The following are the specific code paths to examine to validate the fixes:

### Issue 1: Wake message consumed by the wrong consumer group (race condition)

**Confirmed mechanism:** The `agent.wake` message is published to the same `agent:outbound:<id>` stream that has two consumer groups. The `agent-market-wake` group (polled continuously) and the `agent-runtime` group (drained once per tick) race to consume the same `agent.wake` message. When the wake group wins, the runtime group never sees it → `currentMarketWake` is null when the tick runs → "timer tick without wake signal".

**To validate the fix:**
- Inspect `pollWakeSignals()` (`agent.ts:1390`) and `readOutboundMessages()` (`agent.ts:1358`) — both read from the same stream but different groups.
- Confirm the wake message is only delivered to one group (Redis Streams semantics).
- The fix should ensure the `agent.wake` message is ALSO delivered to the `agent-runtime` group (e.g., publish to a separate stream, or have the wake group forward the wake context to the runtime state), so `currentMarketWake` is set when the tick runs.

### Issue 2: t1inch base discovery suppressed by antistaleness

**Confirmed mechanism:** The discovery snapshot contains 0 base tokens because the antistaleness cooldown (4h) marks all base tokens as "stale" (recently seen), and they get sliced off when 47 solana tokens fill the 50-slot `maxResults` limit.

**To validate the fix:**
- Inspect `discoverTokens()` (`packages/market-data/src/discovery.ts:210`) — `sliced = reordered.slice(0, maxResults)` after `applyAntiStaleness` reorders stale tokens to the end.
- Inspect `RedisDiscoverySeenTracker.applyAntiStaleness()` (`packages/market-data/src/discovery-seen-tracker.ts:44-70`).
- The fix should ensure base tokens are not permanently suppressed (e.g., per-network maxResults, or not applying antistaleness to swap-scan discovery).

## Impact

- **Two of three trading agents are non-functional** — they cannot make any trading decisions.
- The scanner is producing real signals that never reach the LLM, wasting the scanner's work.
- This is a **blocking bug** for scanner-gated agent trading on staging.

## Notes

- **Not a recent code regression.** The scanner/wake/hybrid-evaluator code is unchanged across all runs (the `v0.0.42 → v0.0.43` diff touches only billing/creem files). The scanner-gated path has traded successfully many times before.
- **The 08/04 staging run masked the issue** because the account was hard-limited (low message volume → no lag).
- **Birdeye/Binance 400s** on candle fetch (HYPE, CASHCAT, FARTCOIN) are a separate, lower-severity issue — the stack trace points to `fetchBinanceCandles`, not Birdeye.
- **No security breaches, data leaks, or unauthorized access** were detected.
